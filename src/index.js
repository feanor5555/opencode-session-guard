// opencode-session-guard
// Hard-stop guard for opencode sessions.
//
// Default budget: 100 000 tokens. Subagents are warned at 70 % of budget,
// primary agents at 80 %. The plugin reads the active model's actual context
// limit when opencode reports one — the budget env var is only used as a
// fallback.
//
// When the threshold is crossed, the plugin appends an urgent stop / "start a
// new session" instruction to the system prompt of the next LLM call.
//
// Configuration (environment variables, all optional):
//   OPENCODE_SESSION_GUARD_CONTEXT_LIMIT       fallback budget in tokens (default 100000)
//   OPENCODE_SESSION_GUARD_USE_MODEL_LIMIT     "1" to use the model's reported context limit when available (default), "0" to always use CONTEXT_LIMIT
//   OPENCODE_SESSION_GUARD_PRIMARY_RATIO       fraction 0..1 of budget for primary agents (default 0.8)
//   OPENCODE_SESSION_GUARD_SUBAGENT_RATIO      fraction 0..1 of budget for subagents (default 0.7)
//   OPENCODE_SESSION_GUARD_PRIMARY_THRESHOLD   absolute override in tokens for primary (overrides ratio)
//   OPENCODE_SESSION_GUARD_SUBAGENT_THRESHOLD  absolute override in tokens for subagent (overrides ratio)
//   OPENCODE_SESSION_GUARD_PRIMARY_AGENTS      comma-separated agent names treated as primary (default "orchestrator,build")
//   OPENCODE_SESSION_GUARD_LANG                message language: "en" (default) or "de"
//   OPENCODE_SESSION_GUARD_PRIMARY_MESSAGE     custom primary warning template (overrides language). Supports {used} and {threshold}.
//   OPENCODE_SESSION_GUARD_SUBAGENT_MESSAGE    custom subagent stop template (overrides language). Supports {used} and {threshold}.
//   OPENCODE_SESSION_GUARD_DEBUG               "1" to log to /tmp/opencode-session-guard.log

import fs from "node:fs"

const env = (key, fallback) => {
  const v = process.env[key]
  return v === undefined || v === "" ? fallback : v
}

const num = (key, fallback) => {
  const v = env(key, undefined)
  if (v === undefined) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const CONTEXT_LIMIT_FALLBACK = num("OPENCODE_SESSION_GUARD_CONTEXT_LIMIT", 100_000)
const USE_MODEL_LIMIT = env("OPENCODE_SESSION_GUARD_USE_MODEL_LIMIT", "1") === "1"
const PRIMARY_RATIO = num("OPENCODE_SESSION_GUARD_PRIMARY_RATIO", 0.8)
const SUBAGENT_RATIO = num("OPENCODE_SESSION_GUARD_SUBAGENT_RATIO", 0.7)
const PRIMARY_ABS = process.env.OPENCODE_SESSION_GUARD_PRIMARY_THRESHOLD
  ? num("OPENCODE_SESSION_GUARD_PRIMARY_THRESHOLD", undefined)
  : undefined
const SUBAGENT_ABS = process.env.OPENCODE_SESSION_GUARD_SUBAGENT_THRESHOLD
  ? num("OPENCODE_SESSION_GUARD_SUBAGENT_THRESHOLD", undefined)
  : undefined
const PRIMARY_AGENTS = new Set(
  env("OPENCODE_SESSION_GUARD_PRIMARY_AGENTS", "orchestrator,build")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)
const LANG = env("OPENCODE_SESSION_GUARD_LANG", "en").toLowerCase()
const CUSTOM_PRIMARY = env("OPENCODE_SESSION_GUARD_PRIMARY_MESSAGE", undefined)
const CUSTOM_SUBAGENT = env("OPENCODE_SESSION_GUARD_SUBAGENT_MESSAGE", undefined)
const DEBUG = process.env.OPENCODE_SESSION_GUARD_DEBUG === "1"
const LOG_PATH = "/tmp/opencode-session-guard.log"

function log(...args) {
  if (!DEBUG) return
  try {
    const line =
      new Date().toISOString() +
      " " +
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") +
      "\n"
    fs.appendFileSync(LOG_PATH, line)
  } catch {
    // ignore
  }
}

const MESSAGES = {
  en: {
    subagent:
      "\n\n---\n⚠️ Session-Guard: Token threshold reached ({used} / {threshold}).\nSTOP immediately. Return your final status to the orchestrator NOW. No further tool calls.\nIf the task is unfinished, report the partial result honestly with what you have so far.\n---\n",
    primary:
      '\n\n---\n⚠️ Session-Guard: Session nearly full ({used} / {threshold}).\nReply to the user immediately with: "The context is too full for further work. Please start a new session."\nNo further tool calls. No subagent invocations.\n---\n',
  },
  de: {
    subagent:
      "\n\n---\n⚠️ Session-Guard: Token-Schwelle erreicht ({used} / {threshold}).\nSTOPP sofort. Liefere JETZT deinen finalen Status an den Orchestrator zurück. KEINE weiteren Tool-Calls.\nIst die Aufgabe nicht abgeschlossen, melde den Teilstand ehrlich mit dem aktuellen Stand der Dinge.\n---\n",
    primary:
      '\n\n---\n⚠️ Session-Guard: Session fast voll ({used} / {threshold}).\nAntworte dem User unmittelbar mit: "Der Kontext ist zu voll für weitere Arbeit. Bitte starte eine neue Session."\nKEINE weiteren Tool-Calls. KEINE Subagent-Aufrufe.\n---\n',
  },
}

function pickTemplate(kind) {
  if (kind === "primary" && CUSTOM_PRIMARY) return CUSTOM_PRIMARY
  if (kind === "subagent" && CUSTOM_SUBAGENT) return CUSTOM_SUBAGENT
  const bundle = MESSAGES[LANG] ?? MESSAGES.en
  return bundle[kind]
}

function render(template, used, threshold) {
  return template
    .replace(/\{used\}/g, used.toLocaleString())
    .replace(/\{threshold\}/g, threshold.toLocaleString())
}

const subagentStop = (used, threshold) => render(pickTemplate("subagent"), used, threshold)
const primaryWarning = (used, threshold) => render(pickTemplate("primary"), used, threshold)

function sumTokens(info) {
  const t = info?.tokens ?? {}
  return (
    (t.input || 0) +
    (t.output || 0) +
    (t.reasoning || 0) +
    (t.cache?.read || 0) +
    (t.cache?.write || 0)
  )
}

function latestAssistantTokens(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (!info || info.role !== "assistant") continue
    const t = sumTokens(info)
    if (t > 0) return t
  }
  return 0
}

