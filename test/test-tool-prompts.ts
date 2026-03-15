/**
 * test-tool-prompts.ts - 模拟 Claude Code 工具调用场景，直接打 Cursor API
 *
 * 测试工具模式下，模型能否正确输出 ```json action 格式的工具调用
 * 完整复刻 converter.ts 的构建流程：系统提示词 + 工具指令 + few-shot + 用户消息
 *
 * 用法：npx tsx test/test-tool-prompts.ts [轮数]
 */

import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { ProxyAgent } from 'undici';
import { v4 as uuidv4 } from 'uuid';

// ==================== 配置 ====================

interface TestConfig {
    cursorModel: string;
    proxy?: string;
    userAgent: string;
    timeout: number;
}

function loadConfig(): TestConfig {
    const config: TestConfig = {
        cursorModel: 'anthropic/claude-sonnet-4.6',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        timeout: 60,
    };
    if (existsSync('config.yaml')) {
        try {
            const raw = readFileSync('config.yaml', 'utf-8');
            const yaml = parseYaml(raw);
            if (yaml.cursor_model) config.cursorModel = yaml.cursor_model;
            if (yaml.proxy) config.proxy = yaml.proxy;
            if (yaml.timeout) config.timeout = yaml.timeout;
            if (yaml.fingerprint?.user_agent) config.userAgent = yaml.fingerprint.user_agent;
        } catch {}
    }
    return config;
}

// ==================== Cursor API ====================

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

