# OpenCode agent on GitHub Actions — controlled via Telegram & Bale

This repo runs a coding agent (OpenCode CLI) on GitHub Actions, controlled by a private Cloudflare Worker through two chat channels at once: **Telegram** and **Bale.ai**.

> The Worker source is **not** in this repo (deployed privately via Wrangler). This repo contains only the Actions workflow and the agent-side wrapper.

## Architecture

```
Telegram ─┐                                   ┌─ deliver text to BOTH channels
          ├─ Cloudflare Worker (webhook,      │
Bale.ai  ─┘   task queue, KV db) ─ GitHub Actions runner (opencode CLI)
                     │  repository_dispatch "agent-boot"           │
                     └─ /agent/next  ← runner claims queued tasks ─┘
agent files → POST $WORKER_URL/agent/upload → delivered to both chats
```

- **workflow** (`.github/workflows/agent.yml`): triggered by `repository_dispatch` (event `agent-boot`); timeout 355 min per run.
- **wrapper** (`scripts/task-wrapper.sh`): daemon mode — boots, announces, claims queued tasks one by one (`/agent/next`), runs `opencode run` per task, polls followups every 15 s, heartbeats every 15 min, and shuts itself down after 10 idle minutes.
- Runtime secrets (`TASK_TOKEN`, `RUNNER_TOKEN`) are masked in logs (`::add-mask::`) because this repo is public and Actions logs are visible.

## Flow

1. `/on` in chat → a runner boots and waits for tasks (or just send `/new` — it boots automatically).
2. `/new` → prompt → optional files → pick model → confirm → task is queued.
3. The daemon claims the task, prepends the owner-editable **base prompt** (system instructions, delivered by the Worker), and runs the task.
4. Agent output text and files arrive directly in both chats (Telegram + Bale).
5. Mid-task: send any text/file → it is attached to the running task's followup queue.
6. After 10 minutes with no new messages the task closes; after 10 minutes with no tasks the runner shuts itself down (short-run usage pattern).
7. `/kill T-xxxx` force stop · `/end T-xxxx` graceful end · `/renew T-xxxx` re-run on a fresh runner · `/tasks` status.

## Anti-ban / usage-pattern notes

- Public repo → unlimited Actions minutes, no hidden large workloads.
- Runs are short and task-scoped; a daemon boots only on demand and exits after 10 idle minutes.
- No tokens/keys are committed; everything sensitive lives in Worker secrets and is passed per-run via `repository_dispatch` payload (masked in logs).
- GitHub kills a job at ~6 h; the wrapper renews the run on a fresh runner before the cap (up to 3 attempts).

## Models

| Provider | Status | Key |
|---|---|---|
| Google Gemini (flash) | ✅ works from Actions | `/db set gemini_key <free key from aistudio.google.com>` |
| OpenRouter (`:free` models) | ✅ works | `/db set openrouter_key <free key from openrouter.ai>` |
| OpenCode Zen (free tier) | ⚠️ free tier rejects server/CI IPs since 2026-09 (official policy) | token stored as Worker secret |

Note: do NOT add a `permission` block to the opencode config in the wrapper — denying any built-in tool makes the Zen free-tier gateway reject requests (FreeTierError).

## Shared key-value database

- From chat: `/db set|get|list|comment|del`
- From the agent: `$WORKER_URL/agent/db/...` endpoints (see `AGENTS.md`)

## Worker

The Worker (Telegram/Bale webhook bot, task queue, KV database, agent endpoints) is deployed privately with Wrangler and is not part of this public repo.
