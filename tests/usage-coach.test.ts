import { expect, test } from 'claude-code/testing'

import type { Disk, DiskSession, Live, Mac, Profile, RepoTrees } from '../types'
import { CEILING, HOUR, MINUTE, cacheLeft, contextTone, markOf, suggestionsOf, tipOf, whenOf } from '../hooks/suggestions'
import { compactUsd, priceOf, rewriteUsd } from '../hooks/prices'
import { drawStrip, familyWeek, statusCard } from '../hooks/strip'
import { buildsOf, claudeBytes, drawPane, promptsToCeiling, safeBuilds, safeTrees, size } from '../hooks/pane'
import type { PaneInput } from '../hooks/pane'
import { summarize } from '../hooks/week'
import { insightsOf, modelName } from '../hooks/insights'
import { loopStep, paceOf, promptLine, recordSaving, sampleLimit, savedThisWeek, stepOf, tasksOf, todayUsd, trendOf } from '../hooks/signals'

const NOW = Date.parse('2026-10-18T15:00:00Z')
const SETTINGS = { minTokens: 40_000, budget: 100, minSaving: 1 }
const ALL = { ...SETTINGS, minSaving: 0 }

function live(over: Partial<Live> = {}): Live {
  return {
    startedAt: NOW - HOUR, tokens: 186_000, window: 1_000_000, fixed: 46_000, conversation: 140_000, adds: [3_000, 31_000],
    cacheAt: NOW - 10 * MINUTE, model: 'claude-opus-5-5', limits: [], usd: 9.8, turnBase: 5.68,
    turns: [], weights: [], mcp: [], mcpUsed: [], budgetWarned: false, lastToastAt: 0, ...over,
  }
}

test('prices follow the current list', () => {
  expect(priceOf('claude-opus-5-5[1m]')).toEqual({ input: 4, output: 20, read: 0.2 })
  expect(priceOf('claude-fable-5-1').read).toBe(0.25)
  expect(priceOf('claude-haiku-5-5').input).toBe(0.1)
  // A cold 200k return on Opus 5.5: 200k at twice $4 per million.
  expect(Math.round(rewriteUsd(200_000, 'claude-opus-5-5') * 100)).toBe(160)
  expect(compactUsd(200_000, 'claude-opus-5-5')).toBeLessThan(0.3)
})

test('a warm, quiet session has nothing to fix', () => {
  expect(suggestionsOf(live({ tokens: 60_000, conversation: 20_000 }), NOW, SETTINGS)).toEqual([])
})

test('the cache countdown follows the cache Claude wrote: 1 hour or 5 minutes', () => {
  expect(cacheLeft(live({ cacheAt: NOW - 10 * MINUTE }), NOW)).toBe(50 * MINUTE)
  expect(cacheLeft(live({ cacheAt: NOW - 2 * MINUTE, cacheTtl: 5 * MINUTE }), NOW)).toBe(3 * MINUTE)
})

test('small savings are not suggested', () => {
  // A 12k tool output on Opus 5.5 saves cents: hidden at the $1 default, listed when the floor is 0.
  const l = live({ weights: [{ id: 'r', tool: 'Read', label: 'big file', tokens: 12_000, isAgent: false }] })
  expect(suggestionsOf(l, NOW, SETTINGS).some(m => m.id === 'output')).toBe(false)
  expect(suggestionsOf(l, NOW, ALL).some(m => m.id === 'output')).toBe(true)
})

test('a cache about to expire offers to compact, with the saving', () => {
  const suggestions = suggestionsOf(live({ tokens: 296_000, conversation: 250_000, cacheAt: NOW - 50 * MINUTE }), NOW, SETTINGS)
  const brk = suggestions.find(m => m.id === 'break')!
  expect(brk.key).toBe('c')
  expect(brk.usd).toBeGreaterThan(1.5)
  // 140k of conversation saves under $1 on Opus 5.5: not worth a suggestion.
  expect(suggestionsOf(live({ cacheAt: NOW - 50 * MINUTE }), NOW, SETTINGS)).toEqual([])
  expect(tipOf(brk)).toContain('click compact')
})

test('a cold, huge context suggests a fresh thread, not a resend', () => {
  const suggestions = suggestionsOf(live({ tokens: 320_000, conversation: 274_000, cacheAt: NOW - 2 * HOUR }), NOW, SETTINGS)
  expect(suggestions[0]!.id).toBe('fresh')
  expect(suggestions[0]!.tone).toBe('hot')
})

test('idle MCP servers are named once a few messages went by', () => {
  const turn = { at: NOW, ms: 1000, added: 0, usd: 0.1, cached: 1, agentShare: 0, isCold: false }
  const l = live({ mcp: [{ server: 'linear', tokens: 9_000 }, { server: 'github', tokens: 6_000 }], mcpUsed: ['github'], turns: [turn, turn, turn] })
  const mcp = suggestionsOf(l, NOW, ALL).find(m => m.id === 'mcp')!
  expect(mcp.title).toBe('Turn off 1 unused MCP server')
  expect(mcp.how).toContain('linear')
})

