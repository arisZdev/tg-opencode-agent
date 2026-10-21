#!/usr/bin/env bash
# OpenCode agent wrapper — two modes:
#  1) daemon (dispatch type agent-boot): RUNNER_TOKEN in env. Boots, announces,
#     then repeatedly asks the worker for queued tasks, runs them one by one,
#     and shuts itself down after AGENT_IDLE_MIN (10) idle minutes.
#  2) legacy single-task (dispatch type agent-task): TASK_ID/TASK_TOKEN set.
#     Runs exactly one task then exits (kept for backward compatibility).
#
# Runner-window renewal: GitHub kills hosted jobs at ~6h. Shortly before the
# cap (RENEW_MIN) the wrapper hands the current task to a fresh runner via the
# worker's /agent/renew and exits. Short runs = low-profile usage pattern.
set -uo pipefail

# public-repo hygiene: mask runtime secrets so they never appear in Actions logs
[ -n "${TASK_TOKEN:-}" ] && echo "::add-mask::$TASK_TOKEN"
[ -n "${RUNNER_TOKEN:-}" ] && echo "::add-mask::$RUNNER_TOKEN"

: "${WORKER_URL:?WORKER_URL missing}"
API="$WORKER_URL/agent"
MODE="daemon"
[ -n "${TASK_ID:-}" ] && [ -n "${TASK_TOKEN:-}" ] && MODE="legacy"

START_TS="$(date +%s)"
RENEW_MIN=330
POLL_S=15
RUN_COUNT=0
KILL=false
END=false
FUPS="[]"
OUT=""
RC=0
TASK_REASON="ok"
LAST_HB="$(date +%s)"
LAST_ACT="$(date +%s)"
HB_MIN=15
IDLE_MIN=10
AGENT_IDLE_MIN=10
OC_KEY=""
CUR_FUPS="[]"
CARRY_TXT=""
CARRY_FILES="[]"
OFF_CHECK_N=0
UPN=-1   # uploads count from the last poll (-1 = unknown / old worker)
WORKROOT="$(pwd)"

# ---------- task-scoped helpers (read TASK_ID/TASK_TOKEN at call time) ----------
tjpost() { curl -sf -X POST "$API/$1" -H "Authorization: Bearer ${TASK_TOKEN:-x}" -H "X-Task-Id: ${TASK_ID:-x}" -H 'Content-Type: application/json' -d "$2" >/dev/null 2>&1 || true; }
post_msg()  { tjpost message "$(jq -cn --arg t "$1" '{text:$t}')"; }
post_done() { tjpost done    "$(jq -cn --arg t "${1:-}" '{text:$t}')"; }
post_fail() { tjpost fail    "$(jq -cn --arg t "${1:-agent error}" '{text:$t}')"; }
hb_now()    { tjpost status  "⏳ هنوز در حال اجراست..."; }

fetch_config() {
  local cfg
  cfg="$(curl -sf "$API/config" -H "Authorization: Bearer ${TASK_TOKEN:-x}" -H "X-Task-Id: ${TASK_ID:-x}")" || { echo "FATAL: cannot fetch config"; return 1; }
  OC_KEY="$(echo "$cfg" | jq -r '.opencode_key // ""')"
  OR_KEY="$(echo "$cfg" | jq -r '.keys.openrouter // ""')"
  GEM_KEY="$(echo "$cfg" | jq -r '.keys.gemini // ""')"
  HB_MIN="$(echo "$cfg" | jq -r '.heartbeat_min // 15')"
  IDLE_MIN="$(echo "$cfg" | jq -r '.idle_min // 10')"
  RENEW_MIN="$(echo "$cfg" | jq -r '.renew_min // 330')"
  export OPENCODE_API_KEY="$OC_KEY"
  export OPENROUTER_API_KEY="$OR_KEY"
  export GEMINI_API_KEY="$GEM_KEY"
  export GOOGLE_API_KEY="$GEM_KEY"
  export GOOGLE_GENERATIVE_AI_API_KEY="$GEM_KEY"
  return 0
}

setup_oc() {
  mkdir -p "$HOME/.config/opencode"
  # NOTE: do not add a permission block here — denying any built-in tool makes
  # the opencode zen free tier reject requests with FreeTierError
  cat > "$HOME/.config/opencode/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "share": "disabled",
  "provider": { "opencode": { "options": { "apiKey": "$OC_KEY" } } }
}
JSON
}

