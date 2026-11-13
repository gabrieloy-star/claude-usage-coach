// Usage Coach: where your tokens go, and the one suggestion that saves the most right now.
//   The strip above the prompt: context, prompt cache, usage limits (5 hours and 7 days),
//   session cost, and the suggestion, on one key. An optional line after each answer. A note
//   under large tool outputs and every subagent. A tip in the empty prompt. The side pane (/usage-coach).
//   Idle compact compacts a quiet session a few minutes before its prompt cache expires.
// It only reads figures Claude already reports and never writes into the conversation:
// watching costs no tokens. The one thing that spends is a compaction, when it saves more.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Busy, Disk, DiskSession, Live, Mac, Profile, RepoTrees, Saving, SavingRun, Steps, Tab, Tokens, Turn, Waiting, Week, Weight } from '../types'
import { CACHE_TTL, CEILING, HOUR, LOOP_AT, MINUTE, cacheEnd, clockOf, conversationOf, money, suggestionsOf, seconds, span, tipOf, tok, ttlOf, whenOf } from './suggestions'
import type { Settings } from './suggestions'
import { compactUsd, readUsd, rewriteUsd, sumTokens, tokensUsd } from './prices'
import { SAVINGS_KEY, limitName, loopStep, paceOf, paceWords, promptLine, recordSaving, sampleLimit, savedThisWeek, stepOf } from './signals'
import { drawStrip } from './strip'
import type { Pressing } from './strip'
import { drawPane, size } from './pane'
import { SHORTEST_CACHE, WARN_BEFORE, idleInstructions, newIdleTimer } from './idle'
import { insightsOf } from './insights'
import { isQuestionTool, isStepTool, questionWaiting, stepsAfter } from './steps'
import type { IdleOptions, IdleTimer } from './idle'

const PLUGIN = 'usage-coach'
const PANE = 'usage-coach'
const PANE_COLUMNS = 56
const WEEK_KEY = 'week'
const DISK_KEY = 'disk'
const MAC_KEY = 'mac'
const WELCOMED_KEY = 'welcomed'
const WEEK_FRESH = 2 * HOUR
const TOAST_GAP = 10 * MINUTE
const KEEP_TURNS = 60
const KEEP_WEIGHTS = 40
const HEAVY_OUTPUT = 10_000

const EMPTY: Live = {
  startedAt: null, tokens: null, window: 200_000, fixed: null, conversation: null, adds: [], cacheAt: null, model: '',
  limits: [], usd: null, turnBase: null, turns: [], weights: [], mcp: [], mcpUsed: [], budgetWarned: false, lastToastAt: 0,
}

const live = atom({ plugin: 'usage-coach', key: 'live' } as const, EMPTY as Live)
const tab = atom({ plugin: 'usage-coach', key: 'tab' } as const, 'session' as Tab)
const week = atom({ plugin: 'usage-coach', key: 'week' } as const, null as Week | null)
const weekBusy = atom({ plugin: 'usage-coach', key: 'weekBusy' } as const, false)
const disk = atom({ plugin: 'usage-coach', key: 'disk' } as const, null as Disk | null)
const mac = atom({ plugin: 'usage-coach', key: 'mac' } as const, null as Mac | null)
const profile = atom({ plugin: 'usage-coach', key: 'profile' } as const, null as Profile | null)
const trees = atom({ plugin: 'usage-coach', key: 'trees' } as const, null as RepoTrees | null)
const IDLE: Busy = { disk: false, mac: false, profile: false, action: null }
const busy = atom({ plugin: 'usage-coach', key: 'busy' } as const, IDLE)
const openRow = atom({ plugin: 'usage-coach', key: 'openRow' } as const, null as string | null)
const saved = atom({ plugin: 'usage-coach', key: 'saved' } as const, { usd: 0, count: 0 })
const isWelcome = atom({ plugin: 'usage-coach', key: 'isWelcome' } as const, false)
const steps = atom({ plugin: 'usage-coach', key: 'steps' } as const, null as Steps | null)
const waiting = atom({ plugin: 'usage-coach', key: 'waiting' } as const, null as Waiting | null)

/** The window compaction is measured against (a smaller compaction window when one is set). */
let effectiveWindow: number | null = null

// Per-turn tallies: they only live between turn.start and turn.complete.
let turnStartTokens: number | null = null
let turnRead = 0
let turnInput = 0
let turnAgentUsd = 0
let turnCold = false
let turnOut = 0
let turnTools = 0
let turnRequests = 0
/** Your request that started the turn: "" when Claude continued without one. */
let turnPrompt = ''
/** A main-loop turn is running: a compaction now would be refused, so the strip queues one. */
let isTurnRunning = false
let isCompactQueued = false
/** The next compaction is the one the strip or the pane asked for: its saving is counted. */
let isOwnCompact = false
/** Idle compact's /compact is running: the size it compacted, once it did. */
let idleCompact: { before: number | null } | null = null
/** The strip button just pressed, whose label says so until its work shows. */
let pressing: Pressing = null
let firstStep = true
let ticker: { cancel(): void } | null = null
const idleTimer = newIdleTimer()

// ---------- Settings ----------

function settingsOf(options: Record<string, unknown> | undefined): Settings & { leadMs: number; telemetry: boolean } {
  const o = options ?? {}
  return {
    budget: typeof o.budget === 'number' && o.budget > 0 ? o.budget : 0,
    minTokens: typeof o.minTokens === 'number' && o.minTokens >= 0 ? o.minTokens : 40_000,
    minSaving: typeof o.minSaving === 'number' && o.minSaving >= 0 ? o.minSaving : 1,
    ceiling: typeof o.contextCeiling === 'number' && o.contextCeiling >= 0 ? o.contextCeiling : CEILING,
    leadMs: (typeof o.minutesBeforeExpiry === 'number' && o.minutesBeforeExpiry >= 0 ? o.minutesBeforeExpiry : 5) * MINUTE,
    telemetry: o.telemetry === true,
  }
}

// ---------- Readings ----------

/** The window broken down as /context does, estimated locally: no request, no tokens. */
async function readBreakdown($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b) return
  if (b.rawMaxTokens > 0) effectiveWindow = b.rawMaxTokens
  const used = b.categories.filter(c => c.kind === 'used' && c.tokens > 0)
  const messages = used.find(c => c.name === 'Messages')?.tokens ?? null
  const fixed = used.filter(c => c.name !== 'Messages').reduce((n, c) => n + c.tokens, 0)
  const servers = new Map<string, number>()
  for (const t of b.mcpTools) if (t.isLoaded) servers.set(t.serverName, (servers.get(t.serverName) ?? 0) + t.tokens)
  await update($, live, l => ({
    ...l,
    fixed,
    conversation: messages,
    window: effectiveWindow ?? l.window,
    model: l.model || b.model,
    mcp: [...servers].map(([server, tokens]) => ({ server, tokens })),
  }))
}

