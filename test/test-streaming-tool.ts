/**
 * test-streaming-tool.ts - 分析工具调用时的流式 chunk 结构
 *
 * 核心问题：现在有工具时 handleOpenAIStreamBuffered 缓冲全部再解析，丧失流式体验。
 * 此测试验证：能不能边收流边解析？文本先走、工具块局部缓冲后立即发出？
 *
 * 用法：npx tsx test/test-streaming-tool.ts
 */

import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { ProxyAgent } from 'undici';
import { v4 as uuidv4 } from 'uuid';

// ==================== 配置 ====================

function loadConfig() {
    const config = {
        cursorModel: 'anthropic/claude-sonnet-4.6',
        proxy: undefined as string | undefined,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        timeout: 60,
    };
    if (existsSync('config.yaml')) {
        try {
            const yaml = parseYaml(readFileSync('config.yaml', 'utf-8'));
            if (yaml.cursor_model) config.cursorModel = yaml.cursor_model;
            if (yaml.proxy) config.proxy = yaml.proxy;
            if (yaml.timeout) config.timeout = yaml.timeout;
            if (yaml.fingerprint?.user_agent) config.userAgent = yaml.fingerprint.user_agent;
        } catch {}
    }
    return config;
}

function shortId() { return uuidv4().replace(/-/g, '').substring(0, 16); }

const C = {
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
    bg_green: (s: string) => `\x1b[42m\x1b[30m${s}\x1b[0m`,
    bg_yellow: (s: string) => `\x1b[43m\x1b[30m${s}\x1b[0m`,
    bg_blue: (s: string) => `\x1b[44m\x1b[37m${s}\x1b[0m`,
};

// ==================== 流式收取 + 分析 ====================

interface StreamChunk {
    index: number;
    delta: string;
    elapsedMs: number;     // 距请求开始
    gapMs: number;         // 距上一个 chunk
    accumulated: string;   // 到此 chunk 为止的累积文本
}

/**
 * 流式发送请求，记录每个 chunk 的内容和时间
 */
async function streamWithAnalysis(config: ReturnType<typeof loadConfig>, messages: any[]): Promise<{
    chunks: StreamChunk[];
    fullResponse: string;
    totalMs: number;
}> {
    const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

    const req = {
        model: config.cursorModel,
        id: shortId(),
        messages,
        trigger: 'submit-message',
        max_tokens: 8192,
    };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'sec-ch-ua-platform': '"Windows"',
        'x-path': '/api/chat',
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'x-method': 'POST',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': config.userAgent,
        'x-is-human': '',
        'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15'
    };

    const fetchOptions: any = {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(config.timeout * 1000),
    };
    if (config.proxy) fetchOptions.dispatcher = new ProxyAgent(config.proxy);

    const resp = await fetch(CURSOR_CHAT_API, fetchOptions);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (!resp.body) throw new Error('no body');

    const startTime = Date.now();
    let lastChunkTime = startTime;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';
    const chunks: StreamChunk[] = [];
    let chunkIndex = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;

            try {
                const event = JSON.parse(data);
                if (event.type === 'text-delta' && event.delta) {
                    const now = Date.now();
                    fullResponse += event.delta;
                    chunks.push({
                        index: chunkIndex++,
                        delta: event.delta,
                        elapsedMs: now - startTime,
                        gapMs: now - lastChunkTime,
                        accumulated: fullResponse,
                    });
                    lastChunkTime = now;
                }
            } catch {}
        }
    }

    return { chunks, fullResponse, totalMs: Date.now() - startTime };
}

// ==================== 流式状态机模拟 ====================

/**
 * 模拟流式解析器：逐 chunk 处理，输出"可以流式转发"的事件
 *
 * 核心思想：
 * - 普通文本 → 立即转发（content delta）
 * - ```json action 开始 → 切换到缓冲模式（只缓冲工具 JSON）
 * - ``` 闭合 → 解析 JSON → 转为 tool_calls 发出
 */
type StreamEvent =
    | { type: 'content'; text: string; chunkIndex: number; elapsedMs: number }
    | { type: 'tool_start'; chunkIndex: number; elapsedMs: number }
    | { type: 'tool_complete'; name: string; args: Record<string, any>; chunkIndex: number; elapsedMs: number }
    | { type: 'error'; message: string; chunkIndex: number };

