/**
 * 智谱 GLM 客户端（OpenAI 兼容协议）
 * ---------------------------------------------------------------
 *   POST https://open.bigmodel.cn/api/paas/v4/chat/completions
 *   Authorization: Bearer <ZHIPU_API_KEY>
 *
 * 默认模型 glm-4.7-flash：输入输出全免费、不限量，官方定位长期产品。
 * 免费层的限制在并发（约 1 路），连发请求会撞 429（code 1305）。
 * 这里对 429/500/503/504 做 0/1.2s/2.6s 三段退避，约 4 秒内仍失败就老实上报，
 * 由前端降级本地食神——比悄悄拖 20 秒再超时体验好得多。
 *
 * 计费：免费模型成本记 0；若把 MODEL 换成付费型号，用下面的 RATE 兜底估算，
 * 宁可高估也不让预算闸门失效。
 */

const BASE = 'https://open.bigmodel.cn/api/paas/v4';

/** 付费型号的保守估价（元 / 百万 token）。glm-4.7-flash 命中免费名单时为 0 */
const PAID_RATE = {
  inputPerM: 4,
  outputPerM: 16,
};

/** 已知免费型号（前缀匹配，型号带日期后缀也能命中） */
const FREE_PATTERNS = [/^glm-.*flash/i, /^glm-4\.5-air/i, /^glm-z1-flash/i];

export class ZhipuError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ZhipuError';
    this.status = status || 502;
    this.detail = detail;
  }
}

export const zhipuError = ZhipuError;

export function zhipuConfigured(env) {
  return !!(env && env.ZHIPU_API_KEY);
}

export function isFreeModel(model) {
  return FREE_PATTERNS.some(re => re.test(String(model || '')));
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
      try {
        const j = JSON.parse(text);
        msg = (j.error && (j.error.message || j.error.code)) || j.message || msg;
      } catch { /* 非 JSON，保留原始状态码 */ }
      throw new ZhipuError(msg, res.status, text.slice(0, 300));
    }
    try { return JSON.parse(text); }
    catch { throw new ZhipuError('上游返回的不是 JSON', 502, text.slice(0, 300)); }
  } catch (e) {
    if (e instanceof ZhipuError) throw e;
    if (e && e.name === 'AbortError') throw new ZhipuError('上游超时', 504);
    throw new ZhipuError((e && e.message) || '网络错误', 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 一轮对话。返回 { content, model, usage, costMicro } */
export async function zhipuChat({ apiKey, model, messages, maxTokens, temperature, json, timeoutMs, thinking }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens || 320,
    temperature: typeof temperature === 'number' ? temperature : 0.85,
    stream: false,
  };
  // GLM-4.5 起默认开启思考模式，reasoning 与 content 共用 max_tokens。
  // 实测：320 的预算会被思考吃光，content 返回空串（finish_reason=length）。
  // 出签不需要推理链，一律关闭；实测同样提示词 28 token 出完，1.3s。
  body.thinking = { type: thinking === 'enabled' ? 'enabled' : 'disabled' };
  if (json) body.response_format = { type: 'json_object' };

  // 免费档并发约 1 路，连续提问很容易撞上 429（code 1305）。
  // 服务端做三段退避（0 / 1.2s / 2.6s），约 4 秒内仍失败就老实上报，
  // 比让用户干等 20 秒再超时体验好。401/400 这类不可恢复错误立即失败。
  const delays = [0, 1200, 2600];
  let lastErr = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt]);
    try {
      const data = await post('/chat/completions', apiKey, body, timeoutMs);
      return await extract(data, model, maxTokens, apiKey, body, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === delays.length - 1) throw e;
    }
  }
  throw lastErr;
}

/** 只有限流、上游故障、超时值得重试；鉴权/参数错误重试只是浪费额度 */
function isRetryable(e) {
  if (!(e instanceof ZhipuError)) return false;
  return e.status === 429 || e.status === 503 || e.status === 500 || e.status === 504;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 从一次成功的响应里取正文；正文为空但有 reasoning 时翻倍预算再要一次 */
async function extract(data, fallbackModel, maxTokens, apiKey, body, timeoutMs) {
  const choice = (data.choices || [])[0] || {};
  const message = choice.message || {};
  const content = String(message.content || '').trim();
  if (content) return finish(data, fallbackModel, content);

  if (message.reasoning_content) {
    const retry = await post('/chat/completions', apiKey, Object.assign({}, body, {
      max_tokens: Math.max((maxTokens || 320) * 2, 512),
    }), timeoutMs);
    const c2 = (retry.choices || [])[0] || {};
    const content2 = String((c2.message && c2.message.content) || '').trim();
    if (content2) return finish(retry, fallbackModel, content2);
  }
  throw new ZhipuError('模型返回空内容', 502);
}

function finish(data, fallbackModel, content) {
  const u = data.usage || {};
  const promptTokens = u.prompt_tokens || 0;
  const completionTokens = u.completion_tokens || 0;
  const usedModel = data.model || fallbackModel;
  return {
    content,
    model: usedModel,
    usage: { promptTokens, completionTokens, totalTokens: u.total_tokens || 0 },
    costMicro: isFreeModel(usedModel)
      ? 0
      : Math.round(promptTokens * PAID_RATE.inputPerM + completionTokens * PAID_RATE.outputPerM),
  };
}
