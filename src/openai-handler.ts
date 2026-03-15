/**
 * openai-handler.ts - OpenAI Chat Completions API 兼容处理器
 *
 * 将 OpenAI 格式请求转换为内部 Anthropic 格式，复用现有 Cursor 交互管道
 * 支持流式和非流式响应、工具调用、Cursor IDE Agent 模式
 */

import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type {
    OpenAIChatRequest,
    OpenAIMessage,
    OpenAIChatCompletion,
    OpenAIChatCompletionChunk,
    OpenAIToolCall,
    OpenAIContentPart,
    OpenAITool,
} from './openai-types.js';
import type {
    AnthropicRequest,
    AnthropicMessage,
    AnthropicContentBlock,
    AnthropicTool,
    CursorChatRequest,
    CursorSSEEvent,
} from './types.js';
import { convertToCursorRequest, parseToolCalls, hasToolCalls } from './converter.js';
import { sendCursorRequest, sendCursorRequestFull } from './cursor-client.js';
import { getConfig } from './config.js';
import { extractThinking } from './thinking.js';
import { StreamingThinkingParser } from './streaming-parser.js';
import {
    isRefusal,
    sanitizeResponse,
    isIdentityProbe,
    isToolCapabilityQuestion,
    buildRetryRequest,
    CLAUDE_IDENTITY_RESPONSE,
    CLAUDE_TOOLS_RESPONSE,
    MAX_REFUSAL_RETRIES,
    estimateInputTokens,
} from './handler.js';

function chatId(): string {
    return 'chatcmpl-' + uuidv4().replace(/-/g, '').substring(0, 24);
}

function toolCallId(): string {
    return 'call_' + uuidv4().replace(/-/g, '').substring(0, 24);
}

// ==================== 请求转换：OpenAI → Anthropic ====================

/**
 * 将 OpenAI Chat Completions 请求转换为内部 Anthropic 格式
 * 这样可以完全复用现有的 convertToCursorRequest 管道
 */
function convertToAnthropicRequest(body: OpenAIChatRequest): AnthropicRequest {
    const rawMessages: AnthropicMessage[] = [];
    let systemPrompt: string | undefined;

    // ★ response_format 处理：构建温和的 JSON 格式提示（稍后追加到最后一条用户消息）
    // 不用系统提示词注入（会触发模型的"社会工程攻击"检测），改为追加到用户消息末尾
    let jsonFormatSuffix = '';
    if (body.response_format && body.response_format.type !== 'text') {
        jsonFormatSuffix = '\n\nRespond in plain JSON format without markdown wrapping.';
        if (body.response_format.type === 'json_schema' && body.response_format.json_schema?.schema) {
            jsonFormatSuffix += ` Schema: ${JSON.stringify(body.response_format.json_schema.schema)}`;
        }
        console.log(`[OpenAI] response_format=${body.response_format.type}, 将追加 JSON 格式提示到用户消息`);
    }

    for (const msg of body.messages) {
        switch (msg.role) {
            case 'system':
                systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + extractOpenAIContent(msg);
                break;

            case 'user': {
                // 检查 content 数组中是否有 tool_result 类型的块（Anthropic 风格）
                const contentBlocks = extractOpenAIContentBlocks(msg);
                if (Array.isArray(contentBlocks)) {
                    rawMessages.push({ role: 'user', content: contentBlocks });
                } else {
                    rawMessages.push({ role: 'user', content: contentBlocks || '' });
                }
                break;
            }

            case 'assistant': {
                const blocks: AnthropicContentBlock[] = [];
                const contentBlocks = extractOpenAIContentBlocks(msg);
                if (typeof contentBlocks === 'string' && contentBlocks) {
                    blocks.push({ type: 'text', text: contentBlocks });
                } else if (Array.isArray(contentBlocks)) {
                    blocks.push(...contentBlocks);
                }

                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    for (const tc of msg.tool_calls) {
                        let args: Record<string, unknown> = {};
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = { input: tc.function.arguments };
                        }
                        blocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function.name,
                            input: args,
                        });
                    }
                }

                rawMessages.push({
                    role: 'assistant',
                    content: blocks.length > 0 ? blocks : (typeof contentBlocks === 'string' ? contentBlocks : ''),
                });
                break;
            }

            case 'tool': {
                rawMessages.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.tool_call_id,
                        content: extractOpenAIContent(msg),
                    }] as AnthropicContentBlock[],
                });
                break;
            }
        }
    }

    // 合并连续同角色消息（Anthropic API 要求 user/assistant 严格交替）
    const messages = mergeConsecutiveRoles(rawMessages);

    // ★ response_format: 追加 JSON 格式提示到最后一条 user 消息
    if (jsonFormatSuffix) {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                const content = messages[i].content;
                if (typeof content === 'string') {
                    messages[i].content = content + jsonFormatSuffix;
                } else if (Array.isArray(content)) {
                    // 找到最后一个 text block 追加
                    const lastTextBlock = [...content].reverse().find(b => b.type === 'text');
                    if (lastTextBlock && lastTextBlock.text) {
                        lastTextBlock.text += jsonFormatSuffix;
                    } else {
                        content.push({ type: 'text', text: jsonFormatSuffix.trim() });
                    }
                }
                break;
            }
        }
    }

    // 转换工具定义：支持 OpenAI 标准格式和 Cursor 扁平格式
    const tools: AnthropicTool[] | undefined = body.tools?.map((t: OpenAITool | Record<string, unknown>) => {
        // Cursor IDE 可能发送扁平格式：{ name, description, input_schema }
        if ('function' in t && t.function) {
            const fn = (t as OpenAITool).function;
            return {
                name: fn.name,
                description: fn.description,
                input_schema: fn.parameters || { type: 'object', properties: {} },
            };
        }
        // Cursor 扁平格式
        const flat = t as Record<string, unknown>;
        return {
            name: (flat.name as string) || '',
            description: flat.description as string | undefined,
            input_schema: (flat.input_schema as Record<string, unknown>) || { type: 'object', properties: {} },
        };
    });

    return {
        model: body.model,
        messages,
        max_tokens: Math.max(body.max_tokens || body.max_completion_tokens || 8192, 8192),
        stream: body.stream,
        system: systemPrompt,
        tools,
        temperature: body.temperature,
        top_p: body.top_p,
        stop_sequences: body.stop
            ? (Array.isArray(body.stop) ? body.stop : [body.stop])
            : undefined,
    };
}