function getChromeHeaders(config: TestConfig): Record<string, string> {
    return {
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
}

function shortId(): string {
    return uuidv4().replace(/-/g, '').substring(0, 16);
}

interface CursorMessage {
    parts: { type: string; text: string }[];
    id: string;
    role: string;
}

async function sendCursorChat(config: TestConfig, messages: CursorMessage[]): Promise<string> {
    const req = {
        model: config.cursorModel,
        id: shortId(),
        messages,
        trigger: 'submit-message',
        max_tokens: 8192,
    };

    const fetchOptions: any = {
        method: 'POST',
        headers: getChromeHeaders(config),
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(config.timeout * 1000),
    };

    if (config.proxy) {
        fetchOptions.dispatcher = new ProxyAgent(config.proxy);
    }

    const resp = await fetch(CURSOR_CHAT_API, fetchOptions);
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Cursor API 错误: HTTP ${resp.status} - ${body.substring(0, 200)}`);
    }
    if (!resp.body) throw new Error('无 body');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';

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
                if (event.type === 'text-delta' && event.delta) fullResponse += event.delta;
            } catch {}
        }
    }
    if (buffer.startsWith('data: ')) {
        try {
            const event = JSON.parse(buffer.slice(6).trim());
            if (event.type === 'text-delta' && event.delta) fullResponse += event.delta;
        } catch {}
    }
    return fullResponse;
}

// ==================== Claude Code 工具定义 ====================

interface ToolDef {
    name: string;
    description: string;
    input_schema: Record<string, any>;
}

const CLAUDE_CODE_TOOLS: ToolDef[] = [
    {
        name: 'Read',
        description: 'Reads a file from the local filesystem.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path to read' },
                start_line: { type: 'integer' },
                end_line: { type: 'integer' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'Write',
        description: 'Write a file to the local filesystem.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string' },
                content: { type: 'string' },
            },
            required: ['file_path', 'content'],
        },
    },
    {
        name: 'Edit',
        description: 'Edit a file by replacing text.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string' },
                old_string: { type: 'string' },
                new_string: { type: 'string' },
            },
            required: ['file_path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'Bash',
        description: 'Executes a bash command.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string' },
            },
            required: ['command'],
        },
    },
    {
        name: 'Glob',
        description: 'Fast file pattern matching.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string' },
                path: { type: 'string' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'Grep',
        description: 'Fast content search.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string' },
                path: { type: 'string' },
                include: { type: 'string' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'LS',
        description: 'Lists files and directories.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
            },
            required: ['path'],
        },
    },
    {
        name: 'attempt_completion',
        description: 'Present the final result when the task is done.',
        input_schema: {
            type: 'object',
            properties: {
                result: { type: 'string' },
            },
            required: ['result'],
        },
    },
    {
        name: 'ask_followup_question',
        description: 'Ask the user a follow-up question.',
        input_schema: {
            type: 'object',
            properties: {
                question: { type: 'string' },
            },
            required: ['question'],
        },
    },
];

// ==================== Claude Code 真实系统提示词（精简版） ====================

const CLAUDE_CODE_SYSTEM_PROMPT = `You are Claude, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.

====

TOOL USE

You have access to a set of tools that are executed upon the user's approval. You can use one tool per message, and will receive the result of that tool use in the user's response. You use tools step-by-step to accomplish a given task, with each tool use informed by the result of the previous tool use.

# Tool Use Formatting

Tool use is formatted using XML-style tags. The tool name is enclosed in opening and closing tags, and each parameter is similarly enclosed within its own set of tags. Here's the structure:

<tool_name>
<parameter1_name>value1</parameter1_name>
<parameter2_name>value2</parameter2_name>
</tool_name>

====

CAPABILITIES

- You can read and analyze code in any programming language
- You can suggest code changes and improvements  
- You have access to tools for reading, writing, and searching files
- You can execute shell commands via the Bash tool

====

RULES

- Always read files before modifying them
- Use appropriate error handling
- Follow existing code style and conventions
- Be thorough in your analysis

====

SYSTEM INFORMATION

Operating System: macOS
Default Shell: zsh
Home Directory: /Users/user
Current Working Directory: /project`;

// ==================== 复刻 converter.ts 的工具指令构建 ====================

const WELL_KNOWN_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'LS', 'attempt_completion', 'ask_followup_question']);

function compactSchema(schema: Record<string, any>): string {
    if (!schema?.properties) return '{}';
    const props = schema.properties as Record<string, Record<string, any>>;
    const required = new Set((schema.required as string[]) || []);
    const parts = Object.entries(props).map(([name, prop]) => {
        let type = (prop.type as string) || 'any';
        if (prop.enum) type = (prop.enum as string[]).join('|');
        if (type === 'array' && prop.items) type = `${(prop.items as any).type || 'any'}[]`;
        const req = required.has(name) ? '!' : '?';
        return `${name}${req}: ${type}`;
    });
    return `{${parts.join(', ')}}`;
}

function buildToolInstructions(tools: ToolDef[]): string {
    const toolList = tools.map(tool => {
        const schema = tool.input_schema ? compactSchema(tool.input_schema) : '{}';
        const isKnown = WELL_KNOWN_TOOLS.has(tool.name);
        const desc = isKnown ? '' : (tool.description || '').substring(0, 80);
        return desc ? `- **${tool.name}**: ${desc}\n  Params: ${schema}` : `- **${tool.name}**\n  Params: ${schema}`;
    }).join('\n');

    return `You are operating within an IDE environment with access to the following actions. To invoke an action, include it in your response using this structured format:

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

When performing actions, always include the structured block. For independent actions, include multiple blocks. For dependent actions (where one result feeds into the next), wait for each result. When you have nothing to execute or need to ask the user something, use the communication actions (attempt_completion, ask_followup_question). Do not run empty or meaningless commands.`;
}

/**
 * 构建完整的 Cursor 消息（复刻 converter.ts 的 hasTools 分支）
 */
function buildToolMessages(userQuery: string): CursorMessage[] {
    const messages: CursorMessage[] = [];

    // 1. 系统提示词 + 工具指令（合并到第一条 user 消息）
    const combinedSystem = CLAUDE_CODE_SYSTEM_PROMPT;
    let toolInstructions = buildToolInstructions(CLAUDE_CODE_TOOLS);
    toolInstructions = combinedSystem + '\n\n---\n\n' + toolInstructions;

    messages.push({
        parts: [{ type: 'text', text: toolInstructions }],
        id: shortId(),
        role: 'user',
    });

    // 2. few-shot 示例
    messages.push({
        parts: [{
            type: 'text',
            text: `Understood. I'll use the structured format for actions. Here's how I'll respond:\n\n\`\`\`json action\n${JSON.stringify({ tool: 'Read', parameters: { file_path: 'src/index.ts' } }, null, 2)}\n\`\`\``
        }],
        id: shortId(),
        role: 'assistant',
    });

    // 3. 用户消息 + 行为提示
    messages.push({
        parts: [{ type: 'text', text: `${userQuery}\n\nRespond with the appropriate action using the structured format.` }],
        id: shortId(),
        role: 'user',
    });

    return messages;
}

