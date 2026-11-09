/**
 * AI 服务：OpenAI 兼容的 chat/completions，原生 fetch，无 SDK。
 *
 * 配置（环境变量）：
 *   AI_BASE_URL  例如 https://open.bigmodel.cn/api/coding/paas/v4（Coding Plan）
 *                或   https://open.bigmodel.cn/api/paas/v4（标准 API）
 *   AI_API_KEY   Bearer token
 *   AI_MODEL     默认 glm-5.3-flash
 *
 * 原则：所有调用失败（超时、非 200、内容空、JSON 解析失败）一律返回 null，
 * 调用方按「AI 不可用」降级，绝不阻塞主流程。
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 提示词配置化：每个 prompt 一个纯文本文件，放在项目根 prompts/ 目录（可用 PROMPTS_DIR 覆盖）。
 * 按 mtime 热加载：改文件后下一次调用即生效，不需要重启服务。
 * 文件缺失或为空返回 null，调用方按「AI 不可用」降级，主流程不受影响。
 * 注意：prompt 里的输出格式约定（只输出一个 JSON、id 必须在送入集合内等）是代码解析的前提，调优时不要删。
 */
const promptCache = new Map<string, { mtime: number; content: string }>();

export function loadPrompt(name: string): string | null {
  const dir = process.env.PROMPTS_DIR ?? resolve(import.meta.dirname, '../../../prompts');
  const file = join(dir, `${name}.txt`);
  try {
    const st = statSync(file);
    const hit = promptCache.get(name);
    if (hit && hit.mtime === st.mtimeMs) return hit.content;
    const content = readFileSync(file, 'utf8').trim();
    if (!content) return null;
    promptCache.set(name, { mtime: st.mtimeMs, content });
    return content;
  } catch {
    return null;
  }
}

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const DEFAULT_MODEL = 'glm-5.3-flash';

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function aiConfig(): AiConfig | null {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: (process.env.AI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey,
    model: process.env.AI_MODEL ?? DEFAULT_MODEL,
  };
}

export interface ChatOptions {
  system?: string;
  user: string;
  /** 额外的 user 消息内容块（例如图片）。 */
  contentBlocks?: { type: string; [k: string]: unknown }[];
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  /** glm-5.3-flash 是思考型模型，默认关闭思考换低延迟；API 拒绝该参数时自动重试。 */
  thinking?: 'disabled' | 'enabled';
}

/** 单次对话调用，返回文本内容；任何失败返回 null。 */
export async function chat(cfg: AiConfig, opts: ChatOptions): Promise<string | null> {
  const messages: { role: string; content: unknown }[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({
    role: 'user',
    content: opts.contentBlocks ? [...opts.contentBlocks, { type: 'text', text: opts.user }] : opts.user,
  });

  const request = async (withThinking: boolean): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
    try {
      return await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: opts.temperature ?? 0.3,
          max_tokens: opts.maxTokens ?? 1024,
          ...(withThinking ? { thinking: { type: opts.thinking ?? 'disabled' } } : {}),
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await request(true);
    // API 不接受 thinking 参数时（400）去掉重试一次
    if (res.status === 400) {
      const body = await res.text();
      if (body.includes('thinking')) res = await request(false);
      else {
        console.warn(`[ai] HTTP 400: ${body.slice(0, 200)}`);
        return null;
      }
    }
    if (!res.ok) {
      console.warn(`[ai] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim() ? content.trim() : null;
  } catch (e) {
    if (!(e instanceof Error && e.name === 'AbortError')) console.warn('[ai] 调用失败', e);
    return null;
  }
}

/**
 * 从模型输出中提取第一个 JSON 对象。容忍 ```json 代码块、前后缀文字。
 * 解析失败返回 null。不依赖 response_format，兼容所有 OpenAI 兼容端点。
 */
export function extractJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], raw];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1)) as T;
    } catch {
      /* 尝试下一个 */
    }
  }
  return null;
}
