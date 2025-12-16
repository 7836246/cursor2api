// Package handler 提供 HTTP 请求处理器
package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"cursor2api/internal/browser"
	"cursor2api/internal/config"
	"cursor2api/internal/tools"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// ================== 请求/响应结构体 ==================

// MessagesRequest Anthropic Messages API 请求格式
type MessagesRequest struct {
	Model     string                 `json:"model"`
	Messages  []Message              `json:"messages"`
	MaxTokens int                    `json:"max_tokens"`
	Stream    bool                   `json:"stream"`
	System    interface{}            `json:"system,omitempty"` // 可以是 string 或 []ContentBlock
	Tools     []tools.ToolDefinition `json:"tools,omitempty"`  // 工具定义
}

// Message 消息格式
type Message struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"` // 可以是 string 或 []ContentBlock 或 []ToolResult
}

// MessagesResponse Anthropic Messages API 响应格式
type MessagesResponse struct {
	ID           string         `json:"id"`
	Type         string         `json:"type"`
	Role         string         `json:"role"`
	Content      []ContentBlock `json:"content"`
	Model        string         `json:"model"`
	StopReason   string         `json:"stop_reason"`
	StopSequence *string        `json:"stop_sequence"`
	Usage        Usage          `json:"usage"`
}

// ContentBlock 内容块（支持 text 和 tool_use）
type ContentBlock struct {
	Type  string                 `json:"type"`
	Text  string                 `json:"text,omitempty"`
	ID    string                 `json:"id,omitempty"`    // tool_use
	Name  string                 `json:"name,omitempty"`  // tool_use
	Input map[string]interface{} `json:"input,omitempty"` // tool_use
}

// Usage token 使用统计
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// 全局工具执行器和解析器
var (
	toolExecutor *tools.Executor
	toolParser   *tools.Parser
)

func init() {
	toolExecutor = tools.NewExecutor()
	toolParser = tools.NewParser()
}

// CursorSSEEvent Cursor SSE 事件格式
type CursorSSEEvent struct {
	Type  string `json:"type"`
	Delta string `json:"delta,omitempty"`
}

// ================== 辅助函数 ==================

// generateID 生成唯一标识符
func generateID() string {
	return strings.ReplaceAll(uuid.New().String(), "-", "")[:16]
}

// getTextContent 从 interface{} 提取文本内容
// 支持 string 和 []ContentBlock 两种格式
func getTextContent(content interface{}) string {
	if content == nil {
		return ""
	}
	switch v := content.(type) {
	case string:
		return v
	case []interface{}:
		var texts []string
		for _, item := range v {
			if block, ok := item.(map[string]interface{}); ok {
				if block["type"] == "text" {
					if text, ok := block["text"].(string); ok {
						texts = append(texts, text)
					}
				}
			}
		}
		return strings.Join(texts, "\n")
	default:
		return fmt.Sprintf("%v", v)
	}
}

// mapModelName 将模型名称映射到 Cursor 支持的格式
func mapModelName(model string) string {
	model = strings.ToLower(model)

	// 已经是 Cursor 格式
	if strings.Contains(model, "/") {
		return model
	}

	// Claude 模型
	if strings.Contains(model, "claude") {
		return "anthropic/claude-sonnet-4.5"
	}

	// GPT 模型
	if strings.Contains(model, "gpt") {
		return "openai/gpt-5-nano"
	}

	// Gemini 模型
	if strings.Contains(model, "gemini") {
		return "google/gemini-2.5-flash"
	}

	// 默认使用 Claude
	return "anthropic/claude-sonnet-4.5"
}

// ================== 处理器函数 ==================

// CountTokens 估算 token 数量
func CountTokens(c *gin.Context) {
	var req MessagesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": err.Error()}})
		return
	}

	// 简单估算：每 4 个字符约 1 个 token
	totalChars := len(getTextContent(req.System))
	for _, msg := range req.Messages {
		totalChars += len(getTextContent(msg.Content))
	}
	tokens := totalChars / 4
	if tokens < 1 {
		tokens = 1
	}

	c.JSON(http.StatusOK, gin.H{"input_tokens": tokens})
}