test('a heavy general-purpose subagent points to Explore', () => {
  const l = live({ weights: [{ id: 'a', tool: 'Agent', label: 'find callers', tokens: 17_500_000, isAgent: true, usd: 3.5, agentType: 'general-purpose' }] })
  expect(suggestionsOf(l, NOW, SETTINGS).some(m => m.id === 'explore')).toBe(true)
})

// A stand-in element table: each element is its props, so the strip's choices can be read back.
const el = {
  Box: (p: any) => ({ type: 'Box', ...p }),
  Text: (p: any) => ({ type: 'Text', ...p }),
  Button: (p: any) => ({ type: 'Button', ...p }),
  Svg: (p: any) => ({ type: 'Svg', ...p }),
}

// Props the engine's Box accepts; anything else makes it refuse the whole tree.
const BOX_PROPS = new Set(['type', 'key', 'children', 'hover', 'position', 'top', 'left', 'right', 'bottom', 'flexDirection', 'flexGrow', 'flexShrink',
  'flexWrap', 'alignItems', 'alignSelf', 'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'margin',
  'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom',
  'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display'])

function refusedBoxProps(node: any, found: string[] = []): string[] {
  if (Array.isArray(node)) { for (const n of node) refusedBoxProps(n, found); return found }
  if (!node || typeof node !== 'object') return found
  if (node.type === 'Box') for (const k of Object.keys(node)) if (!BOX_PROPS.has(k)) found.push(k)
  // The engine refuses a keyed Box that starts hidden and shows on hover: the pointer can never be over it.
  if (node.type === 'Box' && node.key !== undefined && node.display === 'none' && node.hover) found.push('hidden keyed hover Box ' + node.key)
  refusedBoxProps(node.children, found)
  return found
}

function partsAt(columns: number, desktop: boolean) {
  const l = live({ limits: [{ kind: 'five_hour', percentUsed: 61 }, { kind: 'seven_day', percentUsed: 41 }], cacheAt: NOW - 52 * MINUTE })
  const tree: any = drawStrip(el, { live: l, week: null, suggestion: suggestionsOf(l, NOW, SETTINGS)[0], insights: 2, now: NOW, columns, desktop, onSuggestion() {}, onOpen() {}, onInsights() {} })
  return (tree.children as any[]).map(c => c.key as string)
}

test('the details card shows both usage limits with reset times and the week of Fable', () => {
  const t = (n: number) => ({ input: 0, output: 0, read: n, write5m: 0, write1h: 0 })
  const week = {
    at: NOW, since: '7d', sessions: 1, requests: 1, main: { 'claude-fable-5-1': t(40_000_000), 'claude-opus-5-5': t(9_000_000) },
    sub: { 'claude-fable-5-1': t(10_000_000) }, agentTypes: {}, cold: { count: 0, byModel: {} }, projects: [],
  }
  const l = live({ limits: [
    { kind: 'five_hour', percentUsed: 61, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
    { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOW + 50 * HOUR).toISOString() },
  ] })
  const card = statusCard({ live: l, week, suggestion: undefined, insights: 0, now: NOW, columns: 160, desktop: true, onSuggestion() {}, onOpen() {}, onInsights() {} })
  const text = [...(card.meters ?? []), ...card.rows].map(r => `${r.label} ${r.value ?? ''}`).join('\n')
  expect(text).toContain('5-hour limit 39% left · resets in 2h00')
  expect(text).toContain('Weekly limit 59% left · resets in 2d2h')
  expect(text).toContain('Fable · 7 days 50M tokens')
  // No dollars in the card: tokens and limits say it.
  expect(text).not.toContain('$')
  expect(familyWeek(week, 'fable').tokens).toBe(50_000_000)
})

test('the strip keeps the most important parts that fit, on one line', () => {
  for (const desktop of [false, true]) {
    const wide = partsAt(160, desktop)
    // The usage limits and the session cost are not on the strip: the details card has them.
    expect(wide.filter(k => k !== 'suggestion')).toEqual(['context', 'cache', 'insights', 'compact', 'open'])
    const narrow = partsAt(60, desktop)
    expect(narrow[0]).toBe('context')
    expect(narrow).toContain('open')
    expect(narrow.some(k => k.startsWith('limit') || k === 'spend')).toBe(false)
  }
})

test('the week folds into money and lessons', () => {
  const t = (read: number) => ({ input: 0, output: 1_000_000, read, write5m: 0, write1h: 10_000_000 })
  const s = summarize({
    at: NOW, since: '7d', sessions: 10, requests: 100,
    main: { 'claude-opus-5-5': t(300_000_000) }, sub: { 'claude-opus-5-5': t(900_000_000) },
    agentTypes: { 'general-purpose': { runs: 30, tokens: 900_000_000 } }, cold: { count: 12, byModel: { 'claude-opus-5-5': 2_400_000 } }, projects: [],
  })
  expect(s.lessons[0]).toContain('Subagents spent')
  expect(s.lessons.some(l => l.includes('12 times'))).toBe(true)
})

