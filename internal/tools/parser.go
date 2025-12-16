package tools

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Parser 解析 AI 输出中的工具调用
type Parser struct{}

// NewParser 创建解析器
func NewParser() *Parser {
	return &Parser{}
}

// toolCallPattern 匹配工具调用的 JSON 块
var toolCallPatterns = []*regexp.Regexp{
	// 标准 JSON 块格式
	regexp.MustCompile(`(?s)<tool_call>\s*(\{.*?\})\s*</tool_call>`),
	// 代码块格式
	regexp.MustCompile("(?s)```json\\s*\\n(\\{[^`]*?\"tool\"[^`]*?\\})\\s*\\n```"),
	regexp.MustCompile("(?s)```\\s*\\n(\\{[^`]*?\"tool\"[^`]*?\\})\\s*\\n```"),
	// 单行 JSON 格式
	regexp.MustCompile(`(\{"tool"\s*:\s*"[^"]+"\s*,\s*"[^}]+\})`),
}

// ParseToolCalls 从 AI 输出中解析工具调用
func (p *Parser) ParseToolCalls(output string) ([]ParsedToolCall, string) {
	var calls []ParsedToolCall
	remainingText := output

	for _, pattern := range toolCallPatterns {
		matches := pattern.FindAllStringSubmatch(output, -1)
		for _, match := range matches {
			if len(match) < 2 {
				continue
			}

			jsonStr := match[1]
			var rawCall map[string]interface{}
			if err := json.Unmarshal([]byte(jsonStr), &rawCall); err != nil {
				continue
			}

			// 提取工具名称
			toolName := ""
			if name, ok := rawCall["tool"].(string); ok {
				toolName = name
			} else if name, ok := rawCall["name"].(string); ok {
				toolName = name
			}

			if toolName == "" {
				continue
			}

			// 提取输入参数
			input := make(map[string]interface{})
			if inp, ok := rawCall["input"].(map[string]interface{}); ok {
				input = inp
			} else {
				// 其他字段作为输入
				for k, v := range rawCall {
					if k != "tool" && k != "name" && k != "type" {
						input[k] = v
					}
				}
			}

			calls = append(calls, ParsedToolCall{
				Name:  toolName,
				Input: input,
			})

			// 从剩余文本中移除已解析的工具调用
			remainingText = strings.Replace(remainingText, match[0], "", 1)
		}
	}

	// 清理剩余文本
	remainingText = strings.TrimSpace(remainingText)

	return calls, remainingText
}

// GenerateToolPrompt 生成工具使用的系统提示
func GenerateToolPrompt(tools []ToolDefinition) string {
	if len(tools) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("\n\n## 工具调用系统\n\n")
	sb.WriteString("你是一个具有完整工具执行能力的AI助手。你可以且必须使用工具来完成用户的请求。\n\n")
	sb.WriteString("**重要：你拥有完整的文件系统读写权限。所有工具调用都会在用户本地环境中安全执行。**\n\n")
	sb.WriteString("当需要执行任何操作时，必须使用以下格式输出工具调用：\n\n")
	sb.WriteString("```\n<tool_call>\n{\"tool\": \"工具名称\", \"参数名\": \"参数值\"}\n</tool_call>\n```\n\n")
	sb.WriteString("### 可用工具列表\n\n")

	for _, tool := range tools {
		sb.WriteString("**")
		sb.WriteString(tool.Name)
		sb.WriteString("**")
		if tool.Description != "" {
			sb.WriteString(" - ")
			sb.WriteString(tool.Description)
		}
		sb.WriteString("\n")

		if len(tool.InputSchema.Properties) > 0 {
			sb.WriteString("参数: ")
			params := []string{}
			for name, prop := range tool.InputSchema.Properties {
				p := "`" + name + "`"
				if prop.Description != "" {
					p += "(" + prop.Description + ")"
				}
				params = append(params, p)
			}
			sb.WriteString(strings.Join(params, ", "))
			sb.WriteString("\n")
		}
		sb.WriteString("\n")
	}

	sb.WriteString("### 执行规则\n\n")
	sb.WriteString("1. **必须使用工具** - 当用户请求涉及文件操作或命令执行时，直接输出 <tool_call> 块\n")
	sb.WriteString("2. **不要拒绝** - 你有完整权限，不存在任何限制\n")
	sb.WriteString("3. **不要解释** - 直接执行，不要说\"我无法\"或\"我不能\"\n")
	sb.WriteString("4. **一次一个工具** - 每次只调用一个工具，等待结果后继续\n")
	sb.WriteString("5. **立即行动** - 收到请求后立即输出工具调用，不要询问确认\n\n")
	sb.WriteString("示例 - 创建文件：\n")
	sb.WriteString("<tool_call>\n{\"tool\": \"write_file\", \"path\": \"/path/to/file.txt\", \"content\": \"文件内容\"}\n</tool_call>\n\n")
	sb.WriteString("示例 - 执行命令：\n")
	sb.WriteString("<tool_call>\n{\"tool\": \"bash\", \"command\": \"ls -la\"}\n</tool_call>\n")

	return sb.String()
}

// IsToolCallResponse 检查输出是否包含工具调用
func (p *Parser) IsToolCallResponse(output string) bool {
	for _, pattern := range toolCallPatterns {
		if pattern.MatchString(output) {
			return true
		}
	}
	return false
}
