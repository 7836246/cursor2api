# 构建阶段
FROM golang:1.24-alpine AS builder

WORKDIR /app

# 安装构建依赖
RUN apk add --no-cache git

# 复制依赖文件
COPY go.mod go.sum ./
RUN go mod download

# 复制源代码
COPY . .

# 构建
RUN CGO_ENABLED=0 GOOS=linux go build -o cursor2api ./cmd/server

# 运行阶段
FROM alpine:3.19

WORKDIR /app

# 安装 Chromium 和必要的依赖
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-cjk \
    && rm -rf /var/cache/apk/*

# 设置 Chromium 环境变量
ENV BROWSER_PATH=/usr/bin/chromium-browser
ENV CHROME_BIN=/usr/bin/chromium-browser

# 复制二进制文件
COPY --from=builder /app/cursor2api .
COPY --from=builder /app/config.yaml .
COPY --from=builder /app/static ./static

# 创建非 root 用户
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app

# 注意：Chromium 需要以特殊方式运行，暂时使用 root
# USER appuser

EXPOSE 3010

CMD ["./cursor2api"]