// Messages 处理 Anthropic Messages API 请求
func Messages(c *gin.Context) {
	var req MessagesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": err.Error()}})
		return
	}

	// 转换为 Cursor 请求格式
	cursorReq := convertToCursor(req)

	if req.Stream {
		handleStream(c, cursorReq, req.Model)
	} else {
		handleNonStream(c, cursorReq, req.Model)
	}
}

// ================== 请求转换 ==================

// convertToCursor 将 Anthropic 请求转换为 Cursor 格式
func convertToCursor(req MessagesRequest) browser.CursorChatRequest {
	messages := make([]browser.CursorMessage, 0, len(req.Messages)+1)

	// 构建系统消息（包含工具定义）
	sysText := getTextContent(req.System)
	if len(req.Tools) > 0 {
		toolPrompt := tools.GenerateToolPrompt(req.Tools)
		sysText += toolPrompt
	}

	if sysText != "" {
		messages = append(messages, browser.CursorMessage{
			Parts: []browser.CursorPart{{Type: "text", Text: sysText}},
			ID:    generateID(),
			Role:  "system",
		})
	}

	// 添加用户/助手消息
	for _, msg := range req.Messages {
		text := extractMessageText(msg)
		if text != "" {
			messages = append(messages, browser.CursorMessage{
				Parts: []browser.CursorPart{{Type: "text", Text: text}},
				ID:    generateID(),
				Role:  msg.Role,
			})
		}
	}

	return browser.CursorChatRequest{
		Context: []browser.CursorContext{{
			Type:     "file",
			Content:  "",
			FilePath: "/docs/",
		}},
		Model:    mapModelName(req.Model),
		ID:       generateID(),
		Messages: messages,
		Trigger:  "submit-message",
	}
}

// extractMessageText 从消息中提取文本（处理 tool_result）
func extractMessageText(msg Message) string {
	content := msg.Content
	if content == nil {
		return ""
	}

	switch v := content.(type) {
	case string:
		return v
	case []interface{}:
		var texts []string
		for _, item := range v {
			block, ok := item.(map[string]interface{})
			if !ok {
				continue
			}

			blockType, _ := block["type"].(string)
			switch blockType {
			case "text":
				if text, ok := block["text"].(string); ok {
					texts = append(texts, text)
				}
			case "tool_result":
				// 处理工具结果
				toolUseID, _ := block["tool_use_id"].(string)
				resultContent := block["content"]
				isError, _ := block["is_error"].(bool)

				resultText := ""
				switch rc := resultContent.(type) {
				case string:
					resultText = rc
				case []interface{}:
					for _, rcItem := range rc {
						if rcBlock, ok := rcItem.(map[string]interface{}); ok {
							if rcBlock["type"] == "text" {
								if t, ok := rcBlock["text"].(string); ok {
									resultText += t
								}
							}
						}
					}
				}

				prefix := "工具执行结果"
				if isError {
					prefix = "工具执行错误"
				}
				texts = append(texts, fmt.Sprintf("[%s (ID: %s)]\n%s", prefix, toolUseID, resultText))
			}
		}
		return strings.Join(texts, "\n")
	default:
		return fmt.Sprintf("%v", v)
	}
}

// ================== API 处理 ==================