async function readUsage($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  await update($, live, l => ({
    ...l,
    startedAt: u.startedAt ?? l.startedAt,
    tokens: u.context.tokens ?? l.tokens,
    window: effectiveWindow ?? (u.context.window || l.window),
    limits: u.rateLimits.length ? [...u.rateLimits] : l.limits,
    usd: u.cost?.usd ?? l.usd,
  }))
}

/** The conversation's size for the idle idleTimer, fresh. */
async function conversationNow($: EngineInterface): Promise<number | null> {
  await readBreakdown($).catch(() => {})
  const l = await read($, live)
  return l.tokens === null && l.conversation === null ? null : conversationOf(l)
}

// ---------- Actions ----------

const ASKED = 'The user asked Usage Coach to compact now to keep the next messages cheap. Preserve open tasks, decisions with their reasons, pending follow-ups, files touched, and anything the user asked to keep.'

/**
 * Compacts from the strip or the pane. Always through /compact, which the engine queues while
 * Claude is answering and runs as soon as the session is idle: pressing never fails mid-answer.
 */
async function compactFromStrip($: EngineInterface) {
  if (isCompactQueued) return $.ui.toast('Usage Coach: the compaction is already queued')
  const conv = conversationOf(await read($, live))
  if (conv > 0 && conv < 5_000) return $.ui.toast(`Usage Coach: only ${tok(conv)} tokens of conversation, nothing worth compacting yet`)
  isCompactQueued = true
  isOwnCompact = true
  $.ui.invalidate('ui.render')
  $.ui.toast(isTurnRunning
    ? 'Usage Coach: compaction queued, it runs as soon as Claude finishes this answer'
    : 'Usage Coach: compacting now')
  void $.command.run({ command: 'compact', args: ASKED })
    .catch(() => $.ui.toast('Usage Coach: the compaction did not run. Type /compact'))
    .finally(() => {
      isCompactQueued = false
      isOwnCompact = false
      $.ui.invalidate('ui.render')
    })
}

const STATUS = 'Give me a status report on this project: where it stands now (done, in progress, blocked), the decisions I need to make, each with your recommendation, and the next steps, most important first. Keep it short.'

/** Starts or ends a wait on you, and redraws the strip. */
async function setWaiting($: EngineInterface, w: Waiting | null) {
  if (!w && (await read($, waiting)) === null) return
  await update($, waiting, () => w)
  $.ui.invalidate('ui.render')
}

/** Asks Claude for the project's status, the person's pending decisions and next steps, as if the person typed it. */
async function askStatus($: EngineInterface) {
  if (pressing === 'status') return
  press($, 'status')
  $.ui.toast(isTurnRunning
    ? 'Usage Coach: project status asked, Claude answers as soon as it finishes this answer'
    : 'Usage Coach: asking Claude for the project status')
  // The label stays until Claude starts answering: turn.start clears it.
  await $.prompt.submit({ text: STATUS, asUser: true })
    .catch(() => {
      press($, null)
      $.ui.toast('Usage Coach: the status question did not go through. Ask it in the prompt')
    })
}

/** Marks a strip button as pressed, or clears it, and redraws the strip. */
function press($: EngineInterface, p: Pressing) {
  pressing = p
  $.ui.invalidate('ui.render')
}

async function togglePane($: EngineInterface) {
  // A pane waiting undrawn counts as closed: pressing opens it, never closes it.
  const mine = (await $.ui.panes()).find(p => p.id === PANE)
  if (mine && mine.isPlaced) {
    await $.ui.close({ id: PANE })
    return
  }
  press($, 'open')
  try {
    // Open first, then fill: the context breakdown takes a moment and redraws the pane when it lands.
    const opened = await $.ui.open({ id: PANE, title: 'Usage Coach', columns: PANE_COLUMNS })
    if (!opened.isPlaced) $.ui.toast(`Usage Coach: the pane did not open here (${(opened as any).reason ?? 'no room'})`)
  } finally {
    press($, null)
  }
  void readBreakdown($).catch(() => {})
  void readView($, await tabNow($)).catch(() => {})
}

/** Opens the pane on the Session view (where the insights now sit), or switches to it when the pane is open. */
async function openInsights($: EngineInterface) {
  await update($, tab, () => 'session' as Tab)
  void readProfile($).catch(() => {})
  const mine = (await $.ui.panes()).find(p => p.id === PANE)
  if (mine && mine.isPlaced) return $.ui.invalidate('ui.render')
  press($, 'insights')
  try {
    const opened = await $.ui.open({ id: PANE, title: 'Usage Coach', columns: PANE_COLUMNS })
    if (!opened.isPlaced) $.ui.toast(`Usage Coach: the pane did not open here (${(opened as any).reason ?? 'no room'})`)
  } finally {
    press($, null)
  }
}

/** Insights already announced by a toast in this session. */
const toldInsights = new Set<string>()

const NODES = ['/opt/homebrew/bin/node', '/usr/local/bin/node', 'node']

async function readWeek($: EngineInterface, force = false) {
  if (await read($, weekBusy)) return
  const kept = await read($, week)
  const now = await $.clock.now()
  if (!force && kept && now - kept.at < WEEK_FRESH) return
  await update($, weekBusy, () => true)
  try {
    const script = `${$.plugin.root}/scripts/week.mjs`
    for (const node of NODES) {
      try {
        const usdAtScan = (await read($, live)).usd
        const run = await $.process.run([node, script, '--days', '7', '--prev'], { timeoutMs: 180_000 })
        if (run.exitCode !== 0 || run.isStdoutTruncated) continue
        const next: Week = { ...JSON.parse(run.stdout), at: await $.clock.now(), ...(usdAtScan !== null ? { sessionUsdAtScan: usdAtScan } : {}) }
        await update($, week, () => next)
        await $.store.set(WEEK_KEY, next)
        return
      } catch {
        // This node is missing: try the next one.
      }
    }
    $.ui.toast('Usage Coach: could not read the week (Node.js not found)')
  } finally {
    await update($, weekBusy, () => false)
  }
}

// ---------- The pane's scanners (local Node scripts: no tokens, nothing sent) ----------

const DISK_FRESH = 10 * MINUTE
const PROFILE_FRESH = 5 * MINUTE
const MAC_FRESH = 6 * HOUR

