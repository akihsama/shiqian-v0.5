/**
 * 食神提示词（Prompt）
 * ---------------------------------------------------------------
 * 三条硬约束，都是为了「签要能落地」：
 *   1. 必须用【菜名】标出推荐，前端靠这个解析，稳定比花哨重要
 *   2. 优先从附近真实商品里选，其次签库，实在没有才自由发挥
 *   3. 不超过 80 字、不许寒暄、不许列大段清单（手机上一屏要看得完）
 *
 * 联网摘要（webDigest）作为"参考资料"注入，而不是让它自由编店名。
 */

const FORTUNES = ['大吉', '中吉', '吉', '小吉'];

export function buildSystemPrompt(ctx, nearby, webDigest) {
  ctx = ctx || {};
  const city = ctx.city || '';
  const current = ctx.currentFood ? ctx.currentFood.name : '';
  const foods = (ctx.foods || []).map(f => f.name).slice(0, 60);
  const nearbyList = (nearby || [])
    .slice(0, 15)
    .map((p, i) => `${i + 1}. ${p.name}${p.price ? ' ¥' + p.price : ''}${p.shop ? '@' + p.shop : ''}（${p.source === 'shangou' ? '闪购' : '美团'}）`)
    .join('\n');

  const lines = [
    '你是「今日食签」的食神：懂吃、说话干脆、会安慰人，但不啰嗦。',
    city ? `用户所在城市：${city}。` : '',
    current ? `用户刚摇到的签是【${current}】，可以顺势点评一句。` : '',
    '',
    '推荐顺序（严格遵守）：',
    nearbyList
      ? '① 优先从「附近真实商品」里选一项，用它的菜名做【菜名】；② 都不合适再从签库选；③ 实在没有才自由发挥。'
      : '① 优先从签库选；② 没有合适的再自由发挥。',
    nearbyList ? '\n【附近真实商品】\n' + nearbyList : '',
    webDigest ? '\n【联网参考资料】\n' + webDigest : '',
    foods.length ? '\n【签库】' + foods.join('、') : '',
    '',
    '输出格式（不要 Markdown、不要标题、不要编号列表）：',
    '第一行：用【菜名】标出推荐，后面跟一句不超过 30 字的两句理由。',
    '第二行：一句不超过 18 字的签语。',
    '总字数不超过 80 字。不要提"根据搜索结果"之类的话。',
    '如果联网资料里有具体门店/团购价，可以点出店名和价格，但不要编造。',
  ];
  return lines.filter(l => l !== '').join('\n');
}

export function buildUserPrompt(question) {
  return String(question || '').slice(0, 300);
}

/**
 * 从回复里抽 { foodName, fortune, blessing }。
 * 抽不到就返回 null，交给 fallbackRecommendation 兜底，绝不抛错。
 */
export function parseRecommendation(reply) {
  const text = String(reply || '');
  const m = text.match(/【([^】]{1,24})】/);
  if (!m) return null;

  const foodName = m[1].trim();
  const after = text.slice(m.index + m[0].length);

  // 理由：取【】后面到换行为止
  const reason = (after.split('\n')[0] || '').replace(/^[：:，,。\s]+/, '').trim().slice(0, 60);

  // 签语：最后一句非空行
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const blessing = (lines.length > 1 ? lines[lines.length - 1] : '').slice(0, 40) || '顺心顺口，刚刚好';

  return {
    foodName,
    reason,
    blessing,
    fortune: pickFortune(text + foodName),
    emoji: guessEmoji(foodName),
  };
}

export function fallbackRecommendation(reply, nearby) {
  if (nearby && nearby.length) {
    const p = nearby[0];
    return {
      foodName: p.name.split(/[（(]/)[0].trim().slice(0, 20),
      reason: '附近就能买到，价格也合适。',
      blessing: '顺路顺口，皆大欢喜',
      fortune: '吉',
      emoji: '🍽️',
    };
  }
  return {
    foodName: '今天想吃的',
    reason: '食神没接上话，你自己心里其实有答案。',
    blessing: '随心而食，自有滋味',
    fortune: '小吉',
    emoji: '🍚',
  };
}

function pickFortune(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return FORTUNES[h % FORTUNES.length];
}

const EMOJI_HINTS = [
  [/面|粉|米线|拉面|意面/, '🍜'],
  [/火锅|锅/, '🍲'],
  [/寿司|刺身|日料/, '🍣'],
  [/烧烤|烤肉|串/, '🍢'],
  [/鸡/, '🍗'],
  [/鱼|川菜|水煮/, '🐟'],
  [/火锅|麻辣|川/, '🌶️'],
  [/饭|盖饭|炒饭|煲仔/, '🍚'],
  [/饺|小笼|包|馄饨/, '🥟'],
  [/奶茶|茶|咖啡/, '🧋'],
  [/甜|蛋糕|冰淇淋|雪糕/, '🍰'],
  [/粥/, '🥣'],
];

function guessEmoji(name) {
  for (const [re, emoji] of EMOJI_HINTS) {
    if (re.test(name)) return emoji;
  }
  return '🍽️';
}