// ==================== 工具调用解析（复刻 converter.ts 的 parseToolCalls） ====================

interface ParsedToolCall {
    name: string;
    arguments: Record<string, any>;
}

function parseToolCalls(responseText: string): { toolCalls: ParsedToolCall[]; cleanText: string } {
    const toolCalls: ParsedToolCall[] = [];
    const blocksToRemove: Array<{ start: number; end: number }> = [];

    const openPattern = /```json(?:\s+action)?/g;
    let openMatch;

    while ((openMatch = openPattern.exec(responseText)) !== null) {
        const blockStart = openMatch.index;
        const contentStart = blockStart + openMatch[0].length;

        let pos = contentStart;
        let inJsonString = false;
        let closingPos = -1;

        while (pos < responseText.length - 2) {
            const char = responseText[pos];
            if (char === '"') {
                let bc = 0;
                for (let j = pos - 1; j >= contentStart && responseText[j] === '\\'; j--) bc++;
                if (bc % 2 === 0) inJsonString = !inJsonString;
                pos++;
                continue;
            }
            if (!inJsonString && responseText.substring(pos, pos + 3) === '```') {
                closingPos = pos;
                break;
            }
            pos++;
        }

        if (closingPos >= 0) {
            const jsonContent = responseText.substring(contentStart, closingPos).trim();
            try {
                const parsed = JSON.parse(jsonContent);
                if (parsed.tool || parsed.name) {
                    toolCalls.push({
                        name: parsed.tool || parsed.name,
                        arguments: parsed.parameters || parsed.arguments || parsed.input || {},
                    });
                    blocksToRemove.push({ start: blockStart, end: closingPos + 3 });
                }
            } catch {}
        }
    }

    let cleanText = responseText;
    for (let i = blocksToRemove.length - 1; i >= 0; i--) {
        cleanText = cleanText.substring(0, blocksToRemove[i].start) + cleanText.substring(blocksToRemove[i].end);
    }

    return { toolCalls, cleanText: cleanText.trim() };
}

function hasToolCalls(text: string): boolean {
    return /```json(?:\s+action)?[\s\S]*?```/.test(text);
}

// ==================== 测试用例 ====================

interface TestScenario {
    id: string;
    label: string;
    userQuery: string;
    expectTools: string[]; // 期望调用的工具名
    validate: (toolCalls: ParsedToolCall[], raw: string) => { pass: boolean; reason: string };
}