function simulateStreamParser(chunks: StreamChunk[]): StreamEvent[] {
    const events: StreamEvent[] = [];

    let state: 'text' | 'tool_buffer' = 'text';
    let accumulated = '';
    let textBuffer = '';
    let toolBuffer = '';

    for (const chunk of chunks) {
        accumulated += chunk.delta;

        if (state === 'text') {
            textBuffer += chunk.delta;

            // 检查是否出现了 ```json action 开头
            const markerMatch = textBuffer.match(/(```json\s*action\s*)/);
            if (markerMatch && markerMatch.index !== undefined) {
                // 把 marker 之前的文本先发出
                const beforeMarker = textBuffer.substring(0, markerMatch.index);
                if (beforeMarker.trim()) {
                    events.push({
                        type: 'content',
                        text: beforeMarker,
                        chunkIndex: chunk.index,
                        elapsedMs: chunk.elapsedMs,
                    });
                }
                // 切换到工具缓冲
                state = 'tool_buffer';
                toolBuffer = textBuffer.substring(markerMatch.index + markerMatch[0].length);
                textBuffer = '';
                events.push({ type: 'tool_start', chunkIndex: chunk.index, elapsedMs: chunk.elapsedMs });

            } else if (!textBuffer.includes('`')) {
                // 没有反引号嫌疑，安全转发
                if (textBuffer.trim()) {
                    events.push({
                        type: 'content',
                        text: textBuffer,
                        chunkIndex: chunk.index,
                        elapsedMs: chunk.elapsedMs,
                    });
                    textBuffer = '';
                }
            }
            // 如果有 ` 但不完整（可能是 ``` 的一部分），暂时不发，等下个 chunk

        } else if (state === 'tool_buffer') {
            toolBuffer += chunk.delta;

            // 检查闭合 ```
            const closeIdx = toolBuffer.indexOf('```');
            if (closeIdx >= 0) {
                const jsonContent = toolBuffer.substring(0, closeIdx).trim();
                try {
                    const parsed = JSON.parse(jsonContent);
                    events.push({
                        type: 'tool_complete',
                        name: parsed.tool || parsed.name || 'unknown',
                        args: parsed.parameters || parsed.arguments || {},
                        chunkIndex: chunk.index,
                        elapsedMs: chunk.elapsedMs,
                    });
                } catch (e) {
                    events.push({ type: 'error', message: `JSON 解析失败: ${(e as Error).message}`, chunkIndex: chunk.index });
                }

                // 闭合后面可能还有文本或另一个工具
                textBuffer = toolBuffer.substring(closeIdx + 3);
                toolBuffer = '';
                state = 'text';
            }
        }
    }

    // 刷出残余
    if (state === 'text' && textBuffer.trim()) {
        events.push({
            type: 'content',
            text: textBuffer,
            chunkIndex: chunks.length - 1,
            elapsedMs: chunks[chunks.length - 1]?.elapsedMs || 0,
        });
    }

    return events;
}

// ==================== 工具指令构建（简化版） ====================

const TOOLS = [
    { name: 'Read', params: '{file_path!: string, start_line?: integer, end_line?: integer}' },
    { name: 'Write', params: '{file_path!: string, content!: string}' },
    { name: 'Edit', params: '{file_path!: string, old_string!: string, new_string!: string}' },
    { name: 'Bash', params: '{command!: string}' },
    { name: 'LS', params: '{path!: string}' },
    { name: 'Grep', params: '{pattern!: string, path?: string}' },
    { name: 'attempt_completion', params: '{result!: string}' },
];

function buildMessages(userQuery: string) {
    const toolList = TOOLS.map(t => `- **${t.name}**\n  Params: ${t.params}`).join('\n');

    const systemAndTools = `You are Claude, a highly skilled software engineer.

====
SYSTEM INFORMATION
Operating System: macOS
Default Shell: zsh
Current Working Directory: /project

---

You are operating within an IDE environment with access to the following actions. To invoke an action, include it in your response using this structured format:

\`\`\`json action
{
  "tool": "ACTION_NAME",
  "parameters": {
    "param": "value"
  }
}
\`\`\`

Available actions:
${toolList}

When performing actions, always include the structured block. For independent actions, include multiple blocks. Keep explanatory text brief.`;

    return [
        { parts: [{ type: 'text', text: systemAndTools }], id: shortId(), role: 'user' },
        {
            parts: [{
                type: 'text',
                text: `Understood. I'll use the structured format for actions.\n\n\`\`\`json action\n${JSON.stringify({ tool: 'Read', parameters: { file_path: 'src/index.ts' } }, null, 2)}\n\`\`\``
            }],
            id: shortId(),
            role: 'assistant',
        },
        {
            parts: [{ type: 'text', text: `${userQuery}\n\nRespond with the appropriate action using the structured format.` }],
            id: shortId(),
            role: 'user',
        },
    ];
}

// ==================== 测试场景 ====================

const SCENARIOS = [
    {
        id: 'read_with_text',
        label: '文本 + 单工具调用（最常见场景）',
        query: 'Read the file /project/src/index.ts',
    },
    {
        id: 'write_long',
        label: '写文件（大量参数内容）',
        query: 'Create a new file /project/src/utils/logger.ts with a Logger class.',
    },
    {
        id: 'multi_tool',
        label: '多工具（文本 + 两个独立操作）',
        query: 'List files in /project/src using LS and also grep for "import" in /project using Grep.',
    },
];

// ==================== 主程序 ====================

async function main() {
    const config = loadConfig();

    console.log(C.bold('\n🔬 流式工具调用分析'));
    console.log(C.gray(`模型: ${config.cursorModel}\n`));
    console.log(C.gray('目标：验证能否边收流边解析工具调用（不需要缓冲全部）\n'));

    for (const scenario of SCENARIOS) {
        console.log(C.bold(`\n${'═'.repeat(65)}`));
        console.log(C.bold(`📡 ${scenario.label}`));
        console.log(C.gray(`Query: ${scenario.query}`));
        console.log(`${'═'.repeat(65)}\n`);

        const messages = buildMessages(scenario.query);
        const { chunks, fullResponse, totalMs } = await streamWithAnalysis(config, messages);

        console.log(C.gray(`  总 chunks: ${chunks.length}  总耗时: ${totalMs}ms  总长度: ${fullResponse.length} chars\n`));

        // === 展示流式时间线 ===
        console.log(C.bold('  📊 流式时间线:'));
        console.log(C.gray('  时间轴上每个 chunk 的内容类型：'));

        let preToolText = '';
        let inTool = false;
        let toolStartTime = 0;
        let firstContentTime = 0;

        for (const chunk of chunks) {
            const trimmed = chunk.delta.replace(/\n/g, '\\n');
            const preview = trimmed.length > 60 ? trimmed.substring(0, 60) + '...' : trimmed;

            // 判断当前 chunk 是什么内容
            const accum = chunk.accumulated;
            const hasToolStart = accum.includes('```json') && !accum.includes('```json action\n{');
            const isInToolBlock = accum.includes('```json action') && (accum.split('```').length % 2 === 0);

            if (!inTool && chunk.delta.includes('```json')) {
                inTool = true;
                toolStartTime = chunk.elapsedMs;
            }
            if (inTool && chunk.delta.includes('```') && !chunk.delta.includes('```json')) {
                inTool = false;
            }

            if (!firstContentTime && chunk.delta.trim()) firstContentTime = chunk.elapsedMs;

            const tag = inTool ? C.bg_yellow(' TOOL ') : C.bg_green(' TEXT ');
            console.log(`  ${C.gray(`${String(chunk.elapsedMs).padStart(5)}ms`)} ${tag} ${C.gray(preview)}`);
        }

        // === 模拟流式解析器 ===
        console.log(C.bold('\n  🔧 流式解析器模拟:'));

        const events = simulateStreamParser(chunks);

        let textEvents = 0;
        let toolEvents = 0;
        let firstTextEventTime = 0;
        let firstToolCompleteTime = 0;

        for (const event of events) {
            switch (event.type) {
                case 'content':
                    textEvents++;
                    if (!firstTextEventTime) firstTextEventTime = event.elapsedMs;
                    const textPreview = event.text.trim().replace(/\n/g, '\\n');
                    console.log(`  ${C.gray(`${String(event.elapsedMs).padStart(5)}ms`)} ${C.green('→ 转发 content:')} "${textPreview.substring(0, 50)}${textPreview.length > 50 ? '...' : ''}"`);
                    break;
                case 'tool_start':
                    console.log(`  ${C.gray(`${String(event.elapsedMs).padStart(5)}ms`)} ${C.yellow('⏳ 开始缓冲工具 JSON...')}`);
                    break;
                case 'tool_complete':
                    toolEvents++;
                    if (!firstToolCompleteTime) firstToolCompleteTime = event.elapsedMs;
                    const argsPreview = JSON.stringify(event.args).substring(0, 60);
                    console.log(`  ${C.gray(`${String(event.elapsedMs).padStart(5)}ms`)} ${C.magenta(`→ 发送 tool_call: ${event.name}(${argsPreview}...)`)}`);
                    break;
                case 'error':
                    console.log(`  ${C.red(`✗ ${event.message}`)}`);
                    break;
            }
        }

        // === 时间分析 ===
        console.log(C.bold('\n  ⏱️  时间分析:'));
        console.log(`  首个文本可转发: ${C.green(`${firstTextEventTime}ms`)}${firstTextEventTime > 0 ? '' : C.yellow(' (模型直接输出工具调用，无前置文本)')}`);
        console.log(`  工具调用完成:   ${C.yellow(`${firstToolCompleteTime}ms`)}`);
        console.log(`  总耗时:         ${C.gray(`${totalMs}ms`)}`);

        if (firstTextEventTime > 0 && firstToolCompleteTime > 0) {
            const textFirstPct = Math.round((firstTextEventTime / totalMs) * 100);
            const toolWaitMs = firstToolCompleteTime - firstTextEventTime;
            console.log(`\n  ${C.green(`✅ 文本在 ${textFirstPct}% 时就可以转发！`)}`);
            console.log(`  ${C.green(`✅ 工具 JSON 只需额外缓冲 ${toolWaitMs}ms`)}`);
            console.log(`  ${C.bold(`对比缓冲全部: 现在的方案要等 ${totalMs}ms 才开始发送，流式方案可以在 ${firstTextEventTime}ms 就开始！`)}`);
        } else if (firstToolCompleteTime > 0) {
            console.log(`\n  ${C.yellow('⚠️  模型直接输出工具调用（无前置文本），但工具 JSON 块也可以只局部缓冲')}`);
            console.log(`  ${C.bold(`对比缓冲全部: ${totalMs}ms → 流式方案 ${firstToolCompleteTime}ms`)}`);
        }

        console.log('\n' + C.gray('  原始输出预览:'));
        console.log(C.gray(`  ${fullResponse.substring(0, 200).replace(/\n/g, '\\n')}...`));

        await new Promise(r => setTimeout(r, 2000));
    }

    // === 总结 ===
    console.log(`\n${'═'.repeat(65)}`);
    console.log(C.bold('📋 结论'));
    console.log(`${'═'.repeat(65)}`);
    console.log(`
${C.bold('当前方案的问题:')}
  有工具时 → handleOpenAIStreamBuffered → 缓冲全部 → 用户等到最后才看到内容

${C.bold('流式方案（可行！）:')}
  1. 文本部分 → ${C.green('立即转发')}为 content delta（用户马上看到 AI 在说话）
  2. \`\`\`json action 开始 → ${C.yellow('局部缓冲')}（只缓冲这一个 JSON 块，几百 ms）
  3. \`\`\` 闭合 → ${C.magenta('解析并转发')} tool_calls chunk
  4. 如果后续还有文本或工具 → 回到步骤 1

${C.bold('实现方式:')}
  写一个 StreamingToolParser 状态机（类似已有的 StreamingThinkingParser）
  逐 delta 喂入，产出 content/tool_call 事件，实时转为 OpenAI SSE chunks
`);
}

main().catch(console.error);
