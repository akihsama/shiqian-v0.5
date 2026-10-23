/**
 * DeepSeek 客户端：Chat + Search
 * ---------------------------------------------------------------
 * 只用官方公开接口：
 *   POST https://api.deepseek.com/chat/completions
 *   POST https://api.deepseek.com/v1/tools/search
 * 两者共用 Bearer 鉴权。
 *
 * 模型名用 deepseek-flash（官方当前轻量模型）。
 * 旧别名 deepseek-chat / deepseek-reasoner 官方已公告废弃，不要再写死。
 *
 * 价格（元 / 百万 token，取高峰价保守估算）：
 *   输入 2 / 输出 8；Search 5 元每千次成功请求。
 * 官方有空闲时段半价，所以这里的记账只会**高估**，不会超支。
 */

const BASE = 'https://api.deepseek.com';

/** 用高峰价记账，宁可提前截断 */
const RATE = {
  inputPerM: 2,
  outputPerM: 8,
};

export class DeepSeekError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status || 502;
    this.detail = detail;
  }
}

async function post(path, apiKey, body, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || 20000) : null;
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { msg = JSON.parse(text).error?.message || msg; } catch { /* 原文可能不是 JSON */ }
      throw new DeepSeekError(msg, res.status, text.slice(0, 300));
    }
    try { return JSON.parse(text); }
    catch { throw new DeepSeekError('上游返回的不是 JSON', 502, text.slice(0, 300)); }
  } catch (e) {
    if (e instanceof DeepSeekError) throw e;
    if (e && e.name === 'AbortError') throw new DeepSeekError('上游超时', 504);
    throw new DeepSeekError(e && e.message || '网络错误', 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 一轮对话。返回 { content, model, usage, costMicro } */
export async function deepseekChat({ apiKey, model, messages, maxTokens, temperature, json, timeoutMs }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens || 320,
    temperature: typeof temperature === 'number' ? temperature : 0.85,
    stream: false,
  };
  // 官方支持 JSON 输出；出签用不到，保持关闭以免模型过度结构化
  if (json) body.response_format = { type: 'json_object' };

  const data = await post('/chat/completions', apiKey, body, timeoutMs);
  const choice = (data.choices || [])[0] || {};
  const content = String((choice.message && choice.message.content) || '').trim();
  if (!content) throw new DeepSeekError('模型返回空内容', 502);

  const u = data.usage || {};
  const promptTokens = u.prompt_tokens || 0;
  const completionTokens = u.completion_tokens || 0;
  const costMicro = Math.round(
    promptTokens * RATE.inputPerM + completionTokens * RATE.outputPerM
  );

  return {
    content,
    model: data.model || model,
    usage: { promptTokens, completionTokens, totalTokens: u.total_tokens || 0 },
    costMicro,
  };
}

/**
 * 联网搜索。返回 { results: [...] }，字段见官方文档：
 * title / url / snippet / summary / site_name / date / authority / rerank_score
 */
export async function deepseekSearch({ apiKey, query, count, oriQuestion, timeoutMs }) {
  const body = {
    query: String(query || '').slice(0, 128),
    count: Math.min(Math.max(count || 5, 1), 10),
    need_content: false, // 只要摘要，省 token 也省流量
  };
  if (oriQuestion) body.ori_question = String(oriQuestion).slice(0, 128);

  const data = await post('/v1/tools/search', apiKey, body, timeoutMs || 12000);
  const results = Array.isArray(data.results) ? data.results : [];
  // 简单质量过滤：相关性太低或没有 URL 的直接丢掉
  return {
    results: results.filter(r => r && r.url && (r.rerank_score == null || r.rerank_score >= 0.8)),
  };
}

/** 是否配了 DeepSeek Key（搜索 API 只有这家有，独立于聊天模型选择） */
export function deepseekConfigured(env) {
  return !!(env && env.DEEPSEEK_API_KEY);
}