// ---------- The pane: Session, Project, All projects ----------

const DAYMS = 24 * HOUR
const GB = 1e9
const ROOT = '/Users/me/apps_dev/shop'
const KEY = '-Users-me-apps-dev-shop'

function profileOf(): Profile {
  const series: [number, number][] = Array.from({ length: 60 }, (_, i) => [NOW - (60 - i) * HOUR, 40_000 + i * 3_000])
  return {
    at: NOW - MINUTE, id: 'abc', bytes: 120e6, prompts: 42, requests: 300, firstAt: NOW - 3 * DAYMS, lastAt: NOW, sent: 9e7,
    series, compactions: [NOW - 30 * HOUR], cold: [NOW - 20 * HOUR],
    heavy: [{ label: '“fix the login redirect”', at: NOW - 2 * DAYMS, tokens: 2e7, requests: 80 }, { label: 'Skill', at: NOW - DAYMS, tokens: 5e6, requests: 10 }],
    filled: { tools: { Bash: 60_000, Read: 30_000, Browser: 10_000 }, claude: 40_000, you: 5_000 },
    own: { pid: 1, mb: 900, running: [{ pid: 2, mb: 300, what: 'npm run dev', secs: 7200 }] },
  }
}

const session = (id: string, over: Partial<DiskSession> = {}): DiskSession => ({ id, path: `/Users/me/.claude/projects/${KEY}/${id}.jsonl`, where: 'main', bytes: 50e6, sub: 0, at: NOW - 40 * DAYMS, title: 'old work', cwd: ROOT, ...over })

function diskOf(): Disk {
  return {
    at: NOW - MINUTE, ms: 1700,
    total: { bytes: 22 * GB, sessions: 1400, conversations: 10 * GB, subagents: 8 * GB, toolResults: 4 * GB },
    projects: [{ key: KEY, name: 'shop', sessions: 120, bytes: 9 * GB, last: NOW, ages: [{ count: 3, bytes: 0.4 * GB }, { count: 20, bytes: 2 * GB }, { count: 60, bytes: 5 * GB }, { count: 37, bytes: 1.6 * GB }], folders: 30, worktrees: 29, agentWorktrees: 2 }],
    old30: { count: 18, bytes: 1.3 * GB, paths: ['/a.jsonl'], held: 1 },
    keep: [{ days: 14, count: 90, bytes: 1.6 * GB, sidebar: 0 }, { days: 7, count: 400, bytes: 10.8 * GB, sidebar: 187 }],
    cleanupDays: null,
    procs: [{ pid: 9, mb: 600, secs: 2 * DAYMS, cwd: ROOT + '/.claude/worktrees/fix-a1b2c3', key: KEY }, { pid: 10, mb: 300, secs: HOUR / 1000, cwd: ROOT, key: KEY }],
    project: { key: KEY, top: [session('s1', { at: NOW - HOUR, hold: 'this session' }), session('s2')], stale: [session('s2'), session('s3', { hold: 'open in the Desktop sidebar' })] },
  }
}

function treesOf(): RepoTrees {
  return { repo: ROOT, name: 'shop', main: 'main', bytes: 12 * GB, trees: [
    { path: ROOT + '/.claude/worktrees/done', name: 'done', bytes: 5 * GB },
    { path: ROOT + '/.claude/worktrees/dirty', name: 'dirty', bytes: 4 * GB, why: ['pending changes'] },
    { path: ROOT + '/.claude/worktrees/open', name: 'open', bytes: 3 * GB, why: ['a Desktop session is open in it', 'work not in main'] },
  ] }
}

function macOf(over: Partial<Mac> = {}): Mac {
  return {
    at: NOW - HOUR, disk: { total: 926 * GB, used: 772 * GB, free: 154 * GB }, repos: [treesOf()],
    xcode: { bytes: 20 * GB, isBuilding: false, builds: [
      { folder: '/x/Shop-a', bytes: 8 * GB, state: 'orphan', workspace: ROOT + '/.claude/worktrees/gone/Shop.xcodeproj', project: 'Shop' },
      { folder: '/x/Shop-b', bytes: 7 * GB, state: 'old', workspace: ROOT + '/Shop.xcodeproj', project: 'Shop' },
      { folder: '/x/Shop-c', bytes: 5 * GB, state: 'recent', workspace: ROOT + '/Shop.xcodeproj', project: 'Shop' },
    ] },
    sims: { bytes: 38 * GB, devices: [{ udid: 'U1', name: 'iPhone 17', state: 'Booted', bytes: 6 * GB, mb: 6000 }] },
    app: { bytes: 17 * GB },
    memory: { totalMb: 32768, freePct: 20, sessionsMb: 3000, sessions: 13, appMb: 1500, simMb: 6000 },
    simBusy: 0, took: 110_000, ...over,
  }
}

