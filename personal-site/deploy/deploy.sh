#!/usr/bin/env bash
# 今日食签 v0.5 — 后端一键部署（Cloudflare Worker）
# 用法：
#   1) 复制本文件旁边的 deploy.env.example 为 deploy.env，填好两个值
#   2) bash deploy.sh
# 幂等：KV 已存在则复用，不重复创建。
set -euo pipefail

cd "$(dirname "$0")"
DEPLOY_DIR="$(pwd)"
ROOT="$(cd .. && pwd)"          # personal-site/
ENVF="deploy.env"

# 定位后端源码目录（wrangler.toml 所在处）。部署必须在那个目录执行，
# 否则 npx wrangler 找不到配置、也找不到 src/。
BACKEND_DIR=""
for c in "$ROOT/backend" "../backend" "backend"; do
  [ -f "$c/wrangler.toml" ] && BACKEND_DIR="$(cd "$c" && pwd)" && break
done

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; NC=$'\033[0m'
say() { printf '%s==>%s %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '%s[!]%s %s\n' "$YEL" "$NC" "$*"; }
die() { printf '%s[x]%s %s\n' "$RED" "$NC" "$*"; exit 1; }

# ── 0. 读配置 ────────────────────────────────────────────────────────
[ -f "$ENVF" ] || die "缺少 $ENVF。先执行：cp deploy.env.example deploy.env 然后填值"
# shellcheck disable=SC1090
set -a; . "./$ENVF"; set +a

: "${CLOUDFLARE_API_TOKEN:?deploy.env 里缺 CLOUDFLARE_API_TOKEN}"
AI_PROVIDER="${AI_PROVIDER:-zhipu}"
case "$AI_PROVIDER" in
  zhipu)    : "${ZHIPU_API_KEY:?deploy.env 里缺 ZHIPU_API_KEY（AI_PROVIDER=zhipu 时必须）}" ;;
  deepseek) : "${DEEPSEEK_API_KEY:?deploy.env 里缺 DEEPSEEK_API_KEY（AI_PROVIDER=deepseek 时必须）}" ;;
  *) die "AI_PROVIDER 只能是 zhipu 或 deepseek，当前：$AI_PROVIDER" ;;
esac
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
WORKER_NAME="${WORKER_NAME:-shiqian-agent}"
KV_BINDING="USAGE"

# ── 1. 环境检查 ────────────────────────────────────────────────────
command -v node >/dev/null || die "没装 node（需要 >= 18）"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node 版本过低：$(node -v)，需要 >= 18"

[ -n "$BACKEND_DIR" ] || die "找不到后端目录（含 wrangler.toml 的 backend/）。请在仓库内的 deploy/ 下执行本脚本"
say "后端目录：$BACKEND_DIR"
cd "$BACKEND_DIR"

if ! command -v wrangler >/dev/null; then
  [ -f "$BACKEND_DIR/package.json" ] || die "没装 wrangler，且后端目录没有 package.json"
  say "未检测到 wrangler，装到后端目录 node_modules（约 30s）"
  ( cd "$BACKEND_DIR" && npm install --no-fund --no-audit ) || die "npm install 失败"
fi
WRANGLER="npx --yes wrangler"
$WRANGLER --version >/dev/null 2>&1 || die "wrangler 不可用，手动执行：npm i -D wrangler@4"

# ── 2. 校验 token 与账户 ─────────────────────────────────────────────
say "校验 Cloudflare API Token"
VERIFY=$(curl -sS --max-time 20 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify || true)
if ! printf '%s' "$VERIFY" | grep -q '"status":"active"'; then
  warn "Token 校验返回：$(printf '%s' "$VERIFY" | head -c 300)"
  die "Token 无效或已过期。需要权限：Workers Scripts:Edit、Workers KV Storage:Edit、Account Settings:Read"
fi
say "Token 有效"

