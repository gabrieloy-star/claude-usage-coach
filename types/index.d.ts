/** A rate-limit window as Claude reports it: `five_hour`, `seven_day`, or a gateway's. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** One reading of a usage limit, for the pace. */
export type LimitSample = { at: number; pct: number }

/** A step Claude failed on, in a row: the same command or file. */
export type Loop = { key: string; label: string; count: number; usdAtFirst: number; isTold: boolean }

/** What one compaction saved, in list-price dollars: kept 7 days in the store. */
export type Saving = { id: string; at: number; kind: 'idle' | 'button'; usd: number }

/** A compaction whose saving is still being counted. */
export type SavingRun = {
  id: string
  kind: 'idle' | 'button'
  /** Dollars so far; the compaction's own cost counts against it. */
  usd: number
  /** What each later request saves (button), or 0 when the saving comes at once (idle). */
  perRequest: number
  /** Idle only: the cache would have expired here; a return before it saved nothing. */
  expiresAt?: number
  /** Idle only: when it compacted; a turn that started before it is the compaction's own. */
  at?: number
}

/** One main-loop turn, as the ledger line and the Session tab read it. */
export type Turn = {
  /** When it ended, in `$.clock.now()` milliseconds. */
  at: number
  ms: number
  /** Context tokens it added (0 after a compaction). */
  added: number
  /** Dollars it cost at list prices. */
  usd: number
  /** Share of its input read from the prompt cache, 0 to 1. */
  cached: number
  /** Share of its cost spent by subagents, 0 to 1. */
  agentShare: number
  /** True when its first request found the cache expired and wrote the context again. */
  isCold: boolean
  /** Output tokens the main loop wrote. */
  out?: number
  /** Tool calls the main loop made. */
  tools?: number
  /** The model that answered. */
  model?: string
  /** Main-loop requests it made. */
  requests?: number
  /** The first words of your request; absent when the turn continued without one. */
  prompt?: string
}

/** A heavy tool output or a subagent run: what the weight under its row shows. */
export type Weight = {
  id: string
  tool: string
  label: string
  tokens: number
  isAgent: boolean
  usd?: number
  ms?: number
  model?: string
  agentType?: string
}

/** What the strip and the pane draw from. Plain data: the host keeps it across reloads. */
export type Live = {
  /** When the session began, in `$.clock.now()` milliseconds: the session's start. */
  startedAt: number | null
  /** Context tokens now, and the window they fill. */
  tokens: number | null
  window: number
  /** Tokens every request carries before the conversation: system prompt, tools, memory, skills. */
  fixed: number | null
  /** Conversation tokens (the part a compaction shrinks). */
  conversation: number | null
  /** Tokens each recent turn added, oldest first. */
  adds: number[]
  /** Start of the last main-loop request: the prompt cache's lifetime runs from here. */
  cacheAt: number | null
  /** How long the prompt cache lives: 1 hour, or 5 minutes when Claude writes the short cache. */
  cacheTtl?: number
  model: string
  limits: Limit[]
  usd: number | null
  /** Session cost when the current turn started. */
  turnBase: number | null
  turns: Turn[]
  weights: Weight[]
  /** MCP servers whose tool schemas ride on every request, with their tokens. */
  mcp: { server: string; tokens: number }[]
  /** MCP servers called at least once this session. */
  mcpUsed: string[]
  budgetWarned: boolean
  lastToastAt: number
  /** Recent readings of each usage limit, by kind. */
  limitSamples?: Record<string, LimitSample[]>
  /** Forecasts already said, as `kind@resetsAt`. */
  toldPace?: string[]
  /** The step Claude is failing on, while the failures run. */
  loop?: Loop | null
  /** The compaction whose saving is being counted. */
  savingRun?: SavingRun | null
}

/** The pane's three views. A value an older version stored ('suggestions', 'week', …) reads as 'session'. */
export type Tab = 'session' | 'project' | 'all'

/** Tokens by kind, as the week scanner sums them. */
export type Tokens = { input: number; output: number; read: number; write5m: number; write1h: number }

/** The week scanner's report (scripts/week.mjs), stamped with when it was read. */
export type Week = {
  at: number
  since: string
  sessions: number
  requests: number
  /** Tokens by model, main conversations and subagents apart. */
  main: Record<string, Tokens>
  sub: Record<string, Tokens>
  /** Subagent runs by agent type: runs and total tokens. */
  agentTypes: Record<string, { runs: number; tokens: number }>
  /** Requests that wrote 100k or more of context to the cache (a cold return), by model. */
  cold: { count: number; byModel: Record<string, number> }
  projects: { name: string; tokens: number }[]
  /** The 7 days before: tokens by model. */
  prev?: { main: Record<string, Tokens>; sub: Record<string, Tokens> }
  /** Tokens by model for the top projects, this week and the one before. */
  byProject?: Record<string, { cur: Record<string, Tokens>; prev: Record<string, Tokens> }>
  /** Today since midnight, all sessions: tokens by model. */
  today?: Record<string, Tokens>
  /** This session's cost when the scanner ran: what today adds on top. */
  sessionUsdAtScan?: number
  /** Tokens per local day ("2026-11-13"), over every day read: your conversations, subagents, cache reads. */
  days?: Record<string, { main: number; sub: number; read: number }>
}