const IDLE_BUSY = { disk: false, mac: false, profile: false, action: null }
const PROJECT = { key: KEY, name: 'shop', root: ROOT }

function pressed() {
  const calls: string[] = []
  const act = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => calls.push(`${String(name)}:${JSON.stringify(args)}`) }) as any
  return { calls, act }
}

/** Every Button in a tree, by its label. */
function buttons(node: any, found: Record<string, any> = {}): Record<string, any> {
  if (Array.isArray(node)) { for (const n of node) buttons(n, found); return found }
  if (!node || typeof node !== 'object') return found
  if (node.type === 'Button') found[node.label ?? node.key] = node
  buttons(node.children, found)
  return found
}

function paneOf(over: Partial<PaneInput> = {}, desktop = true) {
  const l = live({ startedAt: NOW - 3 * DAYMS, tokens: 197_000, fixed: 46_000, adds: [3_000, 4_000, 5_000], limits: [{ kind: 'five_hour', percentUsed: 61 }] })
  const { calls, act } = pressed()
  const t = (n: number) => ({ main: n, sub: n / 2, read: n })
  const days = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`2026-10-${String(5 + i).padStart(2, '0')}`, t(1e7 + i * 1e6)]))
  const tree: any = drawPane(el, {
    tab: 'session', live: l, suggestions: suggestionsOf(l, NOW, SETTINGS), insights: [], week: { ...weekOf(), days }, disk: diskOf(), mac: macOf(), profile: profileOf(),
    trees: treesOf(), busy: IDLE_BUSY, openRow: null, project: PROJECT, columns: 56, now: NOW, desktop, ...over,
  }, act)
  return { tree, text: JSON.stringify(tree), calls, buttons: buttons(tree) }
}

test('every view draws on both surfaces, with nothing the engine refuses', () => {
  for (const desktop of [false, true]) {
    for (const tab of ['session', 'project', 'all', 'suggestions'] as const) {
      for (const empty of [false, true]) {
        const over = empty ? { disk: null, mac: null, profile: null, trees: null, week: null } : {}
        const { tree, text } = paneOf({ tab, ...over }, desktop)
        expect(tree.type).toBe('Box')
        expect(text).not.toContain('"plain":false')
        expect(refusedBoxProps(tree)).toEqual([])
        // A Button holds strings and Text only.
        for (const b of Object.values(buttons(tree))) expect(b.children === undefined || typeof b.children === 'string').toBe(true)
      }
    }
  }
})

test('the Session view shows the context, what filled it and the heaviest prompts, in tokens', () => {
  const { text, buttons: b } = paneOf({ tab: 'session' })
  expect(text).toContain('tokens per message')
  expect(text).toContain('42 prompts')
  expect(text).toContain('1× compacted')
  expect(text).toContain('1× cold cache')
  expect(text).toContain('WHAT FILLED IT')
  expect(text).toContain('Bash outputs')
  expect(text).toContain('fix the login redirect')
  expect(text).toContain('npm run dev')
  // Long and heavy: a hand-over note first, compact second.
  expect(Object.keys(b)).toContain('↻ Hand-over note')
  expect(Object.keys(b)).toContain('⇣ Compact')
  expect(text).not.toContain('Today · all sessions')
})

test('the forecast says how many prompts until the ceiling', () => {
  expect(promptsToCeiling(live({ tokens: 400_000, adds: [10_000, 10_000, 10_000] }), 500_000)).toBe(10)
  expect(promptsToCeiling(live({ tokens: 520_000 }), 500_000)).toBe(0)
  expect(promptsToCeiling(live({ tokens: 100_000, adds: [] }), 500_000)).toBe(null)
})

test('the Project view offers only what passes every check', () => {
  const { text, buttons: b, calls } = paneOf({ tab: 'project' })
  expect(text).toContain('shop')
  // One of three worktrees is safe: 5 GB.
  const wt = b['Remove 1 · 5.0 GB']
  expect(wt).toBeDefined()
  wt.onPress()
  expect(calls.at(-1)).toBe(`removeWorktrees:[["${ROOT}/.claude/worktrees/done"],5000000000]`)
  // The orphan and the old build go while nothing builds; the recent one stays.
  expect(b['Clear old · 15.0 GB']).toBeDefined()
  // Old sessions: the held one is left out.
  const stale = b['⌫ Trash 1 old · 50 MB']
  expect(stale).toBeDefined()
  stale.onPress()
  expect(calls.at(-1)).toContain('trashSessions:[["/Users/me/.claude/projects/')
  expect(calls.at(-1)).toContain(',30]')
  expect(text).toContain('SESSIONS BY AGE')
  expect(text).toContain('1 open > 1 d')
})

test('a building Mac keeps old Xcode builds; orphans can still go', () => {
  expect(safeBuilds(macOf().xcode.builds, true).bytes).toBe(8 * GB)
  expect(safeBuilds(macOf().xcode.builds, false).bytes).toBe(15 * GB)
  expect(buildsOf(macOf().xcode.builds, ROOT).length).toBe(3)
  expect(buildsOf(macOf().xcode.builds, '/Users/me/apps_dev/sho').length).toBe(0)
})