// handleStream 处理流式请求
func handleStream(c *gin.Context, cursorReq browser.CursorChatRequest, model string) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	flusher, _ := c.Writer.(http.Flusher)
	id := "msg_" + generateID()

	// 发送 message_start
	c.Writer.WriteString("event: message_start\n")
	c.Writer.WriteString(fmt.Sprintf(`data: {"type":"message_start","message":{"id":"%s","type":"message","role":"assistant","content":[],"model":"%s","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":0}}}`+"\n\n", id, model))
	flusher.Flush()

	c.Writer.WriteString("event: content_block_start\n")
	c.Writer.WriteString(`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` + "\n\n")
	flusher.Flush()

	// 用于累积完整响应和 SSE 行
	var buffer strings.Builder
	var fullResponse strings.Builder

	svc := browser.GetService()
	err := svc.SendStreamRequest(cursorReq, func(chunk string) {
		buffer.WriteString(chunk)
		content := buffer.String()
		lines := strings.Split(content, "\n")

		// 保留最后一个可能不完整的行
		if !strings.HasSuffix(content, "\n") && len(lines) > 0 {
			buffer.Reset()
			buffer.WriteString(lines[len(lines)-1])
			lines = lines[:len(lines)-1]
		} else {
			buffer.Reset()
		}

		for _, line := range lines {
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			data := strings.TrimPrefix(line, "data: ")
			if data == "" {
				continue
			}

			var event CursorSSEEvent
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				continue
			}

			if event.Type == "text-delta" && event.Delta != "" {
				fullResponse.WriteString(event.Delta)
				deltaJSON, _ := json.Marshal(event.Delta)
				c.Writer.WriteString("event: content_block_delta\n")
				c.Writer.WriteString(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":` + string(deltaJSON) + `}}` + "\n\n")
				flusher.Flush()
			}
		}
	})

	if err != nil {
		c.Writer.WriteString("event: error\n")
		c.Writer.WriteString(`data: {"type":"error","error":{"message":"` + err.Error() + `"}}` + "\n\n")
		flusher.Flush()
	}

	c.Writer.WriteString("event: content_block_stop\n")
	c.Writer.WriteString(`data: {"type":"content_block_stop","index":0}` + "\n\n")
	flusher.Flush()

	// 检测是否有工具调用，决定 stop_reason
	stopReason := "end_turn"
	responseText := fullResponse.String()
	toolCalls, _ := toolParser.ParseToolCalls(responseText)

	// 如果没有工具调用，检查是否是拒绝响应，自动执行（需要配置开启）
	cfg := config.Get()
	if len(toolCalls) == 0 && cfg.Browser.AutoExecute && tools.DetectRefusal(responseText) {
		if cmd := tools.ExtractCommandFromRefusal(responseText); cmd != "" {
			// 自动执行提取的命令
			output, execErr := toolExecutor.Execute("bash", map[string]interface{}{
				"command": cmd,
			})

			resultText := output
			isError := false
			if execErr != nil {
				resultText = execErr.Error()
				isError = true
			}

			// 清除之前发送的 AI 拒绝文本，发送一个新的干净的文本块
			// 注意：SSE 流已经发送了拒绝文本，我们只能追加结果
			// 发送执行结果作为新的文本块（替代之前的拒绝内容）
			statusEmoji := "✅"
			statusText := "执行成功"
			if isError {
				statusEmoji = "❌"
				statusText = "执行失败"
			}

			// 简洁的结果输出，不显示 AI 的废话
			var resultMsg string
			if resultText == "" {
				resultMsg = fmt.Sprintf("\n\n---\n%s **%s**\n```bash\n%s\n```", statusEmoji, statusText, cmd)
			} else {
				resultMsg = fmt.Sprintf("\n\n---\n%s **%s**\n```bash\n%s\n```\n输出:\n```\n%s\n```", statusEmoji, statusText, cmd, resultText)
			}
			resultJSON, _ := json.Marshal(resultMsg)

			c.Writer.WriteString("event: content_block_start\n")
			c.Writer.WriteString(`data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}` + "\n\n")
			flusher.Flush()

			c.Writer.WriteString("event: content_block_delta\n")
			c.Writer.WriteString(`data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":` + string(resultJSON) + `}}` + "\n\n")
			flusher.Flush()

			c.Writer.WriteString("event: content_block_stop\n")
			c.Writer.WriteString(`data: {"type":"content_block_stop","index":1}` + "\n\n")
			flusher.Flush()

			// 设置 stop_reason 为 end_turn 而不是 tool_use
			stopReason = "end_turn"
		}
	} else if len(toolCalls) > 0 {
		stopReason = "tool_use"
		// 发送工具调用块
		for i, call := range toolCalls {
			toolID := "toolu_" + generateID()
			inputJSON, _ := json.Marshal(call.Input)

			c.Writer.WriteString("event: content_block_start\n")
			c.Writer.WriteString(fmt.Sprintf(`data: {"type":"content_block_start","index":%d,"content_block":{"type":"tool_use","id":"%s","name":"%s","input":{}}}`+"\n\n", i+1, toolID, call.Name))
			flusher.Flush()

			c.Writer.WriteString("event: content_block_delta\n")
			c.Writer.WriteString(fmt.Sprintf(`data: {"type":"content_block_delta","index":%d,"delta":{"type":"input_json_delta","partial_json":"%s"}}`+"\n\n", i+1, escapeJSON(string(inputJSON))))
			flusher.Flush()

			c.Writer.WriteString("event: content_block_stop\n")
			c.Writer.WriteString(fmt.Sprintf(`data: {"type":"content_block_stop","index":%d}`+"\n\n", i+1))
			flusher.Flush()
		}
	}

	c.Writer.WriteString("event: message_delta\n")
	c.Writer.WriteString(fmt.Sprintf(`data: {"type":"message_delta","delta":{"stop_reason":"%s","stop_sequence":null},"usage":{"output_tokens":100}}`+"\n\n", stopReason))
	flusher.Flush()

	c.Writer.WriteString("event: message_stop\n")
	c.Writer.WriteString(`data: {"type":"message_stop"}` + "\n\n")
	flusher.Flush()
}

