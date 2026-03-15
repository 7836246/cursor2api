// ==================== Anthropic API Types ====================

export interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    stream?: boolean;
    system?: string | AnthropicContentBlock[];
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
    thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
    temperature?: number;
    top_p?: number;
    stop_sequences?: string[];
}

/** tool_choice 控制模型是否必须调用工具
 *  - auto: 模型自行决定（默认）
 *  - any:  必须调用至少一个工具
 *  - tool: 必须调用指定工具
 */
export type AnthropicToolChoice =
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'tool'; name: string };

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
    type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image';
    text?: string;
    // thinking fields (Anthropic extended thinking)
    thinking?: string;
    signature?: string;
    // image fields
    source?: { type: string; media_type?: string; data: string };
    // tool_use fields
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    // tool_result fields
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
    is_error?: boolean;
}

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string;
    stop_sequence: string | null;
    usage: { 
        input_tokens: number; 
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
}

// ==================== Cursor API Types ====================

export interface CursorChatRequest {
    context?: CursorContext[];
    model: string;
    id: string;
    messages: CursorMessage[];
    trigger: string;
    maxTokens?: number;
    max_tokens?: number;
}

export interface CursorContext {
    type: string;
    content: string;
    filePath: string;
}

export interface CursorMessage {
    parts: CursorPart[];
    id: string;
    role: string;
}

export interface CursorPart {
    type: string;
    text: string;
}

export interface CursorSSEEvent {
    type: string;
    delta?: string;
}

// ==================== Internal Types ====================

export interface ParsedToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface AppConfig {
    port: number;
    timeout: number;
    proxy?: string;
    cursorModel: string;
    enableThinking?: boolean;
    /** AI 摘要压缩：用额外 API 调用对旧消息进行摘要压缩（质量不稳定，默认关闭） */
    enableSummary?: boolean;
    /** 渐进式截断：保留最近消息完整，仅截短早期超长消息（默认开启） */
    enableProgressiveTruncation?: boolean;
    vision?: {
        enabled: boolean;
        mode: 'ocr' | 'api';
        /** Multiple API providers to try in order; used when mode is 'api' */
        providers: VisionProvider[];
        /** If all API providers fail, fall back to local OCR (default: true) */
        fallbackToOcr: boolean;
        // Legacy single-provider fields kept for backward compat
        baseUrl: string;
        apiKey: string;
        model: string;
    };
    fingerprint: {
        userAgent: string;
    };
}

export interface VisionProvider {
    name?: string;
    baseUrl: string;
    apiKey: string;
    model: string;
}