test('a session row shows its actions when pressed, and a held one cannot be trashed', () => {
  const closed = paneOf({ tab: 'project' })
  expect(closed.buttons['⧉ Resume']).toBeUndefined()
  const held = paneOf({ tab: 'project', openRow: 's1' })
  expect(held.buttons['⧉ Resume']).toBeDefined()
  expect(held.buttons['⌫ Trash']).toBeUndefined()
  expect(held.text).toContain('this session')
  const free = paneOf({ tab: 'project', openRow: 's2' })
  free.buttons['⌫ Trash'].onPress()
  expect(free.calls.at(-1)).toContain('s2.jsonl')
})

test('the All projects view sums Claude\'s work and offers each safe cleanup', () => {
  const { text, buttons: b, calls } = paneOf({ tab: 'all' })
  // Sessions 22 + worktrees 12 + Xcode 20 + simulators 38 + app 17.
  expect(claudeBytes(diskOf(), macOf())).toBe(109 * GB)
  expect(text).toContain('154 GB free')
  expect(b['Remove 1 · 5.0 GB']).toBeDefined()
  expect(b['Keep 14 d · 1.6 GB']).toBeDefined()
  b['Shut down'].onPress()
  expect(calls.at(-1)).toBe('shutdownSim:["U1","iPhone 17",6000]')
  expect(text).toContain('OPEN SESSIONS · 2')
  expect(text).toContain('TOKENS')
  expect(text).toContain('this week')
})

test('a simulator in use cannot be shut down, and sidebar sessions stop Keep 14 days', () => {
  const d = diskOf()
  const { buttons: b, text } = paneOf({ tab: 'all', mac: macOf({ simBusy: 1 }), disk: { ...d, keep: [{ ...d.keep[0]!, sidebar: 3 }, d.keep[1]!] } })
  expect(b['Shut down']).toBeUndefined()
  expect(text).toContain('in use')
  expect(Object.keys(b).some(k => k.startsWith('Keep'))).toBe(false)
  expect(b['⌫ 18 old · 1.3 GB']).toBeDefined()
})

test('the All projects view measures the Mac on request', () => {
  const { buttons: b, calls } = paneOf({ tab: 'all', mac: null })
  b['Measure this Mac'].onPress()
  expect(calls.at(-1)).toBe('refresh:["all"]')
  expect(paneOf({ tab: 'all', mac: null, busy: { ...IDLE_BUSY, mac: true } }).text).toContain('Measuring the Mac')
})

test('safe worktrees leave out any with a reason to stay', () => {
  expect(safeTrees([treesOf()])).toEqual({ paths: [ROOT + '/.claude/worktrees/done'], bytes: 5 * GB })
  expect(size(988e6)).toBe('988 MB')
  expect(size(10.44e9)).toBe('10.4 GB')
  expect(size(154e9)).toBe('154 GB')
})

test('Fable on routine work points to Opus, and says what switching costs', () => {
  const turn = { at: NOW, ms: 20_000, added: 2_000, usd: 0.4, cached: 0.97, agentShare: 0, isCold: false, out: 900, tools: 1, model: 'claude-fable-5-1' }
  const l = live({ model: 'claude-fable-5-1', turns: [turn, turn, turn, turn, turn] })
  const fit = insightsOf(l, null, NOW).find(i => i.id === 'model-fable')!
  expect(fit.title).toBe('Fable 5.1 may be more than this work needs')
  expect(fit.how).toContain('/model opus')
  expect(fit.how).toContain('switching mid-task')
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
})

test('hard work on a top model raises no model insight', () => {
  const turn = { at: NOW, ms: 300_000, added: 20_000, usd: 3, cached: 0.97, agentShare: 0, isCold: false, out: 12_000, tools: 25, model: 'claude-fable-5-1' }
  const l = live({ model: 'claude-fable-5-1', turns: [turn, turn, turn, turn, turn] })
  expect(insightsOf(l, null, NOW).filter(i => i.kind === 'model')).toEqual([])
})

test('a queued compaction shows on the strip until it runs', () => {
  const l = live({ tokens: 296_000, conversation: 250_000, cacheAt: NOW - 50 * MINUTE })
  const tree: any = drawStrip(el, { live: l, week: null, suggestion: suggestionsOf(l, NOW, SETTINGS)[0], insights: 0, now: NOW, columns: 160, desktop: false, isQueued: true, onSuggestion() {}, onOpen() {}, onInsights() {} })
  // The compact icon turns to an ellipsis while the compaction waits.
  expect((tree.children as any[]).find(c => c.key === 'compact').children[0].label).toBe('…')
  expect(JSON.stringify(tree)).toContain('"label":"☰"')
})

// ---------- Round 2: limit forecast, failing loop, tasks, savings, week over week ----------

const five = (pct: number, resetIn = 3 * HOUR) => ({ kind: 'five_hour', percentUsed: pct, resetsAt: new Date(NOW + resetIn).toISOString() })