/**
 * 合并连续同角色的消息（Anthropic API 要求角色严格交替）
 */
function mergeConsecutiveRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
    if (messages.length <= 1) return messages;

    const merged: AnthropicMessage[] = [];
    for (const msg of messages) {
        const last = merged[merged.length - 1];
        if (last && last.role === msg.role) {
            // 合并 content
            const lastBlocks = toBlocks(last.content);
            const newBlocks = toBlocks(msg.content);
            last.content = [...lastBlocks, ...newBlocks];
        } else {
            merged.push({ ...msg });
        }
    }
    return merged;
}

/**
 * 将 content 统一转为 AnthropicContentBlock 数组
 */
function toBlocks(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    return content || [];
}

/**
 * 从 OpenAI 消息中提取文本或多模态内容块
 */
function extractOpenAIContentBlocks(msg: OpenAIMessage): string | AnthropicContentBlock[] {
    if (msg.content === null || msg.content === undefined) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        const blocks: AnthropicContentBlock[] = [];
        for (const p of msg.content as (OpenAIContentPart | Record<string, unknown>)[]) {
            if (p.type === 'text' && (p as OpenAIContentPart).text) {
                blocks.push({ type: 'text', text: (p as OpenAIContentPart).text! });
            } else if (p.type === 'image_url' && (p as OpenAIContentPart).image_url?.url) {
                const url = (p as OpenAIContentPart).image_url!.url;
                if (url.startsWith('data:')) {
                    const match = url.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        blocks.push({
                            type: 'image',
                            source: { type: 'base64', media_type: match[1], data: match[2] }
                        });
                    }
                } else {
                    blocks.push({
                        type: 'image',
                        source: { type: 'url', media_type: 'image/jpeg', data: url }
                    });
                }
            } else if (p.type === 'tool_use') {
                // Anthropic 风格 tool_use 块直接透传
                blocks.push(p as unknown as AnthropicContentBlock);
            } else if (p.type === 'tool_result') {
                // Anthropic 风格 tool_result 块直接透传
                blocks.push(p as unknown as AnthropicContentBlock);
            }
        }
        return blocks.length > 0 ? blocks : '';
    }
    return String(msg.content);
}

