/**
 * thinking.ts - Thinking 块提取与处理
 *
 * 从 Cursor API 返回的文本响应中提取 <thinking>...</thinking> 标签，
 * 将其转换为 Anthropic API 的 thinking content block 或 OpenAI 的 reasoning_content。
 *
 * 参考：cursor2api-go 项目的 CursorProtocolParser 实现
 * 区别：由于本项目已经缓冲了完整响应（fullResponse），
 *       不需要流式 FSM 解析器，直接在缓冲文本上做正则提取即可。
 */

export interface ThinkingBlock {
    thinking: string;   // 提取出的 thinking 内容
}

export interface ExtractThinkingResult {
    thinkingBlocks: ThinkingBlock[];   // 所有提取出的 thinking 块
    cleanText: string;                  // 移除 thinking 标签后的干净文本
}

/**
 * 从响应文本中提取所有 <thinking>...</thinking> 块
 *
 * 支持：
 * - 多个 thinking 块
 * - thinking 块在文本的任何位置（开头、中间、结尾）
 * - 未闭合的 thinking 块（被截断的情况）
 *
 * @param text 原始响应文本
 * @returns thinking 块列表和移除标签后的干净文本
 */
export function extractThinking(text: string): ExtractThinkingResult {
    const thinkingBlocks: ThinkingBlock[] = [];

    if (!text || !text.includes('<thinking>')) {
        return { thinkingBlocks, cleanText: text };
    }

    // ★ 预处理：清除模型有时在 thinking 标签周围包裹的反引号
    // 常见模式：`<thinking>...</thinking>` 或 ```<thinking>...</thinking>```
    // 这些反引号会在 thinking 提取后残留为孤立反引号，导致正文被截断/格式错乱
    text = text.replace(/`{1,3}\s*<thinking>/g, '<thinking>');
    text = text.replace(/<\/thinking>\s*`{1,3}/g, '</thinking>');

    // 使用全局正则匹配所有 <thinking>...</thinking> 块
    // dotAll flag (s) 让 . 匹配换行符
    const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
    let match: RegExpExecArray | null;
    const ranges: Array<{ start: number; end: number }> = [];

    while ((match = thinkingRegex.exec(text)) !== null) {
        // 清除 thinking 内容首尾的反引号（模型有时在内容内也加反引号）
        let thinkingContent = match[1].trim();
        thinkingContent = thinkingContent.replace(/^`{1,3}\s*/, '').replace(/\s*`{1,3}$/, '');
        if (thinkingContent) {
            thinkingBlocks.push({ thinking: thinkingContent });
        }
        ranges.push({ start: match.index, end: match.index + match[0].length });
    }

    // 处理未闭合的 <thinking> 块（截断场景）
    // 检查最后一个 <thinking> 是否在最后一个 </thinking> 之后
    const lastOpenIdx = text.lastIndexOf('<thinking>');
    const lastCloseIdx = text.lastIndexOf('</thinking>');
    if (lastOpenIdx >= 0 && (lastCloseIdx < 0 || lastOpenIdx > lastCloseIdx)) {
        // 未闭合的 thinking 块 — 提取剩余内容
        let unclosedContent = text.substring(lastOpenIdx + '<thinking>'.length).trim();
        unclosedContent = unclosedContent.replace(/^`{1,3}\s*/, '').replace(/\s*`{1,3}$/, '');
        if (unclosedContent) {
            thinkingBlocks.push({ thinking: unclosedContent });
        }
        ranges.push({ start: lastOpenIdx, end: text.length });
    }

    // 从后往前移除已提取的 thinking 块，生成干净文本
    // 先按 start 降序排列以安全删除
    ranges.sort((a, b) => b.start - a.start);
    let cleanText = text;
    for (const range of ranges) {
        cleanText = cleanText.substring(0, range.start) + cleanText.substring(range.end);
    }

    // 清理多余空行（thinking 块移除后可能留下连续空行）
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

    // ★ 后处理：清除 thinking 提取后残留的孤立反引号
    // 场景：模型输出 `<thinking>...</thinking>\n正文内容`
    // 注意：不能清除后面跟语言标识符的反引号（如 ```json），那是代码块的一部分
    cleanText = cleanText.replace(/^`{1,3}\s*\n(?!json|javascript|typescript|python|bash|sh|html|css)/i, '').replace(/\n\s*`{1,3}$/, '');
    // 处理 cleanText 整体被一对反引号包裹的情况（如 `正文内容`）
    if (/^`[^`]/.test(cleanText) && /[^`]`$/.test(cleanText) && (cleanText.match(/`/g) || []).length === 2) {
        cleanText = cleanText.substring(1, cleanText.length - 1);
    }
    cleanText = cleanText.trim();

    if (thinkingBlocks.length > 0) {
        console.log(`[Thinking] 提取到 ${thinkingBlocks.length} 个 thinking 块, 总 ${thinkingBlocks.reduce((s, b) => s + b.thinking.length, 0)} chars`);
    }

    return { thinkingBlocks, cleanText };
}

/**
 * Thinking 提示词 — 注入到系统提示词中，引导模型使用 <thinking> 标签
 *
 * 与 cursor2api-go 的 thinkingHint 保持一致
 */
export const THINKING_HINT = `You may think through your approach inside <thinking>...</thinking> tags before responding. This thinking will not be shown to the user. Feel free to use it to analyze the request, plan your approach, and reason about the best solution. After </thinking>, write your actual response.`;
