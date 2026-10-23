/**
 * AI 提供商抽象层
 * ---------------------------------------------------------------
 * 上层（worker.js）只认这里导出的名字，不再直接绑定某一家：
 *   aiChat({...})   → { content, model, provider, usage, costMicro }
 *   aiSearch({...}) → { results:[{title,url,site_name,summary,snippet}] }
 *   aiConfigured(env) / aiProviderName(env) / aiModelName(env, config) / aiSearchSupported(env)
 *
 * 选哪家由环境变量 AI_PROVIDER 决定：
 *   zhipu（默认） 智谱 GLM-4.7-Flash，输入输出全免费
 *   deepseek      DeepSeek flash，按 token 计费
 * 两家 chat 都是 OpenAI 兼容协议，差别只在地址、鉴权和模型名，
 * 真正不同的只有 deepseek.js / zhipu.js 里的适配与记账。
 */

import { zhipuChat, zhipuConfigured, ZhipuError } from './zhipu.js';
import { deepseekChat, deepseekSearch, deepseekConfigured, DeepSeekError } from './deepseek.js';

export function aiProviderName(env) {
  const p = String((env && env.AI_PROVIDER) || '').trim().toLowerCase();
  return p === 'deepseek' ? 'deepseek' : 'zhipu';
}

/** 该提供商需要的 Key 是否已配置 */
export function aiConfigured(env) {
  return aiProviderName(env) === 'deepseek' ? deepseekConfigured(env) : zhipuConfigured(env);
}

/** health 里给人看的缺失提示 */
export function aiMissingHint(env) {
  return aiProviderName(env) === 'deepseek' ? 'missing_deepseek_key' : 'missing_zhipu_key';
}

/**
 * 实际生效的模型名。
 * config.MODEL 来自 wrangler.toml 的 [vars]；如果它明显是另一家的模型名，
 * 以当前提供商的默认值为准，避免「切了家忘了改模型名」导致 400。
 */
export function aiModelName(env, config) {
  const provider = aiProviderName(env);
  const wanted = (config && config.MODEL) || '';
  if (provider === 'deepseek') {
    return /^deepseek/i.test(wanted) ? wanted : 'deepseek-flash';
  }
  return /^(glm|charglm)/i.test(wanted) ? wanted : 'glm-4.7-flash';
}

/**
 * 当前提供商是否支持联网搜索。
 * 智谱的联网检索在部分免费模型上不开放，硬调只会静默失败还占时间；
 * 这里显式关掉，交给「平台真实商品 + 本地食神」兜底。
 */
export function aiSearchSupported(env) {
  return aiProviderName(env) === 'deepseek';
}

export async function aiChat(opts) {
  const provider = aiProviderName(opts.env);
  const model = aiModelName(opts.env, opts.config);

  if (provider === 'deepseek') {
    const res = await deepseekChat({
      apiKey: opts.env.DEEPSEEK_API_KEY,
      model,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      json: opts.json,
      timeoutMs: opts.timeoutMs,
    });
    return Object.assign({ provider: 'deepseek' }, res);
  }

  const res = await zhipuChat({
    apiKey: opts.env.ZHIPU_API_KEY,
    model,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    json: opts.json,
    timeoutMs: opts.timeoutMs,
  });
  return Object.assign({ provider: 'zhipu' }, res);
}

export async function aiSearch(opts) {
  if (!aiSearchSupported(opts.env)) return { results: [] };
  return deepseekSearch({
    apiKey: opts.env.DEEPSEEK_API_KEY,
    query: opts.query,
    count: opts.count,
    oriQuestion: opts.oriQuestion,
    timeoutMs: opts.timeoutMs,
  });
}

export { DeepSeekError, ZhipuError };