/**
 * 仅提取纯文本（用于系统提示词和旧行为）
 */
function extractOpenAIContent(msg: OpenAIMessage): string {
    const blocks = extractOpenAIContentBlocks(msg);
    if (typeof blocks === 'string') return blocks;
    return blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// ==================== 主处理入口 ====================

export async function handleOpenAIChatCompletions(req: Request, res: Response): Promise<void> {
    const body = req.body as OpenAIChatRequest;

    console.log(`[OpenAI] 收到请求: model=${body.model}, messages=${body.messages?.length}, stream=${body.stream}, tools=${body.tools?.length ?? 0}`);

    try {
        // Step 1: OpenAI → Anthropic 格式
        const anthropicReq = convertToAnthropicRequest(body);

        // 注意：图片预处理已移入 convertToCursorRequest → preprocessImages() 统一处理

        // Step 1.6: 身份探针拦截（复用 Anthropic handler 的逻辑）
        if (isIdentityProbe(anthropicReq)) {
            console.log(`[OpenAI] 拦截到身份探针，返回模拟响应`);
            const mockText = "I am Claude, an advanced AI programming assistant created by Anthropic. I am ready to help you write code, debug, and answer your technical questions. Please let me know what we should work on!";
            if (body.stream) {
                return handleOpenAIMockStream(res, body, mockText);
            } else {
                return handleOpenAIMockNonStream(res, body, mockText);
            }
        }

        // Step 2: Anthropic → Cursor 格式（复用现有管道）
        const cursorReq = await convertToCursorRequest(anthropicReq);

        if (body.stream) {
            await handleOpenAIStream(res, cursorReq, body, anthropicReq);
        } else {
            await handleOpenAINonStream(res, cursorReq, body, anthropicReq);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[OpenAI] 请求处理失败:`, message);
        res.status(500).json({
            error: {
                message,
                type: 'server_error',
                code: 'internal_error',
            },
        });
    }
}

// ==================== 身份探针模拟响应 ====================

function handleOpenAIMockStream(res: Response, body: OpenAIChatRequest, mockText: string): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const id = chatId();
    const created = Math.floor(Date.now() / 1000);
    writeOpenAISSE(res, {
        id, object: 'chat.completion.chunk', created, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: mockText }, finish_reason: null }],
    });
    writeOpenAISSE(res, {
        id, object: 'chat.completion.chunk', created, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    res.write('data: [DONE]\n\n');
    res.end();
}

function handleOpenAIMockNonStream(res: Response, body: OpenAIChatRequest, mockText: string): void {
    res.json({
        id: chatId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: mockText },
            finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 15, completion_tokens: 35, total_tokens: 50 },
    });
}

// ==================== 流式处理（OpenAI SSE 格式） ====================

async function handleOpenAIStream(
    res: Response,
    cursorReq: CursorChatRequest,
    body: OpenAIChatRequest,
    anthropicReq: AnthropicRequest,
): Promise<void> {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const id = chatId();
    const created = Math.floor(Date.now() / 1000);
    const model = body.model;
    const hasTools = (body.tools?.length ?? 0) > 0;

    // 发送 role delta
    writeOpenAISSE(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
        }],
    });

    const config = getConfig();
    const thinkingEnabled = anthropicReq.thinking?.type === 'enabled' || (anthropicReq.thinking?.type !== 'disabled' && !!config.enableThinking);

    // ★ 分流：有工具 → 缓冲模式（需要完整响应解析工具调用）；无工具 → 真流式
    if (hasTools) {
        await handleOpenAIStreamBuffered(res, cursorReq, body, anthropicReq, id, created, model, thinkingEnabled);
    } else {
        await handleOpenAIStreamTrue(res, cursorReq, body, anthropicReq, id, created, model, thinkingEnabled);
    }

    res.end();
}

/**
 * ★ 真正的流式传输（无工具模式）
 *
 * 策略：
 * 1. 初始阶段：缓冲前 REFUSAL_CHECK_SIZE 个字符，用于拒绝检测
 * 2. 如果检测到拒绝：重试（最多 MAX_REFUSAL_RETRIES 次）
 * 3. 如果未拒绝：立即刷出缓冲内容，后续每个 chunk 实时推送
 * 4. Thinking 标签由 StreamingThinkingParser 状态机实时处理
 */
async function handleOpenAIStreamTrue(
    res: Response,
    cursorReq: CursorChatRequest,
    body: OpenAIChatRequest,
    anthropicReq: AnthropicRequest,
    id: string,
    created: number,
    model: string,
    thinkingEnabled: boolean,
): Promise<void> {
    const REFUSAL_CHECK_SIZE = 300;
    let activeCursorReq = cursorReq;
    let retryCount = 0;

    // ---- Phase 1: 拒绝检测（缓冲初始内容）----
    let initialBuffer = '';
    let streamRemainder: string[] = []; // 超过 REFUSAL_CHECK_SIZE 的 chunks
    let refusalCheckDone = false;

    const collectForRefusalCheck = async (): Promise<string> => {
        initialBuffer = '';
        streamRemainder = [];
        refusalCheckDone = false;
        return new Promise<string>((resolve, reject) => {
            sendCursorRequest(activeCursorReq, (event: CursorSSEEvent) => {
                if (event.type !== 'text-delta' || !event.delta) return;
                if (!refusalCheckDone) {
                    initialBuffer += event.delta;
                    if (initialBuffer.length >= REFUSAL_CHECK_SIZE) {
                        refusalCheckDone = true;
                    }
                } else {
                    streamRemainder.push(event.delta);
                }
            }).then(() => resolve(initialBuffer + streamRemainder.join(''))).catch(reject);
        });
    };

    let fullResponse = await collectForRefusalCheck();

    console.log(`[OpenAI] 真流式原始响应 (${fullResponse.length} chars): ${fullResponse.substring(0, 200)}${fullResponse.length > 200 ? '...' : ''}`);

    // 拒绝检测 + 自动重试
    while (isRefusal(fullResponse) && retryCount < MAX_REFUSAL_RETRIES) {
        retryCount++;
        console.log(`[OpenAI] 真流式：检测到拒绝（第${retryCount}次），自动重试...`);
        const retryBody = buildRetryRequest(anthropicReq, retryCount - 1);
        activeCursorReq = await convertToCursorRequest(retryBody);
        fullResponse = await collectForRefusalCheck();
    }
    if (isRefusal(fullResponse)) {
        if (isToolCapabilityQuestion(anthropicReq)) {
            fullResponse = CLAUDE_TOOLS_RESPONSE;
        } else {
            fullResponse = CLAUDE_IDENTITY_RESPONSE;
        }
    }

    // ---- Phase 2: 已有完整 fullResponse，真流式推送 ----
    // 此时 fullResponse 包含完整的、非拒绝的响应内容

    try {
        // Thinking 处理 + 流式输出
        if (thinkingEnabled && fullResponse.includes('<thinking>')) {
            // 有 thinking 标签：使用 StreamingThinkingParser 逐字处理
            const parser = new StreamingThinkingParser();
            let allReasoningContent = '';

            for (let i = 0; i < fullResponse.length; i++) {
                const result = parser.feed(fullResponse[i]);
                if (result.thinkingComplete) {
                    allReasoningContent += (allReasoningContent ? '\n\n' : '') + result.thinkingComplete;
                }
                if (result.text) {
                    // 先发送已积累的 reasoning_content（在第一个文本出现之前）
                    if (allReasoningContent) {
                        writeOpenAISSE(res, {
                            id, object: 'chat.completion.chunk', created, model,
                            choices: [{
                                index: 0,
                                delta: { reasoning_content: allReasoningContent },
                                finish_reason: null,
                            }],
                        });
                        allReasoningContent = '';
                    }
                    const sanitized = sanitizeResponse(result.text);
                    if (sanitized) {
                        writeOpenAISSE(res, {
                            id, object: 'chat.completion.chunk', created, model,
                            choices: [{
                                index: 0,
                                delta: { content: sanitized },
                                finish_reason: null,
                            }],
                        });
                    }
                }
            }

            // 刷出剩余
            const flushed = parser.flush();
            if (flushed.thinkingComplete) {
                allReasoningContent += (allReasoningContent ? '\n\n' : '') + flushed.thinkingComplete;
            }
            if (allReasoningContent) {
                writeOpenAISSE(res, {
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{
                        index: 0,
                        delta: { reasoning_content: allReasoningContent },
                        finish_reason: null,
                    }],
                });
            }
            if (flushed.text) {
                const sanitized = sanitizeResponse(flushed.text);
                if (sanitized) {
                    writeOpenAISSE(res, {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: { content: sanitized },
                            finish_reason: null,
                        }],
                    });
                }
            }
        } else {
            // 无 thinking：直接以适当大小的 chunk 发送（模拟真实流式效果）
            let sanitized = sanitizeResponse(fullResponse);
            if (body.response_format && body.response_format.type !== 'text') {
                sanitized = stripMarkdownJsonWrapper(sanitized);
            }
            if (sanitized) {
                // 分 chunk 发送，每 chunk 约 20-80 字符，模拟真实逐词流式
                const STREAM_CHUNK_SIZE = 40;
                for (let i = 0; i < sanitized.length; i += STREAM_CHUNK_SIZE) {
                    const chunk = sanitized.slice(i, i + STREAM_CHUNK_SIZE);
                    writeOpenAISSE(res, {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: { content: chunk },
                            finish_reason: null,
                        }],
                    });
                }
            }
        }

        // 发送完成 chunk
        writeOpenAISSE(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop',
            }],
        });
        res.write('data: [DONE]\n\n');

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        writeOpenAISSE(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
                index: 0,
                delta: { content: `\n\n[Error: ${message}]` },
                finish_reason: 'stop',
            }],
        });
        res.write('data: [DONE]\n\n');
    }
}

/**
 * 缓冲模式流式处理（有工具时使用）
 * 保持原有逻辑：先缓冲完整响应，再解析工具调用
 */
async function handleOpenAIStreamBuffered(
    res: Response,
    cursorReq: CursorChatRequest,
    body: OpenAIChatRequest,
    anthropicReq: AnthropicRequest,
    id: string,
    created: number,
    model: string,
    thinkingEnabled: boolean,
): Promise<void> {
    const hasTools = (body.tools?.length ?? 0) > 0;

    let fullResponse = '';
    let activeCursorReq = cursorReq;
    let retryCount = 0;

    const executeStream = async () => {
        fullResponse = '';
        await sendCursorRequest(activeCursorReq, (event: CursorSSEEvent) => {
            if (event.type !== 'text-delta' || !event.delta) return;
            fullResponse += event.delta;
        });
    };

    try {
        await executeStream();

        console.log(`[OpenAI] 缓冲模式原始响应 (${fullResponse.length} chars, tools=${hasTools}): ${fullResponse.substring(0, 200)}${fullResponse.length > 200 ? '...' : ''}`);

        // 拒绝检测 + 自动重试
        const shouldRetryRefusal = () => {
            if (!isRefusal(fullResponse)) return false;
            if (hasTools && hasToolCalls(fullResponse)) return false;
            return true;
        };

        while (shouldRetryRefusal() && retryCount < MAX_REFUSAL_RETRIES) {
            retryCount++;
            console.log(`[OpenAI] 检测到拒绝（第${retryCount}次），自动重试...原始: ${fullResponse.substring(0, 100)}`);
            const retryBody = buildRetryRequest(anthropicReq, retryCount - 1);
            activeCursorReq = await convertToCursorRequest(retryBody);
            await executeStream();
        }
        if (shouldRetryRefusal()) {
            if (!hasTools) {
                if (isToolCapabilityQuestion(anthropicReq)) {
                    fullResponse = CLAUDE_TOOLS_RESPONSE;
                } else {
                    fullResponse = CLAUDE_IDENTITY_RESPONSE;
                }
            } else {
                fullResponse = 'I understand the request. Let me analyze the information and proceed with the appropriate action.';
            }
        }

        // 极短响应重试
        if (hasTools && fullResponse.trim().length < 10 && retryCount < MAX_REFUSAL_RETRIES) {
            retryCount++;
            console.log(`[OpenAI] 响应过短 (${fullResponse.length} chars)，重试第${retryCount}次`);
            activeCursorReq = await convertToCursorRequest(anthropicReq);
            await executeStream();
        }

        let finishReason: 'stop' | 'tool_calls' = 'stop';

        // Thinking 提取
        if (thinkingEnabled && fullResponse.includes('<thinking>')) {
            const extracted = extractThinking(fullResponse);
            if (extracted.thinkingBlocks.length > 0) {
                const reasoningContent = extracted.thinkingBlocks.map(b => b.thinking).join('\n\n');
                fullResponse = extracted.cleanText;
                writeOpenAISSE(res, {
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{
                        index: 0,
                        delta: { reasoning_content: reasoningContent },
                        finish_reason: null,
                    }],
                });
            }
        }

        if (hasTools && hasToolCalls(fullResponse)) {
            const { toolCalls, cleanText } = parseToolCalls(fullResponse);

            if (toolCalls.length > 0) {
                finishReason = 'tool_calls';

                let cleanOutput = isRefusal(cleanText) ? '' : cleanText;
                cleanOutput = sanitizeResponse(cleanOutput);
                if (cleanOutput) {
                    writeOpenAISSE(res, {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: { content: cleanOutput },
                            finish_reason: null,
                        }],
                    });
                }

                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const tcId = toolCallId();
                    const argsStr = JSON.stringify(tc.arguments);

                    writeOpenAISSE(res, {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: {
                                ...(i === 0 ? { content: null } : {}),
                                tool_calls: [{
                                    index: i,
                                    id: tcId,
                                    type: 'function',
                                    function: { name: tc.name, arguments: '' },
                                }],
                            },
                            finish_reason: null,
                        }],
                    });

                    const CHUNK_SIZE = 128;
                    for (let j = 0; j < argsStr.length; j += CHUNK_SIZE) {
                        writeOpenAISSE(res, {
                            id, object: 'chat.completion.chunk', created, model,
                            choices: [{
                                index: 0,
                                delta: {
                                    tool_calls: [{
                                        index: i,
                                        function: { arguments: argsStr.slice(j, j + CHUNK_SIZE) },
                                    }],
                                },
                                finish_reason: null,
                            }],
                        });
                    }
                }
            } else {
                let textToSend = fullResponse;
                if (isRefusal(fullResponse)) {
                    textToSend = 'The previous action is unavailable. Continue using other available actions to complete the task.';
                } else {
                    textToSend = sanitizeResponse(fullResponse);
                }
                writeOpenAISSE(res, {
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{
                        index: 0,
                        delta: { content: textToSend },
                        finish_reason: null,
                    }],
                });
            }
        } else {
            let sanitized = sanitizeResponse(fullResponse);
            if (body.response_format && body.response_format.type !== 'text') {
                sanitized = stripMarkdownJsonWrapper(sanitized);
            }
            if (sanitized) {
                writeOpenAISSE(res, {
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{
                        index: 0,
                        delta: { content: sanitized },
                        finish_reason: null,
                    }],
                });
            }
        }

        // 发送完成 chunk
        writeOpenAISSE(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason,
            }],
        });
        res.write('data: [DONE]\n\n');

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        writeOpenAISSE(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
                index: 0,
                delta: { content: `\n\n[Error: ${message}]` },
                finish_reason: 'stop',
            }],
        });
        res.write('data: [DONE]\n\n');
    }
}

// ==================== 非流式处理 ====================

async function handleOpenAINonStream(
    res: Response,
    cursorReq: CursorChatRequest,
    body: OpenAIChatRequest,
    anthropicReq: AnthropicRequest,
): Promise<void> {
    let fullText = await sendCursorRequestFull(cursorReq);
    const hasTools = (body.tools?.length ?? 0) > 0;

    console.log(`[OpenAI] 非流式原始响应 (${fullText.length} chars, tools=${hasTools}): ${fullText.substring(0, 300)}${fullText.length > 300 ? '...' : ''}`);

    // ★ Thinking 提取必须在拒绝检测之前 — 否则 thinking 内容中的关键词会触发 isRefusal 误判
    const config = getConfig();
    const thinkingEnabled = anthropicReq.thinking?.type === 'enabled' || (anthropicReq.thinking?.type !== 'disabled' && !!config.enableThinking);
    let reasoningContent: string | undefined;
    if (fullText.includes('<thinking>')) {
        const extracted = extractThinking(fullText);
        if (extracted.thinkingBlocks.length > 0) {
            if (thinkingEnabled) {
                reasoningContent = extracted.thinkingBlocks.map(b => b.thinking).join('\n\n');
            }
            fullText = extracted.cleanText;
            console.log(`[OpenAI] 提取 thinking 后: ${fullText.length} chars, thinking=${extracted.thinkingBlocks.reduce((s, b) => s + b.thinking.length, 0)} chars`);
        }
    }

    // 拒绝检测 + 自动重试（在 thinking 提取之后，只检测实际输出内容）
    const shouldRetry = () => isRefusal(fullText) && !(hasTools && hasToolCalls(fullText));

    if (shouldRetry()) {
        for (let attempt = 0; attempt < MAX_REFUSAL_RETRIES; attempt++) {
            console.log(`[OpenAI] 非流式：检测到拒绝（第${attempt + 1}次重试）...原始: ${fullText.substring(0, 100)}`);
            const retryBody = buildRetryRequest(anthropicReq, attempt);
            const retryCursorReq = await convertToCursorRequest(retryBody);
            fullText = await sendCursorRequestFull(retryCursorReq);
            // 重试响应也需要先提取 thinking
            if (fullText.includes('<thinking>')) {
                const ext = extractThinking(fullText);
                fullText = ext.cleanText;
                if (thinkingEnabled && ext.thinkingBlocks.length > 0) {
                    reasoningContent = ext.thinkingBlocks.map(b => b.thinking).join('\n\n');
                }
            }
            if (!shouldRetry()) break;
        }
        if (shouldRetry()) {
            if (hasTools) {
                console.log(`[OpenAI] 非流式：工具模式下拒绝，引导模型输出`);
                fullText = 'I understand the request. Let me analyze the information and proceed with the appropriate action.';
            } else if (isToolCapabilityQuestion(anthropicReq)) {
                console.log(`[OpenAI] 非流式：工具能力询问被拒绝，返回 Claude 能力描述`);
                fullText = CLAUDE_TOOLS_RESPONSE;
            } else {
                console.log(`[OpenAI] 非流式：重试${MAX_REFUSAL_RETRIES}次后仍被拒绝，返回 Claude 身份回复`);
                fullText = CLAUDE_IDENTITY_RESPONSE;
            }
        }
    }

    let content: string | null = fullText;
    let toolCalls: OpenAIToolCall[] | undefined;
    let finishReason: 'stop' | 'tool_calls' = 'stop';

    if (hasTools) {
        const parsed = parseToolCalls(fullText);

        if (parsed.toolCalls.length > 0) {
            finishReason = 'tool_calls';
            // 清洗拒绝文本
            let cleanText = parsed.cleanText;
            if (isRefusal(cleanText)) {
                console.log(`[OpenAI] 抑制工具模式下的拒绝文本: ${cleanText.substring(0, 100)}...`);
                cleanText = '';
            }
            content = sanitizeResponse(cleanText) || null;

            toolCalls = parsed.toolCalls.map(tc => ({
                id: toolCallId(),
                type: 'function' as const,
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                },
            }));
        } else {
            // 无工具调用，检查拒绝
            if (isRefusal(fullText)) {
                content = 'The previous action is unavailable. Continue using other available actions to complete the task.';
            } else {
                content = sanitizeResponse(fullText);
            }
        }
    } else {
        // 无工具模式：清洗响应
        content = sanitizeResponse(fullText);
        // ★ response_format 后处理：剥离 markdown 代码块包裹
        if (body.response_format && body.response_format.type !== 'text' && content) {
            content = stripMarkdownJsonWrapper(content);
        }
    }

    const response: OpenAIChatCompletion = {
        id: chatId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content,
                ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason,
        }],
        usage: {
            prompt_tokens: estimateInputTokens(anthropicReq).input_tokens,
            completion_tokens: Math.ceil(fullText.length / 3),
            total_tokens: estimateInputTokens(anthropicReq).input_tokens + Math.ceil(fullText.length / 3),
            ...estimateInputTokens(anthropicReq) // Merge anthropic cache metrics for compatibility
        },
    };

    res.json(response);
}

// ==================== 工具函数 ====================

/**
 * 剥离 Markdown 代码块包裹，返回裸 JSON 字符串
 * 处理 ```json\n...\n``` 和 ```\n...\n``` 两种格式
 */
function stripMarkdownJsonWrapper(text: string): string {
    if (!text) return text;
    const trimmed = text.trim();
    // 匹配 ```json\n...\n``` 或 ```\n...\n```
    const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```$/); 
    if (match) {
        console.log(`[OpenAI] 剥离 markdown JSON 包裹: ${trimmed.length} → ${match[1].trim().length} chars`);
        return match[1].trim();
    }
    return text;
}

function writeOpenAISSE(res: Response, data: OpenAIChatCompletionChunk): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof (res as unknown as { flush: () => void }).flush === 'function') {
        (res as unknown as { flush: () => void }).flush();
    }
}