// escapeJSON 转义 JSON 字符串中的特殊字符
func escapeJSON(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\r`)
	s = strings.ReplaceAll(s, "\t", `\t`)
	return s
}

// handleNonStream 处理非流式请求
func handleNonStream(c *gin.Context, cursorReq browser.CursorChatRequest, model string) {
	svc := browser.GetService()
	result, err := svc.SendRequest(cursorReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"message": err.Error()}})
		return
	}

	// 解析响应
	var fullText strings.Builder
	lines := strings.Split(result, "\n")
	for _, line := range lines {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "" {
			continue
		}

		var event CursorSSEEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}

		if event.Type == "text-delta" && event.Delta != "" {
			fullText.WriteString(event.Delta)
		}
	}

	responseText := fullText.String()
	contentBlocks := parseResponseToBlocks(responseText, nil)

	// 确定 stop_reason
	stopReason := "end_turn"
	for _, block := range contentBlocks {
		if block.Type == "tool_use" {
			stopReason = "tool_use"
			break
		}
	}

	c.JSON(http.StatusOK, MessagesResponse{
		ID:         "msg_" + generateID(),
		Type:       "message",
		Role:       "assistant",
		Content:    contentBlocks,
		Model:      model,
		StopReason: stopReason,
		Usage:      Usage{InputTokens: 100, OutputTokens: 100},
	})
}

// parseResponseToBlocks 解析 AI 响应为内容块（检测工具调用）
func parseResponseToBlocks(text string, userMessages []string) []ContentBlock {
	var blocks []ContentBlock

	// 检测工具调用
	toolCalls, remainingText := toolParser.ParseToolCalls(text)

	// 如果没有工具调用，检查是否是拒绝响应（需要配置开启）
	cfg := config.Get()
	if len(toolCalls) == 0 && cfg.Browser.AutoExecute && tools.DetectRefusal(text) {
		// 尝试从拒绝响应中提取命令并自动执行
		if cmd := tools.ExtractCommandFromRefusal(text); cmd != "" {
			// 自动执行提取的命令
			output, err := toolExecutor.Execute("bash", map[string]interface{}{
				"command": cmd,
			})

			resultText := output
			isError := false
			if err != nil {
				resultText = err.Error()
				isError = true
			}

			// 返回工具使用和结果
			toolID := "toolu_" + generateID()
			blocks = append(blocks, ContentBlock{
				Type: "text",
				Text: "正在执行命令...",
			})
			blocks = append(blocks, ContentBlock{
				Type:  "tool_use",
				ID:    toolID,
				Name:  "bash",
				Input: map[string]interface{}{"command": cmd},
			})

			// 添加执行结果说明
			statusText := "✅ 命令执行成功"
			if isError {
				statusText = "❌ 命令执行失败"
			}
			blocks = append(blocks, ContentBlock{
				Type: "text",
				Text: fmt.Sprintf("\n\n%s:\n```\n%s\n```", statusText, resultText),
			})

			return blocks
		}
	}

	// 添加文本块
	if remainingText != "" {
		blocks = append(blocks, ContentBlock{
			Type: "text",
			Text: remainingText,
		})
	}

	// 添加工具调用块
	for _, call := range toolCalls {
		blocks = append(blocks, ContentBlock{
			Type:  "tool_use",
			ID:    "toolu_" + generateID(),
			Name:  call.Name,
			Input: call.Input,
		})
	}

	// 如果没有任何内容，添加空文本块
	if len(blocks) == 0 {
		blocks = append(blocks, ContentBlock{
			Type: "text",
			Text: text,
		})
	}

	return blocks
}
