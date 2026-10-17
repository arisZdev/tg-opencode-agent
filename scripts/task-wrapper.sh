#!/usr/bin/env bash
# OpenCode agent wrapper
# Runs opencode on GitHub Actions and relays messages/files between
# the user (Telegram, via the Cloudflare worker) and the agent.
set -uo pipefail

: "${WORKER_URL:?WORKER_URL missing}" "${TASK_ID:?TASK_ID missing}" \
  "${TASK_TOKEN:?TASK_TOKEN missing}" "${MODEL:?MODEL missing}" "${PROMPT:?PROMPT missing}"

API="$WORKER_URL/agent"
AH=(-H "Authorization: Bearer $TASK_TOKEN" -H "X-Task-Id: $TASK_ID")
POLL_S=15
RUN_COUNT=0
KILL=false
END=false
FUPS="[]"
OUT=""
RC=0
LAST_HB="$(date +%s)"
LAST_ACT="$(date +%s)"
HB_MIN=15
IDLE_MIN=60

cfg="$(curl -sf "$API/config" "${AH[@]}")" || { echo "FATAL: cannot fetch config"; exit 1; }
OC_KEY="$(echo "$cfg" | jq -r '.opencode_key')"
HB_MIN="$(echo "$cfg" | jq -r '.heartbeat_min // 15')"
IDLE_MIN="$(echo "$cfg" | jq -r '.idle_min // 60')"
export OPENCODE_API_KEY="$OC_KEY"

mkdir -p "$HOME/.config/opencode"
cat > "$HOME/.config/opencode/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "permission": { "edit": "allow", "bash": "allow", "webfetch": "allow" },
  "share": "disabled",
  "provider": { "opencode": { "options": { "apiKey": "$OC_KEY" } } }
}
JSON

mkdir -p work && cd work
cp -f ../AGENTS.md . 2>/dev/null || true
git init -q . 2>/dev/null || true
git config user.email agent@local 2>/dev/null || true
git config user.name agent 2>/dev/null || true
git add -A >/dev/null 2>&1 || true
git commit -qm init >/dev/null 2>&1 || true

jpost() { curl -sf -X POST "$API/$1" "${AH[@]}" -H 'Content-Type: application/json' -d "$2" >/dev/null 2>&1 || true; }
post_msg()  { jpost message "$(jq -cn --arg t "$1" '{text:$t}')"; }
post_done() { jpost done    "$(jq -cn --arg t "${1:-}" '{text:$t}')"; }
post_fail() { jpost fail    "$(jq -cn --arg t "${1:-agent error}" '{text:$t}')"; }
hb_now()    { jpost status  "⏳ هنوز در حال اجراست..."; }

poll() {
  local r
  r="$(curl -sf "$API/poll" "${AH[@]}" 2>/dev/null || echo '{}')"
  KILL="$(echo "$r" | jq -r '.kill // false')"
  END="$(echo "$r" | jq -r '.end // false')"
  FUPS="$(echo "$r" | jq -c '.followups // []')"
}

hb_due() { [ $(( $(date +%s) - LAST_HB )) -ge $(( HB_MIN * 60 )) ]; }

# run opencode with kill/end monitoring; results in OUT/RC
run_oc() {
  local msg="$1" outfile errfile pid
  outfile="$(mktemp)"; errfile="$(mktemp)"
  local -a args=(run --model "$MODEL")
  [ "$RUN_COUNT" -gt 0 ] && args+=(--continue)
  opencode "${args[@]}" "$msg" >"$outfile" 2>"$errfile" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$POLL_S"
    poll
    if [ "$KILL" = "true" ]; then
      pkill -9 -f opencode 2>/dev/null; kill -9 "$pid" 2>/dev/null
      RC=130; OUT=""; return
    fi
    if [ "$END" = "true" ]; then
      pkill -9 -f opencode 2>/dev/null; kill -9 "$pid" 2>/dev/null
      RC=143; OUT=""; return
    fi
    if hb_due; then hb_now; LAST_HB="$(date +%s)"; fi
  done
  wait "$pid" 2>/dev/null
  RC=$?
  OUT="$(cat "$outfile")"
  rm -f "$outfile" "$errfile"
  RUN_COUNT=$((RUN_COUNT + 1))
}

finish_run_output() {
  if [ "$RC" = "130" ]; then
    post_msg "🛑 اجرای عامل متوقف شد (کیل)."
    post_done "killed by user"
    exit 0
  fi
  if [ "$RC" = "143" ]; then
    post_msg "🏁 اجرای عامل به درخواست شما پایان یافت."
    post_done "ended by user"
    exit 0
  fi
  if [ "$RC" -ne 0 ]; then
    post_msg "⚠️ عامل با خطا خارج شد (کد $RC)."
    post_fail "opencode exit code $RC"
    exit 1
  fi
  if [ -n "$OUT" ]; then post_msg "$OUT"; else post_msg "(پاسخ متنی خالی بود)"; fi
  LAST_ACT="$(date +%s)"
}

# download followup files listed in $FUPS into ./uploads
dl_followup_files() {
  mkdir -p uploads
  local name url
  while IFS=$'\t' read -r name url; do
    [ -z "${url:-}" ] && continue
    curl -sf "$url" "${AH[@]}" -o "uploads/$name" && echo "uploads/$name"
  done < <(echo "$FUPS" | jq -r '.[] | .files[]? | [.name, .url] | @tsv' 2>/dev/null)
}

apply_followups() {
  local txt paths msg
  txt="$(echo "$FUPS" | jq -r '[.[] | select(.text != null and .text != "") | .text] | join("\n---\n")' 2>/dev/null)"
  paths="$(dl_followup_files | tr '\n' ' ')"
  msg="📩 پیام جدید کاربر:"
  [ -n "$txt" ] && msg="$msg
$txt"
  [ -n "${paths// /}" ] && msg="$msg
فایل‌های جدید (ذخیره‌شده در): $paths"
  LAST_ACT="$(date +%s)"
  post_msg "🔄 پیام جدید رسید؛ عامل ادامه می‌ده..."
  run_oc "$msg"
  finish_run_output
}

# ---------- main ----------
jpost register "{\"run_id\":${GITHUB_RUN_ID:-0}}"
post_msg "▶️ شروع تسک با مدل $MODEL"

run_oc "$PROMPT"
finish_run_output

# followup / idle loop
while true; do
  sleep "$POLL_S"
  poll
  if [ "$KILL" = "true" ]; then
    post_msg "🛑 تسک متوقف شد."
    post_done "killed by user"
    exit 0
  fi
  if [ "$END" = "true" ]; then
    post_msg "🏁 تسک بسته شد."
    post_done "ended by user"
    exit 0
  fi
  if [ "$FUPS" != "[]" ]; then
    apply_followups
    continue
  fi
  if hb_due; then hb_now; LAST_HB="$(date +%s)"; fi
  if [ $(( $(date +%s) - LAST_ACT )) -ge $(( IDLE_MIN * 60 )) ]; then
    post_msg "✅ $IDLE_MIN دقیقه پیام جدیدی نرسید؛ تسک بسته شد. برای کار جدید /new"
    post_done "idle timeout"
    exit 0
  fi
done