/** Sessions of one age: today, the last 7 days, 7 to 30 days, over 30 days (in that order). */
export type AgeBucket = { count: number; bytes: number }

/** One project's sessions on disk (scripts/disk.mjs): its folder and every worktree folder of it. */
export type DiskProject = {
  key: string
  name: string
  sessions: number
  bytes: number
  last: number
  ages: AgeBucket[]
  folders: number
  worktrees: number
  agentWorktrees: number
}

/** One session on disk. `hold` says why it must not be moved (open, recent, this session). */
export type DiskSession = { id: string; path: string; where: string; bytes: number; sub: number; at: number; hold?: string; title?: string; cwd?: string }

/** A Claude Code session process: its memory, how long it has run, and its folder. */
export type ClaudeProcess = { pid: number; mb: number; secs: number; cwd: string; key: string }

/** The disk scanner's report. */
export type Disk = {
  at: number
  ms: number
  total: { bytes: number; sessions: number; conversations: number; subagents: number; toolResults: number }
  projects: DiskProject[]
  /** Sessions over 30 days old that nothing holds: what Trash would move. */
  old30: { count: number; bytes: number; paths: string[]; held: number }
  /** What keeping sessions 14 or 7 days would delete, and how many are still in the Desktop sidebar. */
  keep: { days: number; count: number; bytes: number; sidebar: number }[]
  cleanupDays: number | null
  procs: ClaudeProcess[]
  project?: { key: string; top: DiskSession[]; stale: DiskSession[] }
}

/** A worktree folder of a repo. `why` lists what keeps it; absent, removing it loses nothing. */
export type Worktree = { path: string; name: string; bytes: number; why?: string[] }
export type RepoTrees = { repo: string; name: string; main: string; bytes: number; trees: Worktree[] }

/** An Xcode build folder: orphan (its project is gone), old (unused 7 days), recent, or none (no information). */
export type XcodeBuild = { folder: string; bytes: number; state: 'orphan' | 'old' | 'recent' | 'none'; workspace?: string; last?: number; project?: string }

export type SimDevice = { udid: string; name: string; state: string; bytes: number; mb?: number }

/** The Mac scanner's report (scripts/mac.mjs). */
export type Mac = {
  at: number
  disk: { total: number; used: number; free: number } | null
  repos: RepoTrees[]
  xcode: { bytes: number; isBuilding: boolean; builds: XcodeBuild[] }
  sims: { bytes: number; devices: SimDevice[] }
  app: { bytes: number }
  memory: { totalMb: number; freePct: number | null; sessionsMb: number; sessions: number; appMb: number; simMb: number }
  /** Builds, tests or simctl commands running: a simulator is not shut down while any runs. */
  simBusy: number
  took: number
}

/** One session's profile (scripts/session.mjs). */
export type Profile = {
  at: number
  id: string
  bytes: number
  prompts: number
  requests: number
  firstAt: number
  lastAt: number
  /** Tokens sent over the whole session. */
  sent: number
  /** Context of each request: [when, tokens]. */
  series: [number, number][]
  compactions: number[]
  cold: number[]
  heavy: { label: string; at: number; tokens: number; requests: number }[]
  /** What filled the context, in tokens: tool outputs by tool, Claude's answers and edits, your messages. */
  filled: { tools: Record<string, number>; claude: number; you: number }
  own: { pid: number; mb: number; running: { pid: number; mb: number; what: string; secs: number }[] } | null
}

/** Scans and actions running now, so the pane says so. */
export type Busy = { disk: boolean; mac: boolean; profile: boolean; action: string | null }

/** One step of Claude's step list (TodoWrite, TaskCreate, the desktop app's update_plan). */
export type StepStatus = 'pending' | 'in_progress' | 'completed'
export type Step = { id?: string; title: string; status: StepStatus }
/** Claude's current step list: `created` counts every step added in this run; `doneAt` is when the last one finished. */
export type Steps = { items: Step[]; startedAt: number; created: number; doneAt: number | null }

/** A question or a permission prompt Claude is waiting on. */
export type Waiting = { since: number; kind: 'question' | 'permission'; label: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-coach': {
      live: Live
      tab: Tab
      week: Week | null
      weekBusy: boolean
      disk: Disk | null
      mac: Mac | null
      profile: Profile | null
      /** The worktrees of the session's own repo, for the Project view. */
      trees: RepoTrees | null
      busy: Busy
      /** The session row of the Project view whose actions are shown. */
      openRow: string | null
      saved: { usd: number; count: number }
      isWelcome: boolean
      steps: Steps | null
      waiting: Waiting | null
    }
  }
}