const SCENARIOS: TestScenario[] = [
    {
        id: 'read_file',
        label: '读取文件（最基本的工具调用）',
        userQuery: 'Read the file /project/src/index.ts to see its contents.',
        expectTools: ['Read'],
        validate: (tcs) => {
            if (tcs.length === 0) return { pass: false, reason: '未产生工具调用' };
            const read = tcs.find(t => t.name === 'Read');
            if (!read) return { pass: false, reason: `工具名不对: ${tcs.map(t => t.name).join(',')}` };
            if (!read.arguments.file_path) return { pass: false, reason: '缺少 file_path 参数' };
            return { pass: true, reason: 'OK' };
        },
    },
    {
        id: 'bash_command',
        label: '执行 Bash 命令',
        userQuery: 'Run `ls -la /project/src` to see what files are there.',
        expectTools: ['Bash'],
        validate: (tcs) => {
            if (tcs.length === 0) return { pass: false, reason: '未产生工具调用' };
            const bash = tcs.find(t => t.name === 'Bash');
            if (!bash) return { pass: false, reason: `工具名不对: ${tcs.map(t => t.name).join(',')}` };
            if (!bash.arguments.command) return { pass: false, reason: '缺少 command 参数' };
            return { pass: true, reason: 'OK' };
        },
    },
    {
        id: 'write_file',
        label: '写入文件（含多行内容）',
        userQuery: 'Create a new file /project/src/utils/logger.ts with a simple Logger class that has info() and error() methods.',
        expectTools: ['Write'],
        validate: (tcs) => {
            if (tcs.length === 0) return { pass: false, reason: '未产生工具调用' };
            const write = tcs.find(t => t.name === 'Write');
            if (!write) return { pass: false, reason: `未使用 Write: ${tcs.map(t => t.name).join(',')}` };
            if (!write.arguments.file_path) return { pass: false, reason: '缺少 file_path' };
            if (!write.arguments.content) return { pass: false, reason: '缺少 content' };
            if (write.arguments.content.length < 30) return { pass: false, reason: `content 太短 (${write.arguments.content.length} chars)` };
            return { pass: true, reason: 'OK' };
        },
    },
    {
        id: 'multi_tool',
        label: '多工具并发（独立操作）',
        userQuery: 'List the files in /project/src using LS, and also search for "import" in /project/src using Grep. These are independent operations so include both action blocks.',
        expectTools: ['LS', 'Grep'],
        validate: (tcs) => {
            if (tcs.length < 2) return { pass: false, reason: `期望 ≥2 个工具调用，实际 ${tcs.length}` };
            const hasLS = tcs.some(t => t.name === 'LS');
            const hasGrep = tcs.some(t => t.name === 'Grep');
            if (!hasLS && !hasGrep) return { pass: false, reason: `未使用 LS 或 Grep: ${tcs.map(t => t.name).join(',')}` };
            return { pass: true, reason: `调用了 ${tcs.map(t => t.name).join(' + ')}` };
        },
    },
    {
        id: 'completion',
        label: 'attempt_completion 完成任务',
        userQuery: 'The task is already done. Just call attempt_completion with result "All tasks completed successfully."',
        expectTools: ['attempt_completion'],
        validate: (tcs) => {
            if (tcs.length === 0) return { pass: false, reason: '未产生工具调用' };
            const comp = tcs.find(t => t.name === 'attempt_completion');
            if (!comp) return { pass: false, reason: `未使用 attempt_completion: ${tcs.map(t => t.name).join(',')}` };
            if (!comp.arguments.result) return { pass: false, reason: '缺少 result 参数' };
            return { pass: true, reason: 'OK' };
        },
    },
];

// ==================== 颜色 ====================

