/**
 * streaming-tool-parser.ts - 流式工具调用解析器
 *
 * 逐 delta 解析 ```json action 块的状态机。
 * 文本部分立即产出，工具 JSON 块局部缓冲后一次性解析产出。
 *
 * 状态：
 * - TEXT：普通文本，检测 ``` 起始标记
 * - FENCE_DETECT：看到 ``` 后，检测是否跟 json action
 * - TOOL_BUFFER：在 ```json action 块内，缓冲 JSON 内容
 *
 * ★ 关键修复：在 TOOL_BUFFER 状态下追踪 JSON 字符串上下文，
 *   JSON 字符串内的反引号不触发闭合检测。
 *   这防止了 Write 工具的 content 参数包含 markdown 代码块时
 *   （如 ```bash ... ```）被误认为工具块闭合。
 */

export interface ToolParserEvent {
    type: 'text' | 'tool_complete' | 'tool_error';
    /** type=text 时：可立即转发的文本内容 */
    text?: string;
    /** type=tool_complete 时：解析出的工具名 */
    toolName?: string;
    /** type=tool_complete 时：解析出的参数 */
    toolArgs?: Record<string, unknown>;
    /** type=tool_error 时：错误信息 */
    error?: string;
}

type ParserState = 'text' | 'fence_detect' | 'tool_buffer';

const TOOL_FENCE_PATTERN = /^json\s+action\s*$/;
const TOOL_FENCE_PREFIX_CHARS = 'json action';

export class StreamingToolParser {
    private state: ParserState = 'text';
    /** 在 text 状态下检测反引号序列 */
    private backtickCount = 0;
    /** 在 fence_detect 状态下缓冲 ``` 后的语言标识符 */
    private fenceBuffer = '';
    /** 在 tool_buffer 状态下缓冲 JSON 内容 */
    private toolJsonBuffer = '';
    /** 在 tool_buffer 状态下计数可能的闭合反引号 */
    private closeBacktickCount = 0;
    /** 安全文本缓冲：有 ` 嫌疑但还不确定的文本 */
    private pendingText = '';

    // ★ JSON 字符串上下文追踪（在 tool_buffer 状态下使用）
    /** 是否在 JSON 字符串中（双引号之间） */
    private inJsonString = false;
    /** 上一个字符是否是转义字符 \ */
    private jsonEscaped = false;

    /**
     * 喂入一个 delta chunk，返回产出的事件列表
     */
    feed(delta: string): ToolParserEvent[] {
        const events: ToolParserEvent[] = [];
        
        for (let i = 0; i < delta.length; i++) {
            const char = delta[i];
            const stateEvents = this.processChar(char);
            events.push(...stateEvents);
        }

        return events;
    }