poll() {
  local r
  r="$(curl -sf "$API/poll" -H "Authorization: Bearer ${TASK_TOKEN:-x}" -H "X-Task-Id: ${TASK_ID:-x}" 2>/dev/null || echo '{}')"
  KILL="$(echo "$r" | jq -r '.kill // false')"
  END="$(echo "$r" | jq -r '.end // false')"
  FUPS="$(echo "$r" | jq -c '.followups // []')"
  UPN="$(echo "$r" | jq -r '.uploads // -1')"
}

hb_due() { [ $(( $(date +%s) - LAST_HB )) -ge $(( HB_MIN * 60 )) ]; }
renew_due() { [ $(( $(date +%s) - START_TS )) -ge $(( RENEW_MIN * 60 )) ]; }

# daemon-only: check the off flag without claiming tasks (every ~60s mid-task)
runner_off() {
  [ "$MODE" = "daemon" ] || return 1
  OFF_CHECK_N=$((OFF_CHECK_N + 1))
  [ $((OFF_CHECK_N % 4)) -ne 0 ] && return 1
  local r
  r="$(curl -sf -X POST "$API/next" -H "Authorization: Bearer ${RUNNER_TOKEN:-x}" -H 'Content-Type: application/json' \
    -d '{"check":"off"}' 2>/dev/null || echo '{}')"
  [ "$(echo "$r" | jq -r '.off // false')" = "true" ]
}

# hand the current task over to a fresh runner and exit cleanly.
do_renew() {
  post_msg "⏳ سقف زمانی رانر گیت‌هاب (~۶ ساعت) نزدیک است؛ تسک روی رانر تازه ادامه پیدا می‌کند (کارِ این مرحله از نو شروع می‌شود)."
  local body code
  body="$(jq -cn --arg txt "$CARRY_TXT" --argjson files "${CARRY_FILES:-[]}" '{carry_text:$txt, carry_files:$files}' 2>/dev/null || echo '{"carry_text":"","carry_files":[]}')"
  code="$(curl -s -o /tmp/renew_resp.json -w '%{http_code}' -X POST "$API/renew" \
    -H "Authorization: Bearer ${TASK_TOKEN:-x}" -H "X-Task-Id: ${TASK_ID:-x}" \
    -H 'Content-Type: application/json' -d "$body" 2>/dev/null)" || code="000"
  echo "renew HTTP $code: $(cat /tmp/renew_resp.json 2>/dev/null | head -c 200)"
  case "$code" in
    200) : ;;
    000|5*)
      if [ -n "${GITHUB_TOKEN:-}" ]; then
        curl -sf -X POST \
          -H "Authorization: Bearer $GITHUB_TOKEN" \
          -H "Accept: application/vnd.github+json" \
          "https://api.github.com/repos/${GITHUB_REPOSITORY}/dispatches" \
          -d "$(jq -cn --arg w "$WORKER_URL" --arg rt "${RUNNER_TOKEN:-}" \
            '{event_type:"agent-boot",client_payload:{worker_url:$w,runner_token:$rt}}')" >/dev/null 2>&1 || true
      fi
      ;;
    *) : ;; # worker explicitly refused — respect it
  esac
  exit 0
}