test('a steady climb forecasts when the 5-hour limit runs out', () => {
  // 40% → 60% over 40 minutes: 30% an hour, so the last 40% lasts 80 minutes.
  const samples = [{ at: NOW - 40 * MINUTE, pct: 40 }, { at: NOW - 20 * MINUTE, pct: 50 }, { at: NOW, pct: 60 }]
  const pace = paceOf(five(60), samples, NOW)!
  expect(pace.runsOutAt).toBe(NOW + 80 * MINUTE)
  expect(pace.isShort).toBe(true)
  expect(pace.tone).toBe('hot')
  expect(Math.round(pace.perHour)).toBe(30)
  // Flat, or running out only after the reset: no warning.
  expect(paceOf(five(60), samples.map(x => ({ ...x, pct: 60 })), NOW)).toBe(null)
  expect(paceOf(five(60, HOUR), samples, NOW)!.isShort).toBe(false)
  // Too few readings, or too short a stretch, say nothing.
  expect(paceOf(five(60), samples.slice(1), NOW)).toBe(null)
  // A drop means the window reset: the samples start over.
  expect(sampleLimit(samples, NOW + MINUTE, 3)).toEqual([{ at: NOW + MINUTE, pct: 3 }])
})

test('the forecast reaches insights, the tooltip and the details card', () => {
  const samples = [{ at: NOW - 40 * MINUTE, pct: 40 }, { at: NOW - 20 * MINUTE, pct: 50 }, { at: NOW, pct: 60 }]
  const l = live({ limits: [five(60)], limitSamples: { five_hour: samples } })
  const pace = insightsOf(l, null, NOW).find(i => i.id === 'limit-five_hour')!
  expect(pace.kind).toBe('now')
  expect(pace.title).toContain('5-hour limit runs out today')
  const input = { live: l, week: null, suggestion: undefined, insights: 1, now: NOW, columns: 200, desktop: true, onSuggestion() {}, onOpen() {}, onInsights() {} }
  expect(statusCard(input).rows.find(r => r.label.includes('runs out'))!.value).toContain('today')
})

test('three failures in a row on the same step raise the flag', () => {
  const step = stepOf('Bash', { command: 'npm test -- --grep 12' })
  let loop = loopStep(null, step, true, 5)
  loop = loopStep(loop, stepOf('Bash', { command: 'npm test -- --grep 13' }), true, 5.5)
  loop = loopStep(loop, step, true, 6)
  expect(loop!.count).toBe(3)
  expect(loop!.usdAtFirst).toBe(5)
  // A success, or another step, starts it over.
  expect(loopStep(loop, step, false, 6)).toBe(null)
  expect(loopStep(loop, stepOf('Edit', { file_path: '/a/b/c.ts' }), true, 6)!.count).toBe(1)
  const l = live({ usd: 7.4, loop: { ...loop!, isTold: true } })
  const suggestions = suggestionsOf(l, NOW, SETTINGS)
  expect(suggestions[0]!.id).toBe('loop')
  expect(suggestions[0]!.title).toBe('Claude failed the same step 3 times ($2.40)')
  expect(insightsOf(l, null, NOW).some(i => i.id === 'loop')).toBe(true)
})

test('messages group into tasks by your request', () => {
  const base = { added: 0, cached: 1, isCold: false, agentShare: 0 }
  const tasks = tasksOf([
    { ...base, at: NOW - 50 * MINUTE, ms: MINUTE, usd: 1, tools: 4, prompt: 'fix the login redirect' },
    { ...base, at: NOW - 40 * MINUTE, ms: MINUTE, usd: 2, tools: 6, isCold: true },
    { ...base, at: NOW - 10 * MINUTE, ms: MINUTE, usd: 0.5, tools: 1, prompt: 'add a test' },
  ])
  expect(tasks.length).toBe(2)
  expect(tasks[0]).toEqual({ prompt: 'fix the login redirect', at: NOW - 51 * MINUTE, usd: 3, tools: 10, messages: 2, isCold: true, agentShare: 0 })
  expect(promptLine('a\n  b ' + 'x'.repeat(80)).length).toBe(60)
  expect(promptLine('a\n  b')).toBe('a b')
})

test('the savings ledger keeps 7 days and replaces entries by id', () => {
  let list = recordSaving(null, { id: 'b1', at: NOW - 8 * 24 * HOUR, kind: 'button', usd: 9 }, NOW - 8 * 24 * HOUR)
  list = recordSaving(list, { id: 'b2', at: NOW, kind: 'button', usd: 1 }, NOW)
  list = recordSaving(list, { id: 'b2', at: NOW, kind: 'button', usd: 2.5 }, NOW)
  list = recordSaving(list, { id: 'i1', at: NOW, kind: 'idle', usd: 3 }, NOW)
  expect(list.map(x => x.id)).toEqual(['b2', 'i1'])
  expect(savedThisWeek(list, NOW)).toEqual({ usd: 5.5, count: 2 })
})