function currentAgent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (info?.agent) return info.agent
  }
  return undefined
}

function resolveBudget(input) {
  if (USE_MODEL_LIMIT) {
    const modelLimit = input?.model?.limit?.context
    if (Number.isFinite(modelLimit) && modelLimit > 0) return modelLimit
  }
  return CONTEXT_LIMIT_FALLBACK
}

function resolveThreshold(isPrimary, budget) {
  if (isPrimary && PRIMARY_ABS !== undefined) return PRIMARY_ABS
  if (!isPrimary && SUBAGENT_ABS !== undefined) return SUBAGENT_ABS
  const ratio = isPrimary ? PRIMARY_RATIO : SUBAGENT_RATIO
  return Math.round(budget * ratio)
}

export default async (ctx) => {
  log("session-guard initialized", {
    CONTEXT_LIMIT_FALLBACK,
    USE_MODEL_LIMIT,
    PRIMARY_RATIO,
    SUBAGENT_RATIO,
    PRIMARY_ABS,
    SUBAGENT_ABS,
    PRIMARY_AGENTS: [...PRIMARY_AGENTS],
    LANG,
    CUSTOM_PRIMARY: !!CUSTOM_PRIMARY,
    CUSTOM_SUBAGENT: !!CUSTOM_SUBAGENT,
  })

  return {
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sessionId = input?.sessionID
        if (!sessionId) return

        const resp = await ctx.client.session.messages({ path: { id: sessionId } })
        const messages = resp?.data ?? resp ?? []
        if (!Array.isArray(messages) || messages.length === 0) return

        const used = latestAssistantTokens(messages)
        if (used <= 0) return

        const agent = currentAgent(messages)
        const isPrimary = agent ? PRIMARY_AGENTS.has(agent) : true
        const budget = resolveBudget(input)
        const threshold = resolveThreshold(isPrimary, budget)

        log("check", { sessionId, agent, isPrimary, used, threshold, budget })

        if (used < threshold) return

        const warning = isPrimary
          ? primaryWarning(used, threshold)
          : subagentStop(used, threshold)

        if (output.system.length > 0) {
          output.system[output.system.length - 1] += warning
        } else {
          output.system.push(warning)
        }
        log("injected", { agent, used, threshold, budget, preview: warning.slice(0, 80).replace(/\n/g, " ") })
      } catch (err) {
        log("error", String(err?.message ?? err))
        // never break the session
      }
    },
  }
}
