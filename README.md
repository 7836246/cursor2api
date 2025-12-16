# Cursor2API

将 Cursor API 转换为 OpenAI/Anthropic 兼容格式的代理服务。

## 原理

本项目利用 [Cursor 文档页面](https://cursor.com/cn/docs) 提供的免费 AI 聊天功能。该页面内置了一个 AI 助手，通过 `https://cursor.com/api/chat` 接口与后端通信。

**关键特点：**
- **无需登录** - 文档页面的 AI 聊天功能对所有访问者开放
- **无需 API Key** - 不需要 Cursor 账号或付费订阅
- **支持多模型** - 可使用 Claude、GPT、Gemini 等模型

本项目通过浏览器自动化技术访问该页面，将请求转发到 Cursor API，并将响应转换为标准的 OpenAI/Anthropic API 格式。

**⚠️ 重要说明：** Cursor 文档页的 AI 助手基于 Inkeep 技术（类似 Claude Docs），是一个**只读的文档问答系统**，不支持原生的工具调用（Tool Use）。这意味着：
- ❌ AI 无法直接执行命令或写入文件
- ❌ 不支持 Anthropic 原生的 `tool_use` 协议
- ✅ 本项目通过**自动执行模式**解决此限制（见下方说明）

> 💡 **建议开启自动执行模式** (`auto_execute: true`)，可以实现类似工具调用的效果。当 AI 输出命令建议时，系统会自动提取并执行。

## 功能特性

- **Anthropic Messages API** - 完整支持 `/v1/messages` 接口
- **OpenAI Chat API** - 支持 `/v1/chat/completions` 接口
- **流式响应** - 支持 SSE 流式输出
- **浏览器自动化** - 自动处理人机验证
- **Tool Use 协议** - 支持 Anthropic 工具调用协议
- **自动执行模式** - 当 AI 拒绝执行时自动提取并执行命令

## 项目结构

```
cursor2api/
├── cmd/server/          # 程序入口
│   └── main.go
├── internal/            # 内部包
│   ├── browser/         # 浏览器自动化服务
│   ├── config/          # 配置管理
│   └── handler/         # HTTP 处理器
├── static/              # 静态文件
├── config.yaml          # 配置文件
└── README.md
```

## 快速开始

### Docker 部署 (推荐)

```bash
# 使用 docker-compose
docker-compose up -d

# 或者手动构建运行
docker build -t cursor2api .
docker run -d -p 3010:3010 --shm-size=2g cursor2api
```

### 本地运行

```bash
# 安装依赖
go mod tidy

# 编译
go build -o cursor2api ./cmd/server

# 运行
./cursor2api
```

服务默认运行在 `http://localhost:3010`

## 浏览器安装

程序需要 Chromium 内核浏览器。有以下几种方式：

### 方式 1: 自动下载 (推荐)

保持 `config.yaml` 中 `browser.path` 为空，程序会：
1. 首先自动检测系统已安装的 Chrome/Chromium/Edge
2. 如果未找到，则自动下载 Chromium 到 `~/.cache/rod/browser/`

### 方式 2: 使用安装脚本

```bash
# 运行安装脚本
./scripts/setup-browser.sh
```

### 方式 3: 手动安装

**macOS:**
```bash
brew install --cask chromium
# 或
brew install --cask google-chrome
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get update && sudo apt-get install -y chromium-browser
```

**Linux (Alpine):**
```bash
apk add --no-cache chromium
```

### 方式 4: 使用环境变量

```bash
# 指定浏览器路径
export BROWSER_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
./cursor2api
```

## 配置

编辑 `config.yaml`：

```yaml
# 服务端口
port: 3010

# 浏览器设置
browser:
  headless: true
  # 留空则自动检测或下载，也可手动指定路径
  path: ""
  # 自动执行模式（见下方说明）
  auto_execute: true
```

支持的环境变量：
- `PORT` - 覆盖端口配置
- `BROWSER_PATH` - 覆盖浏览器路径
- `AUTO_EXECUTE` - 开关自动执行模式 (`true`/`false`)

## API 接口

### Anthropic Messages API

```bash
curl http://localhost:3010/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### OpenAI Chat API

```bash
curl http://localhost:3010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### 其他接口

- `GET /v1/models` - 获取模型列表
- `GET /health` - 健康检查
- `GET /browser/status` - 浏览器状态

## Claude Code 集成

```bash
# 设置 API 地址
export ANTHROPIC_BASE_URL=http://localhost:3010

# 运行 Claude Code
claude
```

## 自动执行模式

由于 Cursor 文档页的 AI 被设计为只读模式，无法直接执行文件写入、命令执行等操作。本项目实现了**自动执行模式**来解决这个问题。

### 工作原理

1. AI 收到工具调用请求后，会拒绝执行并建议用户手动运行命令
2. 系统检测到拒绝响应后，自动提取 AI 建议的命令
3. 在本地自动执行该命令
4. 将执行结果返回给客户端

### 配置开关

```yaml
# config.yaml
browser:
  auto_execute: true   # 开启自动执行（默认）
  # auto_execute: false  # 关闭自动执行
```

或使用环境变量：

```bash
# 关闭自动执行
AUTO_EXECUTE=false ./cursor2api

# 开启自动执行
AUTO_EXECUTE=true ./cursor2api
```

### 支持的操作

| 操作 | 示例命令 |
|------|----------|
| 创建文件 | `echo "内容" > file.txt` |
| 读取文件 | `cat file.txt` |
| 列出目录 | `ls -la` |
| 创建目录 | `mkdir -p dir` |
| 删除文件 | `rm file.txt` |

### 安全提示

⚠️ **自动执行模式会在本地执行命令，请注意以下安全事项：**

- 仅在可信环境中开启此功能
- AI 可能生成危险命令（如 `rm -rf`）
- 建议在沙箱或容器环境中运行
- 生产环境建议关闭此功能

## Tool Use 协议支持

本项目实现了 Anthropic 的 Tool Use 协议，支持以下工具：

| 工具名称 | 功能 | 参数 |
|----------|------|------|
| `bash` | 执行命令 | `command`, `cwd` |
| `read_file` | 读取文件 | `path` |
| `write_file` | 写入文件 | `path`, `content` |
| `list_dir` | 列出目录 | `path` |
| `edit` | 编辑文件 | `path`, `old_string`, `new_string` |

### 工具接口

```bash
# 列出可用工具
curl http://localhost:3010/tools

# 直接执行工具（调试用）
curl http://localhost:3010/tools/execute \
  -H "Content-Type: application/json" \
  -d '{
    "tool_name": "bash",
    "input": {"command": "ls -la"}
  }'
```

## 支持的模型

| 请求模型 | 映射到 Cursor |
|---------|--------------|
| claude-* | anthropic/claude-sonnet-4.5 |
| gpt-* | openai/gpt-5-nano |
| gemini-* | google/gemini-2.5-flash |

## MCP 服务器

本项目还提供独立的 MCP (Model Context Protocol) 服务器，可供 Claude Desktop、VS Code 等支持 MCP 的客户端使用。

### 编译 MCP 服务器

```bash
go build -o cursor2api-mcp ./cmd/mcp
```

### Claude Desktop 配置

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cursor2api": {
      "command": "/path/to/cursor2api-mcp"
    }
  }
}
```

### MCP 提供的工具

| 工具 | 功能 |
|------|------|
| `bash` | 执行 bash 命令 |
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件内容 |
| `list_dir` | 列出目录内容 |
| `edit` | 编辑文件（查找替换）|

### 测试 MCP 服务器

```bash
# 手动测试
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | ./cursor2api-mcp

# 查看可用工具
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | ./cursor2api-mcp
```

## 依赖

- Go 1.21+
- Chromium 浏览器（API 代理模式需要）

## 免责声明

本项目仅供学习和研究目的使用。

- 本项目是一个非官方的第三方工具，与 Cursor 官方无任何关联
- 使用本项目可能违反 Cursor 的服务条款，请自行承担风险
- 本项目不提供任何形式的担保，包括但不限于适销性、特定用途适用性
- 作者不对使用本项目造成的任何直接或间接损失负责
- 请勿将本项目用于商业用途或任何违法活动

使用本项目即表示您已阅读并同意以上声明。

## 许可证

MIT