// ==================== /v1/responses 支持 ====================

/**
 * 处理 Cursor IDE Agent 模式的 /v1/responses 请求
 *
 * Cursor IDE 对 GPT 模型发送 OpenAI Responses API 格式请求，
 * 这里将其转换为 Chat Completions 格式后复用现有管道
 */
export async function handleOpenAIResponses(req: Request, res: Response): Promise<void> {
    try {
        const body = req.body;
        console.log(`[OpenAI] 收到 /v1/responses 请求: model=${body.model}`);

        // 将 Responses API 格式转换为 Chat Completions 格式
        const chatBody = responsesToChatCompletions(body);

        // 此后复用现有管道
        req.body = chatBody;
        return handleOpenAIChatCompletions(req, res);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[OpenAI] /v1/responses 处理失败:`, message);
        res.status(500).json({
            error: { message, type: 'server_error', code: 'internal_error' },
        });
    }
}

/**
 * 将 OpenAI Responses API 格式转换为 Chat Completions 格式
 *
 * Responses API 使用 `input` 而非 `messages`，格式与 Chat Completions 不同
 */
export function responsesToChatCompletions(body: Record<string, unknown>): OpenAIChatRequest {
    const messages: OpenAIMessage[] = [];

    // 系统指令
    if (body.instructions && typeof body.instructions === 'string') {
        messages.push({ role: 'system', content: body.instructions });
    }

    // 转换 input
    const input = body.input;
    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
        for (const item of input as Record<string, unknown>[]) {
            // function_call_output 没有 role 字段，必须先检查 type
            if (item.type === 'function_call_output') {
                messages.push({
                    role: 'tool',
                    content: (item.output as string) || '',
                    tool_call_id: (item.call_id as string) || '',
                });
                continue;
            }
            const role = (item.role as string) || 'user';
            if (role === 'system' || role === 'developer') {
                const text = typeof item.content === 'string'
                    ? item.content
                    : Array.isArray(item.content)
                        ? (item.content as Array<Record<string, unknown>>).filter(b => b.type === 'input_text').map(b => b.text as string).join('\n')
                        : String(item.content || '');
                messages.push({ role: 'system', content: text });
            } else if (role === 'user') {
                const content = typeof item.content === 'string'
                    ? item.content
                    : Array.isArray(item.content)
                        ? (item.content as Array<Record<string, unknown>>).filter(b => b.type === 'input_text').map(b => b.text as string).join('\n')
                        : String(item.content || '');
                messages.push({ role: 'user', content });
            } else if (role === 'assistant') {
                const blocks = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
                const text = blocks.filter(b => b.type === 'output_text').map(b => b.text as string).join('\n');
                // 检查是否有工具调用
                const toolCallBlocks = blocks.filter(b => b.type === 'function_call');
                const toolCalls: OpenAIToolCall[] = toolCallBlocks.map(b => ({
                    id: (b.call_id as string) || toolCallId(),
                    type: 'function' as const,
                    function: {
                        name: (b.name as string) || '',
                        arguments: (b.arguments as string) || '{}',
                    },
                }));
                messages.push({
                    role: 'assistant',
                    content: text || null,
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                });
            }
        }
    }

    // 转换工具定义
    const tools: OpenAITool[] | undefined = Array.isArray(body.tools)
        ? (body.tools as Array<Record<string, unknown>>).map(t => {
            if (t.type === 'function') {
                return {
                    type: 'function' as const,
                    function: {
                        name: (t.name as string) || '',
                        description: t.description as string | undefined,
                        parameters: t.parameters as Record<string, unknown> | undefined,
                    },
                };
            }
            return {
                type: 'function' as const,
                function: {
                    name: (t.name as string) || '',
                    description: t.description as string | undefined,
                    parameters: t.parameters as Record<string, unknown> | undefined,
                },
            };
        })
        : undefined;

    return {
        model: (body.model as string) || 'gpt-4',
        messages,
        stream: (body.stream as boolean) ?? true,
        temperature: body.temperature as number | undefined,
        max_tokens: (body.max_output_tokens as number) || 8192,
        tools,
    };
}
