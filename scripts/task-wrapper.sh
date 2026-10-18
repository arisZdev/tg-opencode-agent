#!/usr/bin/env bash
# OpenCode agent wrapper
# Runs opencode on GitHub Actions and relays messages/files between
# the user (Telegram/Bale, via the Cloudflare worker) and the agent.
#
# Runner-window renewal: GitHub kills hosted jobs at ~6h. Shortly before the
# cap (RENEW_MIN, default 330min) the wrapper hands the task to a fresh runner
# via the worker's /agent/renew (which re-dispatches this workflow) and exits.
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
RENEW_MIN=330
START_TS="$(date +%s)"
CUR_MSG=""
CUR_FUPS="[]"
CARRY_TXT=""
CARRY_FILES="[]"

cfg="$(curl -sf "$API/config" "${AH[@]}")" || { echo "FATAL: cannot fetch config"; exit 1; }
OC_KEY="$(echo "$cfg" | jq -r '.opencode_key // ""')"
OR_KEY="$(echo "$cfg" | jq -r '.keys.openrouter // ""')"
GEM_KEY="$(echo "$cfg" | jq -r '.keys.gemini // ""')"
HB_MIN="$(echo "$cfg" | jq -r '.heartbeat_min // 15')"
IDLE_MIN="$(echo "$cfg" | jq -r '.idle_min // 60')"
RENEW_MIN="$(echo "$cfg" | jq -r '.renew_min // 330')"
export OPENCODE_API_KEY="$OC_KEY"
export OPENROUTER_API_KEY="$OR_KEY"
export GEMINI_API_KEY="$GEM_KEY"
export GOOGLE_API_KEY="$GEM_KEY"
export GOOGLE_GENERATIVE_AI_API_KEY="$GEM_KEY"

mkdir -p "$HOME/.config/opencode"
# NOTE: do not add a permission block here — denying any built-in tool makes the
# opencode zen free tier reject requests with FreeTierError
cat > "$HOME/.config/opencode/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
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
renew_due() { [ $(( $(date +%s) - START_TS )) -ge $(( RENEW_MIN * 60 )) ]; }

# hand the task over to a fresh runner and exit cleanly.
# carry_text/carry_files re-deliver the in-flight followup (if any) to the new
# attempt; the base prompt is re-dispatched by the worker from the task record.
do_renew() {
  post_msg "⏳ سقف زمانی رانر گیت‌هاب (~۶ ساعت) نزدیک است؛ تسک روی رانر تازه ادامه پیدا می‌کند (کارِ این مرحله از نو شروع می‌شود)."
  local body code
  body="$(jq -cn --arg txt "$CARRY_TXT" --argjson files "${CARRY_FILES:-[]}" '{carry_text:$txt, carry_files:$files}' 2>/dev/null || echo '{"carry_text":"","carry_files":[]}')"
  code="$(curl -s -o /tmp/renew_resp.json -w '%{http_code}' -X POST "$API/renew" "${AH[@]}" \
    -H 'Content-Type: application/json' -d "$body" 2>/dev/null)" || code="000"
  echo "renew HTTP $code: $(cat /tmp/renew_resp.json 2>/dev/null | head -c 200)"
  case "$code" in
    200) : ;;
    000|5*)
      # worker unreachable — fall back to dispatching directly with the run token
      if [ -n "${GITHUB_TOKEN:-}" ]; then
        curl -sf -X POST \
          -H "Authorization: Bearer $GITHUB_TOKEN" \
          -H "Accept: application/vnd.github+json" \
          "https://api.github.com/repos/${GITHUB_REPOSITORY}/dispatches" \
          -d "$(jq -cn --arg tid "$TASK_ID" --arg m "$MODEL" --arg p "$PROMPT" --arg w "$WORKER_URL" --arg tt "$TASK_TOKEN" \
            '{event_type:"agent-task",client_payload:{task_id:$tid,model:$m,prompt:$p,worker_url:$w,task_token:$tt}}')" >/dev/null 2>&1 || true
      fi
      ;;
    *) : ;; # worker explicitly refused (attempt limit / task closed) — respect it
  esac
  exit 0
}

# run opencode with kill/end/renew monitoring; results in OUT/RC
run_oc() {
  local msg="$1" outfile errfile pid
  CUR_MSG="$msg"
  CUR_FUPS="$FUPS"
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
    if renew_due; then
      # build carry payload from the followup that is currently being processed
      if [ "$RUN_COUNT" -gt 0 ]; then
        CARRY_TXT="$(echo "$CUR_FUPS" | jq -r '[.[] | select(.text != null and .text != "") | .text] | join("\n---\n")' 2>/dev/null || echo "")"
      else
        CARRY_TXT=""
      fi
      CARRY_FILES="$(echo "$CUR_FUPS" | jq -c '[.[] | .files[]? | {name: .name, key: (.url | split("/") | last)}]' 2>/dev/null || echo '[]')"
      pkill -9 -f opencode 2>/dev/null; kill -9 "$pid" 2>/dev/null
      do_renew
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