const tk = (input: number) => ({ input, output: 0, read: 0, write5m: 0, write1h: 0 })
const weekOf = (over: any = {}) => ({ at: NOW, since: '7d', sessions: 1, requests: 1, main: {}, sub: {}, agentTypes: {}, cold: { count: 0, byModel: {} }, projects: [], ...over })

test('the week against the one before names the project behind the change', () => {
  // Opus 5.5 input is $4 per million: $40 this week against $25 before.
  const w = weekOf({
    main: { 'claude-opus-5-5': tk(10e6) }, prev: { main: { 'claude-opus-5-5': tk(6.25e6) }, sub: {} },
    byProject: { shop: { cur: { 'claude-opus-5-5': tk(8e6) }, prev: { 'claude-opus-5-5': tk(4e6) } }, blog: { cur: { 'claude-opus-5-5': tk(2e6) }, prev: { 'claude-opus-5-5': tk(2.25e6) } } },
  })
  const t = trendOf(w)!
  expect(Math.round(t.change * 100)).toBe(60)
  expect(t.project).toBe('shop')
  expect(Math.round(t.projectShare * 100)).toBe(100)
  expect(insightsOf(live(), w, NOW).find(i => i.id === 'week-trend')!.title).toBe('You spent 60% more than the week before')
  // Under $5 a side, or a change under 20%: nothing.
  expect(trendOf(weekOf({ main: { 'claude-opus-5-5': tk(1e6) }, prev: { main: { 'claude-opus-5-5': tk(0.5e6) }, sub: {} } }))).toBe(null)
  expect(trendOf(weekOf({ main: { 'claude-opus-5-5': tk(10e6) }, prev: { main: { 'claude-opus-5-5': tk(9e6) }, sub: {} } }))).toBe(null)
  // Today: the scanner's count plus this session since it ran.
  expect(todayUsd(weekOf({ today: { 'claude-opus-5-5': tk(1e6) }, sessionUsdAtScan: 2 }), 3.5)).toBe(5.5)
  expect(todayUsd(weekOf(), 3)).toBe(null)
})

test('every card says what it is and what to do, in one short line', () => {
  const l = live({ limits: [five(61)], cacheAt: NOW - 52 * MINUTE })
  const tree = JSON.stringify(drawStrip(el, { live: l, week: null, suggestion: suggestionsOf(l, NOW, SETTINGS)[0], insights: 2, now: NOW, columns: 200, desktop: true, onSuggestion() {}, onOpen() {}, onInsights() {} }))
  for (const name of ['Context · ', 'Cache · ', 'Insights · 2']) expect(tree).toContain(name)
  const go = [...tree.matchAll(/"children":"→ ([^"]*)"/g)].map(m => m[1]!)
  expect(go.length).toBeGreaterThanOrEqual(3)
  for (const line of go) expect(line.length).toBeLessThanOrEqual(70)
  // The state is in the mark and its color, not in a word.
  expect(tree).not.toContain('WATCH')
})

test('the welcome shows above the strip until got it', () => {
  const l = live()
  const base = { live: l, week: null, suggestion: undefined, insights: 0, now: NOW, columns: 160, desktop: false, onSuggestion() {}, onOpen() {}, onInsights() {} }
  const shown: any = drawStrip(el, { ...base, isWelcome: true })
  expect(shown.children[0].key).toBe('welcome')
  expect(JSON.stringify(shown)).toContain('"label":"got it"')
  expect(refusedBoxProps(shown)).toEqual([])
  expect(JSON.stringify(drawStrip(el, base))).not.toContain('got it')
})



test('the cache tooltip says when idle compact will run', () => {
  const l = live({ cacheAt: NOW - 10 * MINUTE })
  const base = { live: l, week: null, move: undefined, insights: 0, now: NOW, columns: 200, desktop: true, onSuggestion() {}, onOpen() {}, onInsights() {} } as any
  const at = new Date(NOW + 45 * MINUTE)
  const hhmm = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
  expect(JSON.stringify(drawStrip(el, { ...base, idleAt: NOW + 45 * MINUTE }))).toContain(`compacts ${hhmm} · ends`)
  expect(JSON.stringify(drawStrip(el, { ...base, idleAt: null }))).not.toContain('compacts ')
})

test('the weekly limit forecasts from the average since the week began, with the day', () => {
  // 47% used, 3 days in: about 15.7% a day, so the last 53% lasts about 3.4 days, before the reset in 4.
  const week = { kind: 'seven_day', percentUsed: 47, resetsAt: new Date(NOW + 4 * 24 * HOUR).toISOString() }
  const pace = paceOf(week, undefined, NOW)!
  expect(pace.basis).toBe('week')
  expect(pace.isShort).toBe(true)
  expect(pace.tone).toBe('warn')
  expect(Math.round((pace.runsOutAt - NOW) / HOUR)).toBe(81)
  // Too early in the window to say.
  expect(paceOf({ ...week, resetsAt: new Date(NOW + 7 * 24 * HOUR - 2 * HOUR).toISOString() }, undefined, NOW)).toBe(null)
  expect(whenOf(NOW + 10 * MINUTE, NOW)).toMatch(/^today \d\d:\d\d$/)
  expect(whenOf(NOW + 24 * HOUR, NOW)).toMatch(/^tomorrow /)
  expect(whenOf(NOW + 3 * 24 * HOUR, NOW)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) /)
})