if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  CLOUDFLARE_ACCOUNT_ID=$(curl -sS --max-time 20 \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    https://api.cloudflare.com/client/v4/accounts \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=(j.result||[])[0];if(a)process.stdout.write(a.id)})')
  [ -n "$CLOUDFLARE_ACCOUNT_ID" ] || die "拿不到 Account ID，请在 deploy.env 里显式填 CLOUDFLARE_ACCOUNT_ID"
fi
export CLOUDFLARE_ACCOUNT_ID
say "Account: $CLOUDFLARE_ACCOUNT_ID"

# ── 3. KV 命名空间（幂等）────────────────────────────────────────────
# 幂等策略：以 wrangler.toml 里已填的 id 为准，验证它在本账号下确实存在；
# 不存在（或为空）才去列表里找、最后才新建。避免「按标题找 → 标题对不上 → 每次重复建新命名空间」，
# 那样会悄悄换掉绑定、历史用量归零。
say "检查 KV 命名空间 $KV_BINDING"
TOML_KV_ID=$(sed -nE '/\[\[kv_namespaces\]\]/,/^\[/{s/^[[:space:]]*id[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p}' wrangler.toml | head -1)

NS_LIST=$(curl -sS --max-time 20 \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces?per_page=100" || true)

KV_ID=""
if [ -n "$TOML_KV_ID" ] && printf '%s' "$NS_LIST" | grep -q "\"$TOML_KV_ID\""; then
  KV_ID="$TOML_KV_ID"
  say "复用 wrangler.toml 中已有的 KV（历史用量保留）"
else
  # 兜底：找标题含 binding 名或 spend 的命名空间，避免重复创建
  KV_ID=$(printf '%s' "$NS_LIST" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let j; try{ j=JSON.parse(s) }catch(e){ return }
      const ns=j.result||[];
      const hit=ns.find(x=>x.title===process.argv[1])||ns.find(x=>/spend/i.test(x.title));
      if(hit)process.stdout.write(hit.id);
    })' "$KV_BINDING")
  [ -n "$KV_ID" ] && say "复用已有命名空间"
fi

if [ -z "$KV_ID" ]; then
  say "创建 KV 命名空间 $KV_BINDING"
  KV_ID=$(curl -sS --max-time 20 -X POST \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"title\":\"$KV_BINDING\"}" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){return}const r=j.result||{};if(r.id)process.stdout.write(r.id)})')
  [ -n "$KV_ID" ] || die "KV 创建失败，手动执行 wrangler kv namespace create $KV_BINDING"
fi
say "KV id = $KV_ID"