const C = {
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

// ==================== 测试执行 ====================

interface TestResult {
    id: string;
    label: string;
    round: number;
    pass: boolean;
    hasToolCalls: boolean;
    toolNames: string[];
    validationReason: string;
    elapsed: number;
    error?: string;
}

async function runTest(config: TestConfig, scenario: TestScenario, round: number): Promise<TestResult> {
    console.log(`  ${C.gray(`R${round}`)} ${C.cyan(scenario.label)}`);

    try {
        const messages = buildToolMessages(scenario.userQuery);
        const startTime = Date.now();
        const rawResponse = await sendCursorChat(config, messages);
        const elapsed = Date.now() - startTime;

        // 解析工具调用
        const hasCalls = hasToolCalls(rawResponse);
        const { toolCalls, cleanText } = parseToolCalls(rawResponse);

        // 验证
        const validation = scenario.validate(toolCalls, rawResponse);

        const toolNames = toolCalls.map(t => t.name);
        const statusIcon = validation.pass ? C.green('✓') : C.red('✗');
        const toolsStr = toolNames.length > 0 ? toolNames.join(', ') : C.red('无工具调用');

        console.log(`      ${statusIcon} 工具: [${toolsStr}]  ${C.gray(`${elapsed}ms`)}  ${!validation.pass ? C.red(validation.reason) : ''}`);

        if (!hasCalls) {
            // 显示原始响应的前 200 字符帮助调试
            console.log(`      ${C.gray(`原始输出: "${rawResponse.substring(0, 150)}..."`)}`);
        }

        return {
            id: scenario.id,
            label: scenario.label,
            round,
            pass: validation.pass,
            hasToolCalls: hasCalls,
            toolNames,
            validationReason: validation.reason,
            elapsed,
        };
    } catch (err: any) {
        console.log(`      ${C.red('✗')} 错误: ${err.message.substring(0, 80)}`);
        return {
            id: scenario.id,
            label: scenario.label,
            round,
            pass: false,
            hasToolCalls: false,
            toolNames: [],
            validationReason: '',
            elapsed: 0,
            error: err.message,
        };
    }
}

// ==================== 主程序 ====================

async function main() {
    const config = loadConfig();
    const ROUNDS = parseInt(process.argv[2] || '3', 10);

    console.log(C.bold(`\n🧪 Claude Code 工具调用稳定性测试 — ${ROUNDS} 轮 × ${SCENARIOS.length} 场景`));
    console.log(C.gray(`模型: ${config.cursorModel}`));
    console.log(C.gray(`代理: ${config.proxy || '无（直连）'}`));
    console.log(C.gray(`使用完整 Claude Code 系统提示词 + converter.ts 工具指令构建`));
    console.log(C.gray(`共 ${ROUNDS * SCENARIOS.length} 次 Cursor API 请求\n`));

    const allResults: TestResult[] = [];

    for (let round = 1; round <= ROUNDS; round++) {
        console.log(C.bold(`\n${'═'.repeat(60)}`));
        console.log(C.bold(`🔄 第 ${round}/${ROUNDS} 轮`));
        console.log(`${'═'.repeat(60)}\n`);

        for (const scenario of SCENARIOS) {
            const result = await runTest(config, scenario, round);
            allResults.push(result);
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    // ==================== 汇总 ====================
    console.log(`\n\n${'═'.repeat(65)}`);
    console.log(C.bold(`📋 工具调用稳定性报告（${ROUNDS} 轮）`));
    console.log(`${'═'.repeat(65)}`);

    for (const scenario of SCENARIOS) {
        const results = allResults.filter(r => r.id === scenario.id);
        const passes = results.filter(r => r.pass).length;
        const total = results.length;
        const rate = passes / total;
        const avgElapsed = Math.round(results.reduce((s, r) => s + r.elapsed, 0) / total);

        const rateColor = rate >= 1 ? C.green : rate >= 0.67 ? C.yellow : C.red;
        const roundDetails = results.map((r, i) => {
            const icon = r.pass ? '✓' : r.error ? 'E' : '✗';
            return `R${i + 1}:${r.pass ? C.green(icon) : C.red(icon)}`;
        });

        console.log(`\n${scenario.label} ${C.gray(`(期望: ${scenario.expectTools.join(', ')})`)}`);
        console.log(`  成功率: ${rateColor(`${passes}/${total} (${Math.round(rate * 100)}%)`)}  平均: ${C.gray(`${avgElapsed}ms`)}`);
        console.log(`  各轮: ${roundDetails.join('  ')}`);

        // 如果有失败，显示失败原因
        const failures = results.filter(r => !r.pass);
        if (failures.length > 0) {
            for (const f of failures) {
                const reason = f.error || f.validationReason || '未知';
                console.log(`  ${C.red(`  R${f.round} 失败: ${reason}`)}`);
            }
        }
    }

    // 总计
    const totalPass = allResults.filter(r => r.pass).length;
    const totalAll = allResults.length;
    const overallRate = totalPass / totalAll;

    console.log(`\n${'═'.repeat(65)}`);
    const overallColor = overallRate >= 1 ? C.green : overallRate >= 0.8 ? C.yellow : C.red;
    console.log(overallColor(`总计: ${totalPass}/${totalAll} (${Math.round(overallRate * 100)}%) 工具调用正确`));

    if (overallRate >= 1) {
        console.log(C.green('\n✅ 所有场景全部通过！工具调用提示词方案稳定可靠。'));
    } else if (overallRate >= 0.8) {
        console.log(C.yellow('\n⚠️  大部分场景通过，少数不稳定，建议保留兜底逻辑。'));
    } else {
        console.log(C.red('\n❌ 工具调用成功率偏低，需要调整提示词策略。'));
    }

    // 找出失败率最高的场景
    const scenarioRates = SCENARIOS.map(s => ({
        id: s.id,
        label: s.label,
        rate: allResults.filter(r => r.id === s.id && r.pass).length / allResults.filter(r => r.id === s.id).length,
    })).sort((a, b) => a.rate - b.rate);

    const weakest = scenarioRates.find(s => s.rate < 1);
    if (weakest) {
        console.log(C.yellow(`\n📍 最薄弱场景: ${weakest.label} (${Math.round(weakest.rate * 100)}%)`));
    }
}

main().catch(console.error);