/** The view a stored tab stands for: values from older versions ('suggestions', 'week', …) read as Session. */
function viewOf(t: unknown): Tab {
  return t === 'project' || t === 'all' ? t : 'session'
}

async function tabNow($: EngineInterface): Promise<Tab> {
  return viewOf(await read($, tab))
}

/** Claude Code's folder name for a path, as scripts/lib.mjs makes it. */
function encode(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

/** The session's project: its repo's main folder (worktrees included), or the session's folder. */
async function projectOf($: EngineInterface): Promise<{ key: string; name: string; root: string } | null> {
  const repo = await $.session.repo().catch(() => null)
  const root = repo?.root ?? (await $.session.root().catch(() => ''))
  if (!root) return null
  return { key: encode(root), name: root.split('/').filter(Boolean).pop() ?? root, root }
}

/** Runs one of the mod's scripts with the first Node.js found; its JSON, or null when it failed. */
async function runScript($: EngineInterface, name: string, argv: string[], timeoutMs: number): Promise<any | null> {
  const script = `${$.plugin.root}/scripts/${name}`
  for (const node of NODES) {
    let run
    try {
      run = await $.process.run([node, script, ...argv], { timeoutMs })
    } catch {
      continue // This node is missing: try the next one.
    }
    if (run.exitCode === 127) continue
    if (run.exitCode !== 0 || run.isStdoutTruncated) return null
    try {
      return JSON.parse(run.stdout)
    } catch {
      return null
    }
  }
  return null
}

async function setBusy($: EngineInterface, change: Partial<Busy>) {
  await update($, busy, b => ({ ...b, ...change }))
  $.ui.invalidate('ui.render')
}

/** Sessions on disk, by project, with this project's heaviest ones. About 2 seconds. */
async function readDisk($: EngineInterface, force = false) {
  if ((await read($, busy)).disk) return
  const kept = await read($, disk)
  const now = await $.clock.now()
  if (!force && kept && now - kept.at < DISK_FRESH) return
  const project = await projectOf($)
  await setBusy($, { disk: true })
  try {
    const id = await $.session.id().catch(() => '')
    const out = await runScript($, 'disk.mjs', ['scan', ...(project ? ['--project', project.key] : []), ...(id ? ['--current', id] : [])], 120_000)
    if (out && Array.isArray(out.projects)) {
      await update($, disk, () => out as Disk)
      await $.store.set(DISK_KEY, out)
    }
  } finally {
    await setBusy($, { disk: false })
  }
}

/** This repo's worktrees and what keeps each one. Seconds to a minute. */
async function readTrees($: EngineInterface) {
  const project = await projectOf($)
  if (!project) return
  const out = await runScript($, 'mac.mjs', ['repos', '--repo', project.root], 300_000)
  const repo = out?.repos?.[0] as RepoTrees | undefined
  await update($, trees, () => repo ?? null)
  $.ui.invalidate('ui.render')
}

/** The whole Mac: worktrees, Xcode builds, simulators, the Claude app, memory. Up to 2 minutes. */
async function readMac($: EngineInterface, force = false) {
  if ((await read($, busy)).mac) return
  const kept = await read($, mac)
  const now = await $.clock.now()
  if (!force && kept && now - kept.at < MAC_FRESH) return
  const project = await projectOf($)
  await setBusy($, { mac: true })
  try {
    const out = await runScript($, 'mac.mjs', ['scan', ...(project ? ['--repo', project.root] : [])], 600_000)
    if (out && Array.isArray(out.repos)) {
      await update($, mac, () => out as Mac)
      await $.store.set(MAC_KEY, out)
      if (project) {
        const mine = (out as Mac).repos.find(r => r.repo === project.root || r.main === project.root)
        if (mine) await update($, trees, () => mine)
      }
    } else if (force) {
      $.ui.toast('Usage Coach: could not measure the Mac (Node.js not found, or the scan took too long)')
    }
  } finally {
    await setBusy($, { mac: false })
  }
}

/** This session's transcript: how it grew, what filled it. A few seconds. */
async function readProfile($: EngineInterface, force = false) {
  if ((await read($, busy)).profile) return
  const kept = await read($, profile)
  const now = await $.clock.now()
  if (!force && kept && now - kept.at < PROFILE_FRESH) return
  const id = await $.session.id().catch(() => '')
  if (!id) return
  await setBusy($, { profile: true })
  try {
    const out = await runScript($, 'session.mjs', ['--id', id], 120_000)
    if (out && Array.isArray(out.series)) await update($, profile, () => out as Profile)
  } finally {
    await setBusy($, { profile: false })
  }
}

/** What a view needs, read when it is shown (each reading skips itself while fresh). */
async function readView($: EngineInterface, view: Tab, force = false) {
  if (view === 'session') return readProfile($, force)
  if (view === 'project') {
    await Promise.all([readDisk($, force), (force || !(await read($, trees))) ? readTrees($) : null, readMac($).catch(() => {})])
    return
  }
  await Promise.all([readDisk($, force), readWeekDays($, force), force ? readMac($, true) : null])
}

/** The week with its tokens per day (14 days), for the All projects view. */
async function readWeekDays($: EngineInterface, force = false) {
  const w = await read($, week)
  if (!force && w?.days && Object.keys(w.days).length >= 8) return readWeek($)
  return readWeek($, true)
}

// ---------- The pane's actions: each asks first, checks again, and says what it did ----------

const CANCEL = 'Cancel'
const SHOW = 'Show the list'

/** Asks before an action; true only when the first option is chosen. "Show the list" logs every item and asks again. */
async function confirm($: EngineInterface, question: string, yes: string, items: string[], header: string): Promise<boolean> {
  try {
    let answer = await $.ui.ask(question, { options: items.length > 1 ? [yes, SHOW, CANCEL] : [yes, CANCEL], header })
    if (answer === SHOW) {
      $.ui.log(`◆ Usage Coach · ${header}:\n` + items.map(x => '  ' + x).join('\n'))
      answer = await $.ui.ask(question, { options: [yes, CANCEL], header })
    }
    return answer === yes
  } catch {
    return false // Dismissed: nothing happens.
  }
}

async function runAction<T>($: EngineInterface, label: string, work: () => Promise<T>): Promise<T | null> {
  if ((await read($, busy)).action) {
    $.ui.toast('Usage Coach: another action is still running')
    return null
  }
  await setBusy($, { action: label })
  try {
    return await work()
  } finally {
    await setBusy($, { action: null })
  }
}

/** "3 pending changes, 1 open": why items were skipped, grouped. */
function skippedWords(skipped: { why: string }[]): string {
  const counts = new Map<string, number>()
  for (const s of skipped) counts.set(s.why, (counts.get(s.why) ?? 0) + 1)
  return [...counts].map(([why, n]) => `${n} ${why}`).join(', ')
}

function short(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

async function trashSessions($: EngineInterface, paths: string[], bytes: number, olderDays: number) {
  if (!paths.length) return
  const n = paths.length
  const ok = await confirm($,
    `Move ${n} session${n > 1 ? 's' : ''} (${size(bytes)}) to the Trash? Open and recent sessions are skipped. You can put them back from the Trash until you empty it.`,
    `Move ${n} to the Trash`, paths.map(short), 'Sessions')
  if (!ok) return
  const id = await $.session.id().catch(() => '')
  const out = await runAction($, 'Moving sessions to the Trash…', () =>
    runScript($, 'disk.mjs', ['trash', ...(id ? ['--current', id] : []), '--older-days', String(olderDays), ...paths], 300_000))
  if (!out) return $.ui.toast('Usage Coach: the sessions were not moved')
  const skipped = out.skipped?.length ? ` · skipped ${skippedWords(out.skipped)}` : ''
  $.ui.toast(`Usage Coach: ${out.moved.length} session${out.moved.length === 1 ? '' : 's'} in the Trash (${size(out.bytes)}): empty it to free the space${skipped}`, { timeoutMs: 8000 })
  await update($, openRow, () => null)
  await readDisk($, true)
}

async function removeWorktrees($: EngineInterface, paths: string[], bytes: number) {
  if (!paths.length) return
  const n = paths.length
  const ok = await confirm($,
    `Remove ${n} worktree folder${n > 1 ? 's' : ''} (${size(bytes)})? Their work is already in the main branch and nothing uses them. Branches stay. Git refuses any folder with changes.`,
    `Remove ${n}`, paths.map(short), 'Worktrees')
  if (!ok) return
  const out = await runAction($, `Removing ${n} worktrees…`, () => runScript($, 'mac.mjs', ['remove-worktrees', ...paths], 600_000))
  if (!out) return $.ui.toast('Usage Coach: the worktrees were not removed')
  const gone = new Set<string>(out.removed)
  const skipped = out.skipped?.length ? ` · kept ${skippedWords(out.skipped)}` : ''
  $.ui.toast(`Usage Coach: removed ${gone.size} worktree${gone.size === 1 ? '' : 's'}, ${size(out.bytes)} freed${skipped}. Their Xcode builds can go next: Refresh`, { timeoutMs: 8000 })
  const drop = (r: RepoTrees): RepoTrees => {
    const left = r.trees.filter(t => !gone.has(t.path))
    return { ...r, trees: left, bytes: left.reduce((x, t) => x + t.bytes, 0) }
  }
  await update($, trees, t => (t ? drop(t) : t))
  await update($, mac, m => (m ? { ...m, repos: m.repos.map(drop) } : m))
  $.ui.invalidate('ui.render')
}

async function clearXcode($: EngineInterface, folders: string[], bytes: number) {
  if (!folders.length) return
  const n = folders.length
  const ok = await confirm($,
    `Move ${n} Xcode build folder${n > 1 ? 's' : ''} (${size(bytes)}) to the Trash? They are for projects that are gone or unused for 7 days. Xcode builds them again when needed.`,
    `Move ${n} to the Trash`, folders.map(f => f.split('/').pop() ?? f), 'Xcode builds')
  if (!ok) return
  const out = await runAction($, 'Moving Xcode builds to the Trash…', () => runScript($, 'mac.mjs', ['clear-xcode', ...folders], 600_000))
  if (!out) return $.ui.toast('Usage Coach: the Xcode builds were not moved')
  const gone = new Set<string>(out.moved)
  const skipped = out.skipped?.length ? ` · kept ${skippedWords(out.skipped)}` : ''
  $.ui.toast(`Usage Coach: ${gone.size} Xcode build folder${gone.size === 1 ? '' : 's'} in the Trash (${size(out.bytes)}): empty it to free the space${skipped}`, { timeoutMs: 8000 })
  await update($, mac, m => {
    if (!m) return m
    const builds = m.xcode.builds.filter(b => !gone.has(b.folder))
    return { ...m, xcode: { ...m.xcode, builds, bytes: builds.reduce((x, b) => x + b.bytes, 0) } }
  })
  $.ui.invalidate('ui.render')
}

async function shutdownSim($: EngineInterface, udid: string, name: string, mb: number) {
  const ok = await confirm($,
    `Shut down the ${name} simulator? It frees about ${mb >= 1000 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'} of memory. It is like turning the phone off: Xcode or Claude opens it again when needed.`,
    'Shut down', [], 'Simulator')
  if (!ok) return
  const out = await runAction($, 'Shutting down the simulator…', () => runScript($, 'mac.mjs', ['shutdown-sim', udid], 180_000))
  if (!out?.ok) return $.ui.toast(`Usage Coach: the simulator is still on (${out?.why ?? 'the command failed'})`)
  $.ui.toast(`Usage Coach: ${name} is shut down`)
  await update($, mac, m => m ? {
    ...m,
    sims: { ...m.sims, devices: m.sims.devices.map(d => d.udid === udid ? { ...d, state: 'Shutdown', mb: 0 } : d) },
    memory: { ...m.memory, simMb: Math.max(0, m.memory.simMb - mb) },
  } : m)
  $.ui.invalidate('ui.render')
}

const KEEP = (days: number) => `Set "cleanupPeriodDays": ${days} in ~/.claude/settings.json (keep the other settings as they are). Usage Coach asked for it: Claude Code will delete session transcripts older than ${days} days when it starts. Only edit that one key, then say it is done in one line.`

/** How long Claude Code keeps sessions: it deletes older ones for good when it starts. */
async function keepDays($: EngineInterface) {
  const d = await read($, disk)
  if (!d) return
  const choice = (days: number) => {
    const k = d.keep.find(x => x.days === days)
    return k ? `Keep ${days} days · frees ${size(k.bytes)}${k.sidebar ? ` · ${k.sidebar} sidebar sessions lose their history` : ''}` : ''
  }
  const fourteen = choice(14), seven = choice(7)
  const options = [fourteen, seven, 'Keep 30 days (no change)'].filter(Boolean)
  let answer: string
  try {
    answer = await $.ui.ask('How long should Claude Code keep old sessions? It deletes older ones for good when it starts (not to the Trash).', { options, header: 'Sessions' })
  } catch {
    return
  }
  const days = answer === fourteen ? 14 : answer === seven ? 7 : 0
  if (!days) return
  const row = (await $.config.list().catch(() => [])).find(r => /cleanupPeriodDays/i.test(r.key))
  if (row) {
    const set: any = await $.config.set({ key: row.key, value: days } as any).catch(() => ({ deny: 'refused' }))
    if (!set?.deny) return $.ui.toast(`Usage Coach: Claude Code now keeps sessions ${days} days`)
  }
  // Not a /config row: Claude edits the setting, and you approve the edit.
  await $.prompt.submit({ text: KEEP(days), asUser: true }).catch(() => $.ui.toast('Usage Coach: add "cleanupPeriodDays": ' + days + ' to ~/.claude/settings.json'))
}

const HANDOVER = 'Write a short hand-over note I can paste into a new Claude Code session to continue this work: the goal, what is done, what is in progress, decisions made with their reasons, open questions, the files that matter, and the next step. Keep it under 300 words, in one code block.'

/** Copies the command that continues a session in a terminal. */
async function copyResume($: EngineInterface, s: DiskSession, surface: any) {
  const cwd = s.cwd ? `cd '${s.cwd.replace(/'/g, `'\\''`)}' && ` : ''
  const copied: any = await $.ui.copy({ text: `${cwd}claude --resume ${s.id}`, surface } as any).catch(() => null)
  $.ui.toast(copied?.isCopied === false ? 'Usage Coach: could not copy here' : 'Usage Coach: resume command copied: paste it in a terminal')
}

async function toastOnce($: EngineInterface, text: string) {
  const now = await $.clock.now()
  const l = await read($, live)
  if (now - l.lastToastAt < TOAST_GAP) return
  await update($, live, x => ({ ...x, lastToastAt: now }))
  $.ui.toast(text)
}

// ---------- Savings ----------

/** Writes one saving to the 7-day ledger and refreshes the total the pane shows. */
async function keepSaving($: EngineInterface, entry: Saving) {
  const now = await $.clock.now()
  const list = recordSaving((await $.store.get(SAVINGS_KEY)) as Saving[] | null, entry, now)
  await $.store.set(SAVINGS_KEY, list)
  await update($, saved, () => savedThisWeek(list, now))
}

/** At the end of each turn: what the compaction being counted saved so far. */
async function countSaving($: EngineInterface, run: SavingRun, turnStartedAt: number, requests: number) {
  const now = await $.clock.now()
  if (run.kind === 'idle') {
    // The /compact turn itself is no return.
    if (run.at !== undefined && turnStartedAt < run.at) return
    // Counted once, on the return: only a return after the cache would have expired saved anything.
    await update($, live, x => ({ ...x, savingRun: null }))
    if (run.expiresAt !== undefined && turnStartedAt >= run.expiresAt && run.usd > 0) await keepSaving($, { id: run.id, at: now, kind: 'idle', usd: run.usd })
    return
  }
  const next = { ...run, usd: run.usd + run.perRequest * requests }
  await update($, live, x => ({ ...x, savingRun: next }))
  await keepSaving($, { id: run.id, at: now, kind: 'button', usd: next.usd })
}

// ---------- Weights ----------

function mcpServerOf(tool: string): string | null {
  const m = /^mcp__(.+?)__/.exec(tool)
  return m ? m[1]! : null
}

function labelOf(tool: string, input: any): string {
  const s = input?.description ?? input?.command ?? input?.file_path ?? input?.pattern ?? input?.url ?? input?.query ?? ''
  const text = String(s).replace(/\s+/g, ' ').trim()
  return text.length > 48 ? text.slice(0, 47) + '…' : text || tool
}

function weightOf(id: string, tool: string, input: any, result: any): Weight | null {
  if (tool === 'Agent' && result && typeof result.totalTokens === 'number') {
    const u = result.usage ?? {}
    const sample: Tokens = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      read: u.cache_read_input_tokens ?? 0,
      write5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      write1h: u.cache_creation?.ephemeral_1h_input_tokens ?? u.cache_creation_input_tokens ?? 0,
    }
    const model = result.resolvedModel ?? ''
    // The usage sample sets the mix of token kinds; totalTokens scales it to the whole run.
    const per = sumTokens(sample) ? tokensUsd(sample, model) / sumTokens(sample) : 0
    return {
      id, tool, isAgent: true, label: labelOf(tool, input), tokens: result.totalTokens,
      usd: per * result.totalTokens, ms: result.totalDurationMs, model, agentType: result.agentType ?? input?.subagent_type,
    }
  }
  let size = 0
  try {
    size = Math.round(JSON.stringify(result ?? '').length / 4)
  } catch {
    return null
  }
  return size >= HEAVY_OUTPUT ? { id, tool, isAgent: false, label: labelOf(tool, input), tokens: size } : null
}

/** When idle compact will run if no message comes first; null when it will not run. */
function idleAtOf(l: Live): number | null {
  const end = cacheEnd(l)
  if (settings.leadMs <= 0 || end === null || ttlOf(l) < 30 * MINUTE || conversationOf(l) < settings.minTokens) return null
  return end - settings.leadMs
}

// ---------- Idle compact ----------

function stopIdle($: EngineInterface, f: IdleTimer) {
  f.generation++
  for (const t of f.timers) t.cancel()
  f.timers = []
  if (f.hasStatus) $.ui.status(undefined)
  f.hasStatus = false
}

/** Runs one compaction now; resolves false when there was nothing worth compacting or a turn was running. */
async function compactNow($: EngineInterface, o: IdleOptions, why: string, expiresAt: number): Promise<boolean> {
  const before = await o.conversation()
  if (before === null || before < Math.min(o.minTokens, 5_000)) return false
  try {
    const result = await $.session.compact({ instructions: why })
    if (!result.messages) return false
    await o.onCompacted(result.tokensBefore ?? before, expiresAt)
    return true
  } catch {
    // The desktop app and the SDK run Claude Code headless, where only /compact compacts between turns.
    return compactByCommand($, o, why, before, expiresAt)
  }
}

/** The same compaction through /compact, as the strip's button runs it. */
async function compactByCommand($: EngineInterface, o: IdleOptions, why: string, before: number, expiresAt: number): Promise<boolean> {
  if (isCompactQueued || isTurnRunning) return false
  const ran = { before: null as number | null }
  idleCompact = ran
  try {
    await $.command.run({ command: 'compact', args: why })
  } catch {
    return false
  } finally {
    idleCompact = null
  }
  if (ran.before === null) return false
  await o.onCompacted(ran.before || before, expiresAt)
  return true
}

/** Sets the timer at the end of a main-loop turn. */
async function startIdle($: EngineInterface, f: IdleTimer, o: IdleOptions) {
  stopIdle($, f)
  if (o.leadMs <= 0) return
  const cache = await o.cache()
  if (!cache || cache.ttl < SHORTEST_CACHE) return
  const lit = f.generation
  const now = await $.clock.now()
  const fireAt = cache.end - o.leadMs
  if (fireAt <= now) return

  f.timers.push($.clock.after(Math.max(0, fireAt - WARN_BEFORE - now), async () => {
    if (lit !== f.generation) return
    const conv = await o.conversation().catch(() => null)
    if (conv === null || conv < o.minTokens) return
    $.ui.status(`◆ Usage Coach compacts at ${clockOf(fireAt)} unless you send a message · the cache expires at ${clockOf(cache.end)} · ${tok(conv)} tokens of conversation`)
    f.hasStatus = true
  }))

  f.timers.push($.clock.after(fireAt - now, async () => {
    if (lit !== f.generation) return
    const at = await $.clock.now()
    // A timer that fires late (the Mac slept) finds the cache expired: compacting then saves nothing.
    if (at >= cache.end) {
      $.ui.log(`◆ Usage Coach did not compact: the cache expired at ${clockOf(cache.end)} while the Mac was asleep`)
      stopIdle($, f)
      return
    }
    const conv = await o.conversation().catch(() => null)
    if (conv === null || conv < o.minTokens) {
      stopIdle($, f)
      return
    }
    const done = await compactNow($, o, idleInstructions(clockOf(at), clockOf(cache.end)), cache.end)
    // /compact runs as a turn of its own, which moves the generation on: the compaction still stands.
    if (!done && lit !== f.generation) return
    if (done) {
      $.ui.status(`◆ Usage Coach compacted at ${clockOf(at)}, before the cache expired · ${tok(conv)} tokens of conversation`)
      f.hasStatus = true
    } else {
      stopIdle($, f)
    }
  }))
}

// ---------- Hooks ----------

let settings = settingsOf(undefined)

function idleOptions($: EngineInterface): IdleOptions {
  return {
    leadMs: settings.leadMs,
    minTokens: settings.minTokens,
    conversation: () => conversationNow($),
    cache: async () => {
      const l = await read($, live)
      const end = cacheEnd(l)
      return end === null ? null : { end, ttl: ttlOf(l) }
    },
    onCompacted: async (before, expiresAt) => {
      // Saved once you come back after the cache would have expired: the resend it avoided, less the compaction.
      const l = await read($, live)
      const at = await $.clock.now()
      const model = l.model
      const usd = rewriteUsd(before, model) - compactUsd(before, model)
      await update($, live, x => ({ ...x, savingRun: { id: 'idle-' + at, kind: 'idle' as const, usd, perRequest: 0, expiresAt, at } }))
      $.ui.invalidate('ui.render')
    },
  }
}

export const register: Register = (on, options) => {
  settings = settingsOf(options as Record<string, unknown>)
  const s = settings

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'usage-coach', description: 'Usage Coach: where your tokens go, and the change that saves the most' })
    ticker?.cancel()
    // The idle countdown and the usage limits change with the clock.
    ticker = $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    try {
      await readUsage($)
      await readBreakdown($)
      const kept = (await $.store.get(WEEK_KEY)) as Week | null
      if (kept && Number.isFinite(kept.at)) await update($, week, () => kept)
      // The last readings of the disk and the Mac show at once; Refresh reads them again.
      const keptDisk = (await $.store.get(DISK_KEY)) as Disk | null
      if (keptDisk && Array.isArray(keptDisk.projects) && !(await read($, disk))) await update($, disk, () => keptDisk)
      const keptMac = (await $.store.get(MAC_KEY)) as Mac | null
      if (keptMac && Array.isArray(keptMac.repos) && !(await read($, mac))) await update($, mac, () => keptMac)
      await update($, tab, t => viewOf(t))
      await update($, busy, () => IDLE)
      const now = await $.clock.now()
      void (async () => {
        const list = (await $.store.get(SAVINGS_KEY)) as Saving[] | null
        await update($, saved, () => savedThisWeek(list, now))
        if (!(await $.store.get(WELCOMED_KEY))) await update($, isWelcome, () => true)
        $.ui.invalidate('ui.render')
      })().catch(() => {})
      // The details card shows the week's Fable use: refresh a stale week in the background (local, no tokens).
      void readWeek($).catch(() => {})
    } catch {
      // The strip fills in after the first answer.
    }
    // A reload (or /reload-plugins) drops the idle timer with the old module: set it again from the
    // cache the state kept, so a quiet session is still compacted before the cache expires.
    if (!isTurnRunning) void startIdle($, idleTimer, idleOptions($)).catch(() => {})
    $.ui.invalidate('ui.render')
    return result
  })

  // Answered here, so nothing reaches the model: the command costs no tokens.
  on('command.run', { command: 'usage-coach' }, async $ => {
    await togglePane($)
    return {}
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      stopIdle($, idleTimer)
      isTurnRunning = true
      if (pressing === 'status') press($, null)
      const l = await read($, live)
      turnStartTokens = l.tokens
      turnRead = 0
      turnInput = 0
      turnAgentUsd = 0
      turnCold = false
      turnOut = 0
      turnTools = 0
      turnRequests = 0
      turnPrompt = e.text ?? ''
      firstStep = true
      await setWaiting($, null).catch(() => {})
      // A new request of yours is the hint a failing loop needed: the count starts over.
      await update($, live, x => ({ ...x, turnBase: x.usd, loop: turnPrompt ? null : x.loop }))
    }
    return next(e)
  })

  // Each request of the main loop: the cache figures.
  on('turn.step', async function* ($, e, next) {
    const at = await $.clock.now()
    const response = yield* next(e)
    if (!e.agentId) {
      const u: any = response?.usage
      let ttl: number | undefined
      if (u) {
        const read = u.cache_read_input_tokens ?? 0
        const write = u.cache_creation_input_tokens ?? 0
        turnRead += read
        turnInput += read + write + (u.input_tokens ?? 0)
        turnOut += u.output_tokens ?? 0
        turnRequests++
        if (firstStep && write > 50_000 && read < write) turnCold = true
        // Which cache this request wrote: the 1-hour one, or the 5-minute one (as when usage runs over).
        const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
        const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
        if (w1 > 0) ttl = CACHE_TTL
        else if (w5 > 0) ttl = 5 * MINUTE
      }
      firstStep = false
      await update($, live, x => ({ ...x, cacheAt: at, cacheTtl: ttl ?? x.cacheTtl, model: e.model || x.model }))
    }
    return response
  })

  on('tool.call', async ($, e, next) => {
    const isMain = !(e as any).agentId
    // The tool's arguments sit beside `tool` on the input (`e.command` for Bash).
    const args: any = (e as any).input ?? e
    // A question to you: the strip counts the minutes until you answer.
    const asks = isMain && isQuestionTool(e.tool)
    if (asks) await setWaiting($, questionWaiting(args, await $.clock.now()))
    let ran: any
    try {
      ran = await next(e)
    } finally {
      if (asks) await setWaiting($, null)
    }
    try {
      if (isMain && isStepTool(e.tool) && ran && ran.deny === undefined && ran.isError !== true) {
        const now = await $.clock.now()
        const before = await read($, steps)
        const after = stepsAfter(before, e.tool, args, ran.result, now)
        if (after !== before) {
          // The 30-second ticker redraws the strip, so a finished list leaves it on its own.
          await update($, steps, () => after)
          $.ui.invalidate('ui.render')
        }
      }
    } catch {
      // The step list never fails a tool call.
    }
    try {
      const server = mcpServerOf(e.tool)
      if (server) {
        const l = await read($, live)
        if (!l.mcpUsed.includes(server)) await update($, live, x => ({ ...x, mcpUsed: [...x.mcpUsed, server] }))
      }
      if (!(e as any).agentId) turnTools++
      if (!(e as any).agentId && ran && ran.deny === undefined) {
        const l = await read($, live)
        const loop = loopStep(l.loop, stepOf(e.tool, (e as any).input), ran.isError === true, l.usd ?? 0)
        const isNew = loop && loop.count >= LOOP_AT && !loop.isTold
        if (loop !== l.loop) await update($, live, x => ({ ...x, loop: isNew ? { ...loop!, isTold: true } : loop }))
        if (isNew) {
          const spent = l.usd !== null ? Math.max(0, l.usd - loop!.usdAtFirst) : 0
          $.ui.toast(`Usage Coach: Claude failed the same step ${loop!.count} times${spent >= 0.01 ? ` (${money(spent)} since the first failure)` : ''}. Press Esc and say what to try instead`)
          $.ui.invalidate('ui.render')
        }
      }
      if (!(e as any).agentId && ran && ran.result !== undefined) {
        const w = weightOf(e.tool_use_id, e.tool, (e as any).input, ran.result)
        if (w) {
          if (w.isAgent) turnAgentUsd += w.usd ?? 0
          await update($, live, x => ({ ...x, weights: [...x.weights, w].slice(-KEEP_WEIGHTS) }))
        }
      }
    } catch {
      // A weight never fails a tool call.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    isTurnRunning = false
    await setWaiting($, null).catch(() => {})
    try {
      await readUsage($)
      await readBreakdown($).catch(() => {})
      const now = await $.clock.now()
      const l = await read($, live)
      const usd = l.usd !== null && l.turnBase !== null ? Math.max(0, l.usd - l.turnBase) : 0
      const added = l.tokens !== null && turnStartTokens !== null ? Math.max(0, l.tokens - turnStartTokens) : 0
      const turn: Turn = {
        at: now, ms: e.durationMs, added, usd,
        cached: turnInput ? turnRead / turnInput : 1,
        agentShare: usd > 0 ? Math.min(1, turnAgentUsd / usd) : 0,
        isCold: turnCold,
        out: turnOut,
        tools: turnTools,
        model: l.model,
        requests: turnRequests,
        ...(turnPrompt.trim() ? { prompt: promptLine(turnPrompt) } : {}),
      }
      await update($, live, x => ({
        ...x,
        turns: [...x.turns, turn].slice(-KEEP_TURNS),
        adds: [...x.adds, added].slice(-12),
        limitSamples: Object.fromEntries(x.limits.map(lim => [lim.kind, sampleLimit(x.limitSamples?.[lim.kind], now, lim.percentUsed)])),
      }))
      if (l.savingRun) await countSaving($, l.savingRun, now - e.durationMs, turnRequests)

      // The ledger line, when turned on: a dim transcript row, never sent to the model.
      if (s.telemetry && usd >= 0.01) {
        const bits = [seconds(e.durationMs), added ? '+' + tok(added) + ' context' : '', money(usd), `${Math.round(turn.cached * 100)}% from cache`]
        if (turn.agentShare >= 0.2) bits.push(`subagents ${Math.round(turn.agentShare * 100)}%`)
        if (turn.isCold) bits.push('cache had expired')
        $.ui.log('◆ ' + bits.filter(Boolean).join(' · '))
      }

      // Budget: said once per session.
      const after = await read($, live)
      if (s.budget > 0 && after.usd !== null && !after.budgetWarned) {
        if (after.usd >= s.budget) {
          await update($, live, x => ({ ...x, budgetWarned: true }))
          $.ui.toast(`Usage Coach: this session has cost ${money(after.usd)}, over your ${money(s.budget)} budget`)
        }
      }
      // A usage limit that runs out before it resets: said once per window.
      for (const lim of after.limits) {
        const pace = paceOf(lim, after.limitSamples?.[lim.kind], now)
        const key = `${lim.kind}@${lim.resetsAt ?? ''}`
        if (!pace?.isShort || after.toldPace?.includes(key)) continue
        await update($, live, x => ({ ...x, toldPace: [...(x.toldPace ?? []), key].slice(-6) }))
        $.ui.toast(`Usage Coach: ${paceWords(pace)} the ${limitName(lim.kind)} runs out ${whenOf(pace.runsOutAt, now)}, ${span(pace.resetsAt! - pace.runsOutAt)} before it resets`)
      }
      const top = suggestionsOf(after, now, s)[0]
      if (top && top.tone === 'hot' && top.id !== 'budget') await toastOnce($, `Usage Coach: ${tipOf(top)}`)
      // A model that does not fit the work is said once per session; the rest waits in Insights.
      const fit = insightsOf(after, await read($, week), now).find(i => i.kind === 'model' && i.tone !== 'calm' && !toldInsights.has(i.id))
      if (fit) {
        toldInsights.add(fit.id)
        await toastOnce($, `Usage Coach insight: ${fit.title} · click insights`)
      }
    } catch {
      // No reading this turn: the strip keeps the last one.
    }
    await startIdle($, idleTimer, idleOptions($)).catch(() => {})
    // An open Session view follows the session (local reading, skipped while fresh).
    void (async () => {
      const mine = (await $.ui.panes()).find(p => p.id === PANE)
      if (mine?.isPlaced && (await tabNow($)) === 'session') await readProfile($)
    })().catch(() => {})
    $.ui.invalidate('ui.render')
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, live, x => ({
      ...x,
      limits: e.changed.includes('rateLimits') && e.rateLimits.length ? [...e.rateLimits] : x.limits,
      usd: e.cost?.usd ?? x.usd,
      tokens: e.context.tokens ?? x.tokens,
      window: effectiveWindow ?? (e.context.window || x.window),
    }))
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.trigger === 'precompute' || !result.messages) return result
    const isOwn = isOwnCompact
    isOwnCompact = false
    try {
      // The strip's compaction saves on every later request; any other compaction ends the count.
      const l = await read($, live)
      const before = result.tokensBefore ?? conversationOf(l)
      if (idleCompact) idleCompact.before = before
      const run: SavingRun | null = isOwn && result.tokensAfter !== undefined && before > result.tokensAfter
        ? { id: 'button-' + (await $.clock.now()), kind: 'button', usd: -compactUsd(before, l.model), perRequest: readUsd(before - result.tokensAfter, l.model) }
        : null
      await update($, live, x => ({ ...x, savingRun: run }))
      await update($, live, x => ({
        ...x,
        tokens: result.tokensAfter && x.fixed !== null ? x.fixed + result.tokensAfter : x.tokens,
        conversation: result.tokensAfter ?? x.conversation,
        adds: [...x.adds, 0].slice(-12),
        // The next message writes the new, smaller context.
        cacheAt: null,
      }))
      for (const delay of [800, 2500]) void $.clock.after(delay, () => void readBreakdown($).catch(() => {}))
    } catch {
      // The compaction stands whatever the strip makes of it.
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    stopIdle($, idleTimer)
    if (e.reason === 'clear') {
      await update($, live, x => ({ ...EMPTY, limits: x.limits, mcp: x.mcp, limitSamples: x.limitSamples, toldPace: x.toldPace }))
      turnStartTokens = null
    }
    if (e.reason === 'prompt_input_exit' || e.reason === 'other') ticker?.cancel()
    return result
  })

  // ---------- Drawing ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const el = $.ui.resolve(e)
    const l = await read($, live)
    const now = await $.clock.now()
    const strip = drawStrip(el, {
      live: l,
      week: await read($, week),
      suggestion: suggestionsOf(l, now, s)[0],
      insights: insightsOf(l, await read($, week), now).length,
      now,
      columns: Math.max(20, e.props.bodyColumns),
      desktop: e.surface === 'desktop',
      onSuggestion: () => void compactFromStrip($),
      isQueued: isCompactQueued,
      idleAt: idleAtOf(l),
      ceiling: s.ceiling,
      onOpen: () => void togglePane($),
      onInsights: () => void openInsights($),
      onStatus: () => void askStatus($),
      pressing,
      steps: await read($, steps),
      waiting: await read($, waiting),
      isWelcome: await read($, isWelcome),
      onWelcomeDone: () => void (async () => {
        await $.store.set(WELCOMED_KEY, true)
        await update($, isWelcome, () => false)
      })(),
    })
    const below = await next(e)
    if (!strip) return below
    return below ? el.Box({ flexDirection: 'column', children: [strip, below] }) : strip
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const l = await read($, live)
    const now = await $.clock.now()
    const w = await read($, week)
    const d = await read($, disk)
    const project = await projectOf($)
    const b = await read($, busy)
    return drawPane($.ui.resolve(e), {
      tab: viewOf(await read($, tab)),
      live: l,
      suggestions: suggestionsOf(l, now, s),
      insights: insightsOf(l, w, now),
      week: w,
      disk: d,
      mac: await read($, mac),
      profile: await read($, profile),
      trees: await read($, trees),
      busy: { ...b, disk: b.disk || (await read($, weekBusy)) },
      openRow: await read($, openRow),
      project,
      saved: await read($, saved),
      ceiling: s.ceiling,
      columns: e.props.bodyColumns || PANE_COLUMNS,
      now,
      desktop: e.surface === 'desktop',
    }, {
      setTab: t => void (async () => {
        await update($, tab, () => t)
        $.ui.invalidate('ui.render')
        await readView($, t)
      })().catch(() => {}),
      refresh: t => void readView($, t, true).catch(() => {}),
      compact: () => void compactFromStrip($),
      handover: () => void $.prompt.submit({ text: HANDOVER, asUser: true }).catch(() => $.ui.toast('Usage Coach: the hand-over request did not go through')),
      toggleRow: id => void update($, openRow, r => (r === id ? null : id)).then(() => $.ui.invalidate('ui.render')),
      resume: row => void copyResume($, row, e.surface),
      reveal: path => void $.process.run(['open', '-R', path], { timeoutMs: 10_000 }).catch(() => {}),
      trashSessions: (paths, bytes, olderDays) => void trashSessions($, paths, bytes, olderDays).catch(() => {}),
      removeWorktrees: (paths, bytes) => void removeWorktrees($, paths, bytes).catch(() => {}),
      clearXcode: (folders, bytes) => void clearXcode($, folders, bytes).catch(() => {}),
      shutdownSim: (udid, name, mb) => void shutdownSim($, udid, name, mb).catch(() => {}),
      keepDays: () => void keepDays($).catch(() => {}),
    })
  }).catch(($, e, next) => {
    // Never leave the pane blank: say what failed, so it can be fixed.
    const { Box, Text } = $.ui.resolve(e)
    const why = next.error?.kind === 'timeout' ? 'it took too long to draw' : (next.error?.message ?? 'unknown error').slice(0, 300)
    return Box({ flexDirection: 'column', padding: 1, children: [
      Text({ bold: true, children: 'Usage Coach could not draw this view' }),
      Text({ dimColor: true, children: why }),
      Text({ dimColor: true, children: 'Close the pane and open it again with ☰. If it stays, send a screenshot of this.' }),
    ] })
  })

  // A weight under heavy outputs and every subagent run.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const below = await next(e)
    const w = (await read($, live)).weights.find(x => x.id === e.props.tool_use_id)
    if (!w || !below) return below
    const { Box, Text } = $.ui.resolve(e)
    const text = w.isAgent
      ? `◆ Subagent · ${tok(w.tokens)} tokens${w.ms ? ' · ' + seconds(w.ms) : ''}${w.usd ? ' · ≈ ' + money(w.usd) : ''}${w.model ? ' · ' + w.model.replace(/^claude-/, '') : ''}`
      : `◆ Large output · ${tok(w.tokens)} tokens now in context: every later message sends them again`
    return Box({ flexDirection: 'column', children: [below, Text({ key: 'w', color: w.isAgent ? '#b866e6' : '#e0a030', children: text })] })
  })

  // The best suggestion as the empty prompt's hint.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.isDraft || e.props.isWorking) return next(e)
    const l = await read($, live)
    const tip = tipOf(suggestionsOf(l, await $.clock.now(), s)[0])
    return tip ? next({ ...e, props: { ...e.props, hint: tip } }) : next(e)
  })
}
