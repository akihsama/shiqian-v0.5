#!/usr/bin/env bash
# 部署前预检：不联网、不花钱，30 秒内告出所有会让你卡住的问题。
# 用法：bash preflight.sh
set -uo pipefail
cd "$(dirname "$0")"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; NC=$'\033[0m'
PASS=0; FAILN=0; WARNN=0
ok()   { printf '  %s✓%s %s\n' "$GRN" "$NC" "$*"; PASS=$((PASS+1)); }
bad()  { printf '  %s✗%s %s\n' "$RED" "$NC" "$*"; FAILN=$((FAILN+1)); }
wr()   { printf '  %s!%s %s\n' "$YEL" "$NC" "$*"; WARNN=$((WARNN+1)); }
hdr()  { printf '\n%s%s%s\n' "$DIM" "$*" "$NC"; }

ROOT="$(cd .. && pwd)"
BACKEND=""
for c in "$ROOT/backend" "../backend" "backend"; do
  [ -f "$c/worker.js" ] && BACKEND="$c" && break
done

hdr "1) 工具链"
command -v node >/dev/null && ok "node $(node -v)" || bad "没装 node"
command -v npm  >/dev/null && ok "npm $(npm -v)"   || bad "没装 npm"
command -v curl >/dev/null && ok "curl 就绪"        || bad "没装 curl"

hdr "2) 后端源码"
if [ -z "$BACKEND" ]; then
  bad "找不到 personal-site/backend（请在 deploy/ 目录下执行）"
else
  ok "后端目录：$BACKEND"
  if ( cd "$BACKEND" && node --test test/*.test.mjs >/tmp/_pf_test.log 2>&1 ); then
    ok "单测 $(grep -oE '# pass [0-9]+' /tmp/_pf_test.log | head -1) 全过"
  else
    bad "单测失败：$(grep -E '^not ok|# fail' /tmp/_pf_test.log | head -3 | tr '\n' ' ')"
  fi
  ERRS=0
  while IFS= read -r f; do
    node --check "$f" >/dev/null 2>&1 || { bad "语法错误：$f"; ERRS=$((ERRS+1)); }
  done < <(find "$BACKEND" -name '*.js' -o -name '*.mjs' | grep -v node_modules)
  [ "$ERRS" -eq 0 ] && ok "全部 JS 语法检查通过"
fi

hdr "3) 配置文件"
if [ -f deploy.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./deploy.env; set +a
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && ok "CLOUDFLARE_API_TOKEN 已填（${#CLOUDFLARE_API_TOKEN} 字符）" || bad "CLOUDFLARE_API_TOKEN 为空"
  P="${AI_PROVIDER:-zhipu}"
  case "$P" in
    zhipu)
      ok "AI_PROVIDER=zhipu（免费档）"
      [ -n "${ZHIPU_API_KEY:-}" ] && ok "ZHIPU_API_KEY 已填（${#ZHIPU_API_KEY} 字符）" || bad "ZHIPU_API_KEY 为空（选智谱时必填）"
      [ -n "${DEEPSEEK_API_KEY:-}" ] && ok "DEEPSEEK_API_KEY 已填 → 会启用联网搜索" || wr "没填 DeepSeek Key → 关闭联网搜索（免费档本来也不带搜索，属正常）"
      ;;
    deepseek)
      ok "AI_PROVIDER=deepseek（按 token 计费）"
      [ -n "${DEEPSEEK_API_KEY:-}" ] && ok "DEEPSEEK_API_KEY 已填（${#DEEPSEEK_API_KEY} 字符）" || bad "DEEPSEEK_API_KEY 为空（选 DeepSeek 时必填）"
      case "${DEEPSEEK_API_KEY:-}" in sk-*) ok "DeepSeek Key 前缀正常" ;; "") ;; *) wr "DeepSeek Key 不是 sk- 开头，确认下没贴错" ;; esac
      ;;
    *) bad "AI_PROVIDER=$P 不认识，只能是 zhipu 或 deepseek" ;;
  esac
  [ -n "${MEITUAN_TOKEN:-}" ] && ok "美团 token 已填（选填项）" || wr "没填美团 token → 面板会显示「美团 · 不可用」"
  if [ -n "${SHANGOU_APP_KEY:-}" ] && [ -z "${SHANGOU_SHOP_ID:-}" ]; then
    wr "填了闪购 app_key 但没填 SHANGOU_SHOP_ID → 仍会显示「待配置」（开放平台按门店查商品）"
  fi
else
  wr "没有 deploy.env（cp deploy.env.example deploy.env 后填值）"
fi

if [ -f frontend.conf ] && grep -q '^WORKER_URL=https://' frontend.conf; then
  ok "frontend.conf 已填 $(grep '^WORKER_URL=' frontend.conf | cut -d= -f2-)"
else
  wr "frontend.conf 还没填 Worker 地址（部署完再填）"
fi

hdr "4) wrangler.toml"
if [ -n "$BACKEND" ]; then
  TOML="$BACKEND/wrangler.toml"
  grep -q 'binding = "USAGE"' "$TOML" && ok "KV binding = USAGE" || bad "KV binding 不是 USAGE"
  KV=$(grep -E '^\s*id\s*=\s*"' "$TOML" | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
  [ ${#KV} -eq 32 ] && ok "KV id 格式正确（32 位）" || bad "KV id 长度 ${#KV}，应为 32 位"
  grep -q 'nodejs_compat' "$TOML" && ok "compatibility_flags 含 nodejs_compat" || bad "缺 nodejs_compat"
  grep -q 'ALLOWED_ORIGINS' "$TOML" && ok "ALLOWED_ORIGINS 已设：$(grep ALLOWED_ORIGINS "$TOML" | cut -d'"' -f2)" || wr "没设 ALLOWED_ORIGINS，默认放行所有来源"
fi

hdr "5) 网络"
curl -s -o /dev/null --connect-timeout 8 --max-time 15 -w '  api.cloudflare.com: %{http_code} (%{time_total}s)\n' \
  https://api.cloudflare.com/client/v4/user/tokens/verify 2>/dev/null || wr "连不上 api.cloudflare.com（部署会失败）"

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ -n "$BACKEND" ]; then
  TOML_KV_ID=$(sed -nE '/\[\[kv_namespaces\]\]/,/^\[/{s/^[[:space:]]*id[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p}' "$BACKEND/wrangler.toml" | head -1)
  NS=$(curl -sS --max-time 15 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces?per_page=100" 2>/dev/null || true)
  if [ -z "$NS" ]; then
    wr "查不到 KV 命名空间列表（跳过绑定校验）"
  elif printf '%s' "$NS" | grep -q "\"$TOML_KV_ID\""; then
    ok "KV id 在本账号下存在，用量数据不会丢"
  else
    bad "wrangler.toml 的 KV id=$TOML_KV_ID 在本账号下不存在 → 部署后记账会失败"
  fi
fi

hdr "6) 仓库状态"
if command -v git >/dev/null && [ -n "$BACKEND" ] && git -C "$BACKEND" rev-parse >/dev/null 2>&1; then
  BR=$(git -C "$BACKEND" rev-parse --abbrev-ref HEAD)
  ok "当前分支 $BR"
  if git -C "$BACKEND" diff --quiet HEAD -- . 2>/dev/null; then ok "工作区干净，无未提交改动"; else wr "工作区有未提交改动（部署用的是磁盘上的文件，不是 HEAD）"; fi
fi

printf '\n%s结果：%d 通过 / %d 警告 / %d 失败%s\n' "$GRN" "$PASS" "$WARNN" "$FAILN" "$NC"
[ "$FAILN" -eq 0 ] || exit 1
