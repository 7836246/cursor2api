/**
 * streaming-parser.ts - 流式 Thinking 标签解析器
 *
 * 在真正的流式传输中，我们需要逐 chunk 处理 <thinking>...</thinking> 标签，
 * 而不是等待全部响应后再正则提取。
 *
 * 状态机：
 * - NORMAL：正常文本输出模式，检测 `<thinking>` 起始标签
 * - THINKING：thinking 内容缓冲模式，检测 `</thinking>` 结束标签
 *
 * 边界处理：
 * - 当 chunk 在标签中间被切断时（如 "<think" 在 chunk 末尾），
 *   将潜在标签前缀缓冲，等下一个 chunk 来确认是否属于标签。
 */

export interface StreamingParserOutput {
    /** 可以立即发送给客户端的正文文本 */
    text: string;
    /** 如果一个 thinking 块完成了，返回其内容 */
    thinkingComplete?: string;
}

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';

export class StreamingThinkingParser {
    private state: 'normal' | 'thinking' = 'normal';
    /** 在 normal 状态下缓冲潜在的 `<thinking>` 前缀 */
    private tagBuffer = '';
    /** 在 thinking 状态下缓冲 thinking 内容 */
    private thinkingBuffer = '';
    /** 在 thinking 状态下缓冲潜在的 `</thinking>` 前缀 */
    private closeTagBuffer = '';

    /**
     * 输入一个 chunk，返回可发送的文本和/或已完成的 thinking 块
     */
    feed(chunk: string): StreamingParserOutput {
        let text = '';
        let thinkingComplete: string | undefined;

        for (let i = 0; i < chunk.length; i++) {
            const char = chunk[i];

            if (this.state === 'normal') {
                this.tagBuffer += char;

                // 检查是否是 <thinking> 的前缀
                if (OPEN_TAG.startsWith(this.tagBuffer)) {
                    if (this.tagBuffer === OPEN_TAG) {
                        // 完整匹配到 <thinking>，切换到 thinking 模式
                        this.state = 'thinking';
                        this.tagBuffer = '';
                        this.thinkingBuffer = '';
                        this.closeTagBuffer = '';
                    }
                    // 否则继续缓冲
                } else {
                    // 不是标签前缀，把缓冲内容作为普通文本输出
                    text += this.tagBuffer;
                    this.tagBuffer = '';
                }
            } else {
                // state === 'thinking'
                this.closeTagBuffer += char;

                if (CLOSE_TAG.startsWith(this.closeTagBuffer)) {
                    if (this.closeTagBuffer === CLOSE_TAG) {
                        // 完整匹配到 </thinking>，thinking 块完成
                        thinkingComplete = this.thinkingBuffer.trim();
                        this.state = 'normal';
                        this.thinkingBuffer = '';
                        this.closeTagBuffer = '';
                        this.tagBuffer = '';
                    }
                    // 否则继续缓冲
                } else {
                    // 不是关闭标签前缀，把缓冲内容加入 thinking 内容
                    this.thinkingBuffer += this.closeTagBuffer;
                    this.closeTagBuffer = '';
                }
            }
        }

        return { text, thinkingComplete };
    }

    /**
     * 流结束时调用，刷出所有缓冲内容
     */
    flush(): StreamingParserOutput {
        let text = '';
        let thinkingComplete: string | undefined;

        if (this.state === 'normal') {
            // 把未确认的标签前缀作为普通文本输出
            text = this.tagBuffer;
            this.tagBuffer = '';
        } else {
            // thinking 状态下流结束 = 未闭合的 thinking 块
            // 把 thinking 内容作为 thinking 块返回（与 extractThinking 的未闭合处理对齐）
            const content = (this.thinkingBuffer + this.closeTagBuffer).trim();
            if (content) {
                thinkingComplete = content;
            }
            this.thinkingBuffer = '';
            this.closeTagBuffer = '';
            this.state = 'normal';
        }

        return { text, thinkingComplete };
    }

    /** 当前是否在 thinking 状态中 */
    isInThinking(): boolean {
        return this.state === 'thinking';
    }

    /** 重置解析器 */
    reset(): void {
        this.state = 'normal';
        this.tagBuffer = '';
        this.thinkingBuffer = '';
        this.closeTagBuffer = '';
    }
}