# run opencode with kill/end/renew/off monitoring; results in OUT/RC
run_oc() {
  local msg="$1" outfile errfile pid
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
    if runner_off; then
      pkill -9 -f opencode 2>/dev/null; kill -9 "$pid" 2>/dev/null
      post_fail "ایجنت با دستور شما (/off) خاموش شد؛ تسک نیمه‌کاره ماند."
      RC=144; OUT=""; return
    fi
    if renew_due; then
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
  TASK_REASON="ok"
  # diagnosability: the opencode session output itself never reaches the
  # Actions log — these metric lines are the only window into a silent session
  echo "[task] $TASK_ID oc-finished rc=$RC out=${#OUT}c uploads=$UPN"
  if [ "$RC" = "130" ]; then
    post_msg "🛑 اجرای عامل متوقف شد (کیل).$( [ "$UPN" = "0" ] && echo ' ⚠️ هیچ فایلی آپلود نشده بود.')"
    post_done "killed by user"
    TASK_REASON="killed"; return
  fi
  if [ "$RC" = "143" ]; then
    post_msg "🏁 اجرای عامل به درخواست شما پایان یافت.$( [ "$UPN" = "0" ] && echo ' ⚠️ هیچ فایلی آپلود نشده بود.')"
    post_done "ended by user"
    TASK_REASON="ended"; return
  fi
  if [ "$RC" = "144" ]; then
    TASK_REASON="failed"; return
  fi
  if [ "$RC" -ne 0 ]; then
    post_msg "⚠️ عامل با خطا خارج شد (کد $RC)."
    post_fail "opencode exit code $RC"
    TASK_REASON="failed"; return
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
    curl -sf "$url" -H "Authorization: Bearer ${TASK_TOKEN:-x}" -H "X-Task-Id: ${TASK_ID:-x}" -o "uploads/$name" && echo "uploads/$name"
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

# download the task's initial files (wizard uploads) into ./uploads
dl_initial_files() {
  mkdir -p uploads
  local name url
  while IFS=$'\t' read -r name url; do
    [ -z "${url:-}" ] && continue
    curl -sf "$url" -H "Authorization: Bearer ${TASK_TOKEN:-x}" -H "X-Task-Id: ${TASK_ID:-x}" -o "uploads/$name" && echo "uploads/$name"
  done < <(echo "$1" | jq -r '.[] | [.name, .url] | @tsv' 2>/dev/null)
}

# one full task lifecycle: setup → first run → followup loop → close.
# returns when the task is closed for any reason (TASK_REASON set).
task_session() {
  local init_files="$1" paths msg
  if ! fetch_config; then TASK_REASON="failed"; return 1; fi
  setup_oc
  mkdir -p "work/$TASK_ID" && cd "work/$TASK_ID" || { TASK_REASON="failed"; return 1; }
  cp -f "$WORKROOT/AGENTS.md" . 2>/dev/null || true
  git init -q . 2>/dev/null || true
  git config user.email agent@local 2>/dev/null || true
  git config user.name agent 2>/dev/null || true
  git add -A >/dev/null 2>&1 || true
  git commit -qm init >/dev/null 2>&1 || true
  paths="$(dl_initial_files "$init_files" | tr '\n' ' ')"
  tjpost register "{\"run_id\":${GITHUB_RUN_ID:-0}}"
  # base prompt (editable via the bot's /promptedit) is prepended to the user task
  if [ -n "${BASE_PROMPT:-}" ]; then
    msg="🧬 دستورالعمل پایه (سیستم‌پرامپت):
$BASE_PROMPT

════════════════════════
📋 درخواست کاربر برای این تسک:
$PROMPT"
  else
    msg="$PROMPT"
  fi
  [ -n "${paths// /}" ] && msg="$msg
فایل‌های اولیه (ذخیره‌شده در): $paths"
  post_msg "▶️ شروع تسک با مدل $MODEL"
  echo "[task] $TASK_ID session-start model=$MODEL"
  run_oc "$msg"
  finish_run_output
  [ "$TASK_REASON" != "ok" ] && { cd "$WORKROOT" 2>/dev/null || true; return 0; }
  # followup / idle loop (task stays open for followups)
  while true; do
    sleep "$POLL_S"
    poll
    if [ "$KILL" = "true" ]; then
      post_msg "🛑 تسک متوقف شد.$( [ "$UPN" = "0" ] && echo ' ⚠️ هیچ فایلی آپلود نشده بود.')"
      post_done "killed by user"
      TASK_REASON="killed"; cd "$WORKROOT" 2>/dev/null || true; return 0
    fi
    if [ "$END" = "true" ]; then
      post_msg "🏁 تسک بسته شد.$( [ "$UPN" = "0" ] && echo ' ⚠️ هیچ فایلی آپلود نشده بود.')"
      post_done "ended by user"
      TASK_REASON="ended"; cd "$WORKROOT" 2>/dev/null || true; return 0
    fi
    if [ "$FUPS" != "[]" ]; then
      apply_followups
      [ "$TASK_REASON" != "ok" ] && { cd "$WORKROOT" 2>/dev/null || true; return 0; }
      continue
    fi
    if hb_due; then hb_now; LAST_HB="$(date +%s)"; fi
    if [ $(( $(date +%s) - LAST_ACT )) -ge $(( IDLE_MIN * 60 )) ]; then
      post_msg "✅ $IDLE_MIN دقیقه پیام جدیدی نرسید؛ تسک بسته شد.$( [ "$UPN" = "0" ] && echo ' ⚠️ توجه: این تسک بدون هیچ فایل آپلودشده‌ای تمام شد.')"
      post_done "idle timeout"
      echo "[task] $TASK_ID close reason=idle-timeout uploads=$UPN"
      TASK_REASON="ok"; cd "$WORKROOT" 2>/dev/null || true; return 0
    fi
  done
}

# ---------- legacy single-task mode ----------
if [ "$MODE" = "legacy" ]; then
  task_session "[]" || true
  exit 0
fi

# ---------- daemon mode ----------
: "${RUNNER_TOKEN:?RUNNER_TOKEN missing for daemon mode}"

# announce boot
curl -sf -X POST "$API/next" -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"booted":true}' >/dev/null 2>&1 || true

