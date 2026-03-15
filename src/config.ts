import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { AppConfig, VisionProvider } from './types.js';

let config: AppConfig;

export function getConfig(): AppConfig {
    if (config) return config;

    // 默认配置
    config = {
        port: 3010,
        timeout: 120,
        cursorModel: 'anthropic/claude-sonnet-4.6',
        enableThinking: true,
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
    };

    // 从 config.yaml 加载
    if (existsSync('config.yaml')) {
        try {
            const raw = readFileSync('config.yaml', 'utf-8');
            const yaml = parseYaml(raw);
            if (yaml.port) config.port = yaml.port;
            if (yaml.timeout) config.timeout = yaml.timeout;
            if (yaml.proxy) config.proxy = yaml.proxy;
            if (yaml.cursor_model) config.cursorModel = yaml.cursor_model;
            if (yaml.enable_thinking !== undefined) config.enableThinking = yaml.enable_thinking;
            if (yaml.enable_summary !== undefined) config.enableSummary = yaml.enable_summary;
            if (yaml.enable_progressive_truncation !== undefined) config.enableProgressiveTruncation = yaml.enable_progressive_truncation;
            if (yaml.fingerprint) {
                if (yaml.fingerprint.user_agent) config.fingerprint.userAgent = yaml.fingerprint.user_agent;
            }
            if (yaml.vision) {
                // Parse providers array
                let providers: VisionProvider[] = [];
                if (Array.isArray(yaml.vision.providers)) {
                    providers = yaml.vision.providers.map((p: any) => ({
                        name: p.name || '',
                        baseUrl: p.base_url || 'https://api.openai.com/v1/chat/completions',
                        apiKey: p.api_key || '',
                        model: p.model || 'gpt-4o-mini',
                    }));
                } else if (yaml.vision.base_url && yaml.vision.api_key) {
                    // Backward compat: single provider from legacy fields
                    providers = [{
                        name: 'default',
                        baseUrl: yaml.vision.base_url,
                        apiKey: yaml.vision.api_key,
                        model: yaml.vision.model || 'gpt-4o-mini',
                    }];
                }

                config.vision = {
                    enabled: yaml.vision.enabled !== false,
                    mode: yaml.vision.mode || 'ocr',
                    providers,
                    fallbackToOcr: yaml.vision.fallback_to_ocr !== false, // default true
                    baseUrl: yaml.vision.base_url || 'https://api.openai.com/v1/chat/completions',
                    apiKey: yaml.vision.api_key || '',
                    model: yaml.vision.model || 'gpt-4o-mini',
                };
            }
        } catch (e) {
            console.warn('[Config] 读取 config.yaml 失败:', e);
        }
    }

    // 环境变量覆盖
    if (process.env.PORT) config.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) config.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) config.proxy = process.env.PROXY;
    if (process.env.CURSOR_MODEL) config.cursorModel = process.env.CURSOR_MODEL;
    if (process.env.ENABLE_THINKING !== undefined) config.enableThinking = process.env.ENABLE_THINKING !== 'false';
    if (process.env.ENABLE_SUMMARY !== undefined) config.enableSummary = process.env.ENABLE_SUMMARY === 'true';
    if (process.env.ENABLE_PROGRESSIVE_TRUNCATION !== undefined) config.enableProgressiveTruncation = process.env.ENABLE_PROGRESSIVE_TRUNCATION !== 'false';

    // 从 base64 FP 环境变量解析指纹
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.userAgent) config.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 解析 FP 环境变量失败:', e);
        }
    }

    return config;
}