    private processChar(char: string): ToolParserEvent[] {
        const events: ToolParserEvent[] = [];

        switch (this.state) {
            case 'text':
                if (char === '`') {
                    this.backtickCount++;
                    this.pendingText += char;
                    if (this.backtickCount === 3) {
                        // 看到 ```，切换到 fence_detect
                        this.state = 'fence_detect';
                        this.fenceBuffer = '';
                        // 不发送 pendingText 中的 ```，等确认是否为工具块
                        this.pendingText = this.pendingText.slice(0, -3);
                        if (this.pendingText) {
                            events.push({ type: 'text', text: this.pendingText });
                            this.pendingText = '';
                        }
                    }
                } else {
                    this.backtickCount = 0;
                    this.pendingText += char;
                    
                    // 每积累一段文本就发出（避免逐字符发出太碎）
                    if (char === '\n' || this.pendingText.length >= 20) {
                        events.push({ type: 'text', text: this.pendingText });
                        this.pendingText = '';
                    }
                }
                break;

            case 'fence_detect':
                if (char === '\n') {
                    // 换行：检查 fenceBuffer 是否匹配 "json action"
                    const trimmed = this.fenceBuffer.trim();
                    if (TOOL_FENCE_PATTERN.test(trimmed)) {
                        // 是工具块！切换到 tool_buffer
                        this.state = 'tool_buffer';
                        this.toolJsonBuffer = '';
                        this.closeBacktickCount = 0;
                        this.inJsonString = false;
                        this.jsonEscaped = false;
                    } else {
                        // 不是工具块，是普通代码块
                        events.push({ type: 'text', text: '```' + this.fenceBuffer + '\n' });
                        this.state = 'text';
                        this.backtickCount = 0;
                        this.pendingText = '';
                    }
                    this.fenceBuffer = '';
                } else {
                    this.fenceBuffer += char;
                    if (this.fenceBuffer.length > TOOL_FENCE_PREFIX_CHARS.length + 5) {
                        events.push({ type: 'text', text: '```' + this.fenceBuffer });
                        this.state = 'text';
                        this.backtickCount = 0;
                        this.fenceBuffer = '';
                        this.pendingText = '';
                    }
                }
                break;

            case 'tool_buffer':
                // ★ 核心修复：追踪 JSON 字符串上下文
                // 只有在 JSON 字符串外部时，反引号才可能是闭合标记
                if (this.inJsonString) {
                    // 在 JSON 字符串内部
                    this.toolJsonBuffer += char;
                    if (this.jsonEscaped) {
                        // 上一个是 \，这个字符被转义，无论是什么都不影响状态
                        this.jsonEscaped = false;
                    } else if (char === '\\') {
                        // 转义字符
                        this.jsonEscaped = true;
                    } else if (char === '"') {
                        // 未转义的引号 → 字符串结束
                        this.inJsonString = false;
                    }
                    // 字符串内的反引号不计数
                    this.closeBacktickCount = 0;
                } else {
                    // 在 JSON 字符串外部
                    if (char === '`') {
                        this.closeBacktickCount++;
                        if (this.closeBacktickCount === 3) {
                            // ★ 真正的工具块闭合（在字符串外部看到 ```）
                            const jsonStr = this.toolJsonBuffer.trim();
                            try {
                                const parsed = JSON.parse(jsonStr);
                                if (parsed.tool || parsed.name) {
                                    events.push({
                                        type: 'tool_complete',
                                        toolName: parsed.tool || parsed.name,
                                        toolArgs: parsed.parameters || parsed.arguments || parsed.input || {},
                                    });
                                } else {
                                    events.push({ type: 'tool_error', error: `JSON 无 tool/name 字段: ${jsonStr.substring(0, 80)}` });
                                }
                            } catch (e) {
                                events.push({ type: 'tool_error', error: `JSON 解析失败: ${(e as Error).message}` });
                            }
                            // 回到 text 状态
                            this.state = 'text';
                            this.toolJsonBuffer = '';
                            this.closeBacktickCount = 0;
                            this.backtickCount = 0;
                            this.pendingText = '';
                            this.inJsonString = false;
                            this.jsonEscaped = false;
                        }
                    } else {
                        if (this.closeBacktickCount > 0) {
                            // 之前的反引号不是闭合，把它们加入 JSON 缓冲
                            this.toolJsonBuffer += '`'.repeat(this.closeBacktickCount);
                            this.closeBacktickCount = 0;
                        }
                        this.toolJsonBuffer += char;
                        // 追踪 JSON 字符串开始
                        if (char === '"') {
                            this.inJsonString = true;
                            this.jsonEscaped = false;
                        }
                    }
                }
                break;
        }

        return events;
    }

    /**
     * 流结束时刷出所有缓冲
     */
    flush(): ToolParserEvent[] {
        const events: ToolParserEvent[] = [];

        switch (this.state) {
            case 'text':
                if (this.pendingText) {
                    events.push({ type: 'text', text: this.pendingText });
                    this.pendingText = '';
                }
                break;
            case 'fence_detect':
                // 流结束但 fence 未确认，当作普通文本
                events.push({ type: 'text', text: '```' + this.fenceBuffer });
                break;
            case 'tool_buffer':
                // 工具块未闭合（截断），尝试解析已有内容
                if (this.toolJsonBuffer.trim()) {
                    let jsonStr = this.toolJsonBuffer.trim();
                    // 尝试补全 JSON
                    if (!jsonStr.endsWith('}')) {
                        // 尝试加闭合括号
                        const openBraces = (jsonStr.match(/\{/g) || []).length;
                        const closeBraces = (jsonStr.match(/\}/g) || []).length;
                        const missing = openBraces - closeBraces;
                        if (missing > 0) {
                            jsonStr += '}'.repeat(missing);
                        }
                    }
                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.tool || parsed.name) {
                            events.push({
                                type: 'tool_complete',
                                toolName: parsed.tool || parsed.name,
                                toolArgs: parsed.parameters || parsed.arguments || parsed.input || {},
                            });
                        }
                    } catch {
                        events.push({ type: 'tool_error', error: `未闭合的工具块: ${this.toolJsonBuffer.substring(0, 100)}` });
                    }
                }
                break;
        }

        this.reset();
        return events;
    }

    /** 当前是否在工具块内 */
    isInToolBlock(): boolean {
        return this.state === 'tool_buffer' || this.state === 'fence_detect';
    }

    reset(): void {
        this.state = 'text';
        this.backtickCount = 0;
        this.fenceBuffer = '';
        this.toolJsonBuffer = '';
        this.closeBacktickCount = 0;
        this.pendingText = '';
        this.inJsonString = false;
        this.jsonEscaped = false;
    }
}