# 写回 wrangler.toml（只替换 id 那一行，保留注释）
node - "$KV_ID" <<'EOF'
const fs = require('fs');
const id = process.argv[2];
const p = 'wrangler.toml';
let s = fs.readFileSync(p, 'utf8');
const before = s;
s = s.replace(/(\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"USAGE"[\s\S]*?id\s*=\s*")[^"]*(")/, `$1${id}$2`);
if (s === before && !s.includes(id)) { console.error('未能写入 KV id'); process.exit(1); }
fs.writeFileSync(p, s);
EOF
say "wrangler.toml 已更新 KV id"

# ── 4. 推密钥（幂等，覆盖写）───────────────────────────────────────────
write_optional() {  # $1=变量名 $2=值
  [ -n "${2:-}" ] || return 0
  say "写入 $1"
  printf '%s' "$2" | $WRANGLER secret put "$1" >/dev/null
}
write_optional ZHIPU_API_KEY        "${ZHIPU_API_KEY:-}"
write_optional DEEPSEEK_API_KEY     "${DEEPSEEK_API_KEY:-}"
write_optional MEITUAN_TOKEN        "${MEITUAN_TOKEN:-}"
write_optional MEITUAN_TRAVEL_TOKEN "${MEITUAN_TRAVEL_TOKEN:-}"
write_optional SHANGOU_APP_KEY      "${SHANGOU_APP_KEY:-}"
write_optional SHANGOU_APP_SECRET   "${SHANGOU_APP_SECRET:-}"
write_optional SHANGOU_TOKEN        "${SHANGOU_TOKEN:-}"
write_optional SHANGOU_SHOP_ID      "${SHANGOU_SHOP_ID:-}"

# 让 wrangler.toml 的 [vars] 与 deploy.env 保持一致（改 AI 提供商时只改一处）
node - "$AI_PROVIDER" <<'EOF'
const fs = require('fs');
const provider = process.argv[2];
const p = 'wrangler.toml';
let s = fs.readFileSync(p, 'utf8');
const before = s;
s = s.replace(/^AI_PROVIDER\s*=\s*"[^"]*"/m, `AI_PROVIDER = "${provider}"`);
if (s === before && !new RegExp(`AI_PROVIDER\\s*=\\s*"${provider}"`).test(s)) {
  console.error('未能写入 AI_PROVIDER'); process.exit(1);
}
fs.writeFileSync(p, s);
EOF
say "AI_PROVIDER = $AI_PROVIDER"

# ── 5. 部署 ────────────────────────────────────────────────────────
say "部署 Worker：$WORKER_NAME"
DEPLOY_OUT=$($WRANGLER deploy 2>&1) || { printf '%s\n' "$DEPLOY_OUT"; die "部署失败（上面是 wrangler 原始输出）"; }
printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 > "$DEPLOY_DIR/.deployed-url" || true
BASE=$(cat "$DEPLOY_DIR/.deployed-url" 2>/dev/null || true)
[ -n "$BASE" ] || die "部署命令结束但没解析到 workers.dev 地址，请检查 wrangler 输出：\n$DEPLOY_OUT"
say "线上地址：$BASE"

# ── 6. 自检 ────────────────────────────────────────────────────────
say "自检 /api/v1/health"
HEALTH=$(curl -sS --max-time 25 "$BASE/api/v1/health" 2>/dev/null || true)
if [ -z "$HEALTH" ]; then
  warn "自检请求没拿到响应（可能是本机网络到 workers.dev 不通，不影响已完成的部署）"
  warn "请在浏览器打开：$BASE/api/v1/health"
else
printf '%s' "$HEALTH" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try{ j=JSON.parse(s) }catch(e){ console.log("  (非 JSON)"); console.log("  "+s.slice(0,300)); process.exit(0) }
  const st=(v)=> v==="configured" ? "已配置" : (v ? "未配置("+v+")" : "未知");
  const p=j.platforms||{}, b=j.budget||{};
  console.log("  version   :", j.version);
  console.log("  aiProvider:", j.aiProvider);
  console.log("  model     :", j.model);
  console.log("  对话模型  :", st(p.ai));
  console.log("  deepseek  :", st(p.deepseek), j.searchEnabled ? "(联网搜索开启)" : "(联网搜索关闭)");
  console.log("  meituan   :", st(p.meituan));
  console.log("  shangou   :", st(p.shangou));
  console.log("  kvBound   :", j.kvBound);
  console.log("  budget    : 已用 " + b.usedYuan + " / " + b.budgetYuan + " 元，剩 " + b.callsLeft + " 次问答、" + b.searchesLeft + " 次搜索");
  if (!j.kvBound) console.log("  [!] KV 未绑定，限流与预算记账不会生效");
  if (p.ai !== "configured") console.log("  [!] 对话模型未配置，/chat 会返回 503（前端自动降级）");
})'
fi

printf '\n%s完成%s\n' "$GRN" "$NC"
printf 'Worker 地址：%s\n' "$BASE"
printf '%s下一步%s 把这个地址填进 deploy/frontend.conf，然后 bash deploy/frontend.sh\n' "$DIM" "$NC"
printf '%s提示%s 前端只调用 /api/v1，浏览器控制台若报 CORS，检查 wrangler.toml 的 ALLOWED_ORIGINS 是否含站点域名\n' "$DIM" "$NC"