IDLE_START=0
IDLE_N=0
while true; do
  httpc="$(curl -s -o /tmp/next_resp.json -w '%{http_code}' -X POST "$API/next" -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -cn --argjson rid "${GITHUB_RUN_ID:-0}" '{run_id:$rid}')" 2>/dev/null || echo 000)"
  r="$(cat /tmp/next_resp.json 2>/dev/null || echo '{}')"
  # diagnosability: never idle silently — HTTP/worker errors and idle ticks
  # go to the Actions log so a dead claim loop is visible from the outside
  if [ "$httpc" != "200" ]; then
    echo "[next] HTTP $httpc: $(head -c 200 /tmp/next_resp.json 2>/dev/null)"
  elif [ "$(echo "$r" | jq -r '.ok // true')" = "false" ]; then
    echo "[next] worker error: $(echo "$r" | jq -r '.error // "unknown"' | head -c 200)"
  fi
  if [ "$(echo "$r" | jq -r '.off // false')" = "true" ]; then
    echo "agent off by user"; exit 0
  fi
  tid="$(echo "$r" | jq -r '.task.task_id // ""')"
  if [ -z "$tid" ] || [ "$tid" = "null" ]; then
    AGENT_IDLE_MIN="$(echo "$r" | jq -r '.idle_min // 10')"
    [ "$IDLE_START" -eq 0 ] && IDLE_START="$(date +%s)"
    if [ $(( $(date +%s) - IDLE_START )) -ge $(( AGENT_IDLE_MIN * 60 )) ]; then
      curl -sf -X POST "$API/next" -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
        -d '{"bye":true}' >/dev/null 2>&1 || true
      exit 0
    fi
    IDLE_N=$((IDLE_N + 1))
    [ $((IDLE_N % 4)) -eq 1 ] && echo "[next] idle $(( ($(date +%s) - IDLE_START) / 60 ))/${AGENT_IDLE_MIN}m"
    sleep "$POLL_S"
    continue
  fi
  IDLE_START=0
  TASK_ID="$tid"
  TASK_TOKEN="$(echo "$r" | jq -r '.task.task_token // ""')"
  [ -n "$TASK_TOKEN" ] && echo "::add-mask::$TASK_TOKEN"
  echo "[next] claimed $TASK_ID (model: $(echo "$r" | jq -r '.task.model // "?"'))"
  MODEL="$(echo "$r" | jq -r '.task.model // ""')"
  PROMPT="$(echo "$r" | jq -r '.task.prompt // ""')"
  BASE_PROMPT="$(echo "$r" | jq -r '.task.base // ""')"
  INIT_FILES="$(echo "$r" | jq -c '.task.files // []')"
  RUN_COUNT=0
  UPN=-1
  KILL=false; END=false; RC=0; OUT=""
  LAST_HB="$(date +%s)"; LAST_ACT="$(date +%s)"
  task_session "$INIT_FILES" || true
  echo "[task] $TASK_ID session-end reason=${TASK_REASON:-?} uploads=$UPN"
  cd "$WORKROOT" 2>/dev/null || true
  sleep 3
done