test('past the 500k ceiling compacting comes first, whatever the saving', () => {
  const S = { ...SETTINGS, minSaving: 1_000, ceiling: CEILING }
  const over = live({ tokens: 620_000, conversation: 570_000 })
  const first = suggestionsOf(over, NOW, S)[0]
  expect(first?.id).toBe('ceiling')
  expect(first?.title).toBe('Context over 500k: compact')
  expect(first?.key).toBe('c')
  // The ceiling replaces the plain large-context suggestion: one compact, not two.
  expect(suggestionsOf(over, NOW, { ...S, minSaving: 0 }).filter(m => m.id === 'heavy')).toEqual([])
  // Under the ceiling, or with it off, nothing new.
  expect(suggestionsOf(live({ tokens: 480_000, conversation: 430_000 }), NOW, S).map(m => m.id)).not.toContain('ceiling')
  expect(suggestionsOf(over, NOW, { ...S, ceiling: 0 }).map(m => m.id)).not.toContain('ceiling')
  // An expired cache keeps its own advice: start fresh.
  expect(suggestionsOf(live({ tokens: 620_000, conversation: 570_000, cacheAt: NOW - 2 * HOUR }), NOW, S).map(m => m.id)).not.toContain('ceiling')
})

test('the red line sits at the ceiling when it comes before 85% of the window', () => {
  expect(markOf(1_000_000, 500_000)).toEqual({ tokens: 500_000, share: 0.5, label: '500k' })
  expect(markOf(200_000, 500_000).label).toBe('85%')
  expect(markOf(1_000_000, 0).label).toBe('85%')
  expect(contextTone(520_000, 1_000_000, 500_000)).toBe('hot')
  expect(contextTone(380_000, 1_000_000, 500_000)).toBe('warn')
  expect(contextTone(200_000, 1_000_000, 500_000)).toBe('calm')
  const l = live({ tokens: 520_000, conversation: 470_000 })
  const tree = JSON.stringify(drawStrip(el, { live: l, week: null, suggestion: undefined, insights: 0, now: NOW, columns: 200, desktop: true, ceiling: 500_000, onSuggestion() {}, onOpen() {}, onInsights() {} }))
  expect(tree).toContain('500k · 1M')
  expect(tree).toContain('→ compact now')
})

test('the status button asks Claude for the project status and next steps', () => {
  const l = live({ limits: [{ kind: 'five_hour', percentUsed: 61 }], cacheAt: NOW - 10 * MINUTE })
  let asked = 0
  for (const desktop of [false, true]) {
    const tree: any = drawStrip(el, { live: l, week: null, suggestion: undefined, insights: 0, now: NOW, columns: 200, desktop, onSuggestion() {}, onOpen() {}, onInsights() {}, onStatus: () => { asked++ } })
    const keys = (tree.children as any[]).map(c => c.key as string)
    // The buttons are icons together at the right end, in one style, Ask status last.
    expect(keys.slice(-3)).toEqual(['compact', 'open', 'status'])
    const button = (tree.children as any[]).find(c => c.key === 'status').children[0]
    expect(button.label).toBe('✦')
    expect(button.variant).toBe(undefined)
    button.onPress()
    expect((tree.children as any[]).find(c => c.key === 'compact').flexGrow).toBe(1)
  }
  expect(asked).toBe(2)
})

test('a pressed button says what is happening until its work shows', () => {
  const l = live({ cacheAt: NOW - 10 * MINUTE })
  const base = { live: l, week: null, suggestion: undefined, insights: 1, now: NOW, columns: 200, desktop: true, onSuggestion() {}, onOpen() {}, onInsights() {}, onStatus() {} }
  const labels = (pressing: 'status' | 'open' | 'insights' | null) => {
    const tree: any = drawStrip(el, { ...base, pressing })
    return Object.fromEntries((tree.children as any[]).filter(c => ['status', 'open', 'insights'].includes(c.key)).map(c => [c.key, c.children[0].label]))
  }
  expect(labels(null)).toEqual({ insights: 'ⓘ 1', open: '☰', status: '✦' })
  expect(labels('status').status).toBe('…')
  expect(labels('open').open).toBe('…')
  expect(labels('insights').insights).toBe('…')
  const two: any = drawStrip(el, { ...base, insights: 2 })
  expect((two.children as any[]).find(c => c.key === 'insights').children[0].label).toBe('ⓘ 2')
  // No insight: no insights button.
  const none: any = drawStrip(el, { ...base, insights: 0 })
  expect((none.children as any[]).some(c => c.key === 'insights')).toBe(false)
})
