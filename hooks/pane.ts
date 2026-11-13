// The Usage Coach pane: three views of consumption, not cost.
//   Session: how this session grew, what filled it, what weighed most, and how to lighten it.
//   Project: every session, worktree and Xcode build of this repo on disk, and what can go.
//   All projects: Claude's work on the whole Mac (disk and memory) and the token trend.
// Pure drawing: numbers, one picture per topic, and buttons that say what they free. Charts are
// SVG on the desktop (each bar has a tooltip) and glyphs in the terminal. Rows reveal a detail
// line under the pointer. No dollar appears except the session's, small, in its footer.

import type { Busy, ClaudeProcess, Disk, DiskSession, Live, Mac, Profile, RepoTrees, Tab, Week, XcodeBuild } from '../types'
import { contextTone, money, span, tok } from './suggestions'
import type { Suggestion } from './suggestions'
import { INK, limitOf } from './strip'
import type { Insight } from './insights'

export type PaneInput = {
  tab: Tab | string
  live: Live
  suggestions: Suggestion[]
  insights: Insight[]
  week: Week | null
  disk: Disk | null
  mac: Mac | null
  profile: Profile | null
  /** This repo's worktrees (the Project view's own, quick scan). */
  trees: RepoTrees | null
  busy: Busy
  openRow: string | null
  /** The session's project: its folder key in ~/.claude/projects, name and root folder. */
  project: { key: string; name: string; root: string } | null
  columns: number
  now: number
  desktop: boolean
  saved?: { usd: number; count: number }
  ceiling?: number
}

export type PaneActions = {
  setTab: (tab: Tab) => void
  refresh: (what: Tab) => void
  compact: () => void
  handover: () => void
  toggleRow: (id: string) => void
  resume: (s: DiskSession) => void
  reveal: (path: string) => void
  trashSessions: (paths: string[], bytes: number, olderDays: number) => void
  removeWorktrees: (paths: string[], bytes: number) => void
  clearXcode: (folders: string[], bytes: number) => void
  shutdownSim: (udid: string, name: string, mb: number) => void
  keepDays: () => void
}

const VIEWS: { tab: Tab; label: string; hotkey: string }[] = [
  { tab: 'session', label: 'Session', hotkey: '1' },
  { tab: 'project', label: 'Project', hotkey: '2' },
  { tab: 'all', label: 'All projects', hotkey: '3' },
]
/** CSS pixels per column in the desktop pane, measured on screen. */
const PX = 7.85
const SPARK = '▁▂▃▄▅▆▇█'
const SANS = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif'
const FAINT = '#8a93a6'
const TEAL = '#2b9bb0'
const DAY = 86_400_000
const KEEP_DAYS = 14

// ---------- Numbers ----------

/** Bytes as people read them: "988 MB", "10.4 GB". */
export function size(bytes: number): string {
  if (bytes < 1e9) return `${Math.max(0, Math.round(bytes / 1e6))} MB`
  return `${(bytes / 1e9).toFixed(bytes < 1e11 ? 1 : 0)} GB`
}

function mbText(mb: number): string {
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function days(ms: number): string {
  const d = ms / DAY
  return d < 1 ? span(ms) : `${d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)} d`
}

/** Text inside an SVG: "<" and "&" would break the whole picture. */
function esc(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function svg(w: number, ht: number, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}" font-family="${SANS}">${body}</svg>`
}

/** Prompts until the context reaches the ceiling, at the pace of the last few; 0 when it is there. */
export function promptsToCeiling(live: Live, ceiling: number): number | null {
  if (live.tokens === null) return null
  if (live.tokens >= ceiling) return 0
  const recent = live.adds.slice(-10).filter(a => a > 0)
  if (recent.length < 2) return null
  const avg = recent.reduce((n, a) => n + a, 0) / recent.length
  return avg > 0 ? Math.ceil((ceiling - live.tokens) / avg) : null
}

/** Worktrees that pass every check, with their total. */
export function safeTrees(repos: RepoTrees[]): { paths: string[]; bytes: number } {
  const ok = repos.flatMap(r => r.trees.filter(t => !t.why?.length))
  return { paths: ok.map(t => t.path), bytes: ok.reduce((n, t) => n + t.bytes, 0) }
}

/** Xcode builds that can go now: orphans always, old ones only while nothing builds. */
export function safeBuilds(builds: XcodeBuild[], isBuilding: boolean): { folders: string[]; bytes: number } {
  const ok = builds.filter(b => b.state === 'orphan' || (b.state === 'old' && !isBuilding))
  return { folders: ok.map(b => b.folder), bytes: ok.reduce((n, b) => n + b.bytes, 0) }
}

/** Builds that belong to a project folder (their workspace sits inside it, worktrees included). */
export function buildsOf(builds: XcodeBuild[], root: string): XcodeBuild[] {
  return builds.filter(b => b.workspace && (b.workspace === root || b.workspace.startsWith(root + '/')))
}

/** Everything Claude's work takes on the Mac: sessions, worktrees, Xcode builds, simulators, the app. */
export function claudeBytes(disk: Disk | null, mac: Mac): number {
  return (disk?.total.bytes ?? 0) + mac.repos.reduce((n, r) => n + r.bytes, 0) + mac.xcode.bytes + mac.sims.bytes + mac.app.bytes
}

function processName(p: ClaudeProcess, projects: Disk['projects']): string {
  const name = projects.find(x => x.key === p.key)?.name ?? p.cwd.split('/').filter(Boolean).pop() ?? 'session'
  const wt = /\/\.claude\/worktrees\/([^/]+)/.exec(p.cwd)?.[1]
  return wt ? `${name} · ${wt.replace(/-[0-9a-f]{6}$/, '')}` : name
}

export function drawPane(el: any, p: PaneInput, act: PaneActions) {
  const { Box, Text, Button, Svg } = el
  const desktop = p.desktop && !!Svg
  const cols = Math.max(30, p.columns)
  const W = Math.floor(cols * PX) - 2
  const tab: Tab = p.tab === 'project' || p.tab === 'all' ? p.tab : 'session'
  const ceiling = p.ceiling ?? 500_000

  // ---------- Pieces ----------
  // Each view is a list of sections with air between them: a caption, a footer or the actions
  // start a new one. Inside a section the lines sit close.
  const starts = new Set<unknown>()
  const opens = <T,>(node: T): T => {
    starts.add(node)
    return node
  }
  const caption = (key: string, text: string, note?: string, noteColor?: string) => opens(Box({ key, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', children: [
    Text({ key: 'c', size: 'caption', weight: 'semibold', dimColor: true, children: text.toUpperCase() }),
    ...(note ? [Text({ key: 'n', size: 'caption', ...(noteColor ? { color: noteColor, weight: 'semibold' } : { dimColor: true }), children: note })] : []),
  ] }))
  /** The view's headline: one big number, what it counts, and a verdict. */
  const top = (key: string, big: string, label: string, pill: string, pillColor: string) => Box({ key, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', columnGap: 1, children: [
    Box({ key: 'l', flexDirection: 'row', alignItems: 'center', columnGap: 1, flexShrink: 1, children: [
      Text({ key: 'b', size: 'title', weight: 'bold', children: big }),
      Text({ key: 't', size: 'footnote', dimColor: true, wrap: 'truncate-end', children: label }),
    ] }),
    ...(pill ? [Text({ key: 'p', size: 'footnote', weight: 'semibold', color: pillColor, children: pill })] : []),
  ] })
  /** Small labels in a row, like pills: "163 prompts · 25 d · 7× compacted". */
  const pills = (key: string, list: { text: string; color?: string }[]) => Box({ key, flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: list.flatMap((x, i) => [
    ...(i ? [Text({ key: 's' + i, size: 'footnote', dimColor: true, children: '·' })] : []),
    Text({ key: 'p' + i, size: 'footnote', ...(x.color ? { color: x.color } : { dimColor: true }), children: x.text }),
  ]) })
  /** A bar of parts side by side (SVG with a tooltip per part; glyphs in the terminal). */
  const parts = (key: string, list: { value: number; color: string; title: string; opacity?: number }[], ht = 12, alt = '') => {
    const sum = list.reduce((n, x) => n + Math.max(0, x.value), 0) || 1
    if (!desktop) {
      const cells = cols - 1
      return Box({ key, flexDirection: 'row', children: list.map((x, i) => Text({ key: 'g' + i, color: x.color, children: '█'.repeat(Math.max(x.value > 0 ? 1 : 0, Math.round((x.value / sum) * cells))) })) })
    }
    let x0 = 0
    let body = `<clipPath id="c"><rect width="${W}" height="${ht}" rx="${ht / 2}"/></clipPath><g clip-path="url(#c)">`
    for (const x of list) {
      const w = (Math.max(0, x.value) / sum) * W
      if (w <= 0) continue
      body += `<rect x="${x0.toFixed(1)}" y="0" width="${Math.max(1, w - 2).toFixed(1)}" height="${ht}" fill="${x.color}" opacity="${x.opacity ?? 1}"><title>${esc(x.title)}</title></rect>`
      x0 += w
    }
    body += '</g>'
    return Svg({ key, alt: alt || list.map(x => x.title).join(', '), width: W, height: ht, isInteractive: true, source: svg(W, ht, body) })
  }
  /** Columns, each with its tooltip; labels under them when given. */
  const columnsChart = (key: string, list: { value: number; color: string; title: string; label?: string; top?: string; opacity?: number }[], ht: number, alt: string, foot?: [string, string, string?]) => {
    const max = Math.max(1e-9, ...list.map(x => x.value))
    if (!desktop) {
      return Box({ key, flexDirection: 'column', children: [
        Box({ key: 's', flexDirection: 'row', children: list.map((x, i) => Text({ key: 'c' + i, color: x.color, children: SPARK[Math.min(7, Math.floor((x.value / max) * 7.999))]! })) }),
        ...(foot ? [Text({ key: 'f', dimColor: true, children: [foot[0], foot[1]].filter(Boolean).join(' · ') })] : []),
      ] })
    }
    const labels = list.some(x => x.label)
    const base = ht - (labels ? 30 : foot ? 16 : 2)
    const headroom = list.some(x => x.top) ? 16 : 2
    const cw = W / list.length
    const wide = list.length <= 6
    let body = `<line x1="0" x2="${W}" y1="${base + 0.5}" y2="${base + 0.5}" stroke="${FAINT}" stroke-opacity="0.4"/>`
    list.forEach((x, i) => {
      const h = Math.max(x.value > 0 ? 2 : 0, (x.value / max) * (base - headroom))
      const w = wide ? cw * 0.5 : Math.max(2, cw - 4)
      const left = i * cw + (cw - w) / 2
      body += `<rect x="${left.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${x.color}" opacity="${x.opacity ?? 1}"><title>${esc(x.title)}</title></rect>`
      if (x.top) body += `<text x="${(left + w / 2).toFixed(1)}" y="${(base - h - 4).toFixed(1)}" font-size="11" font-weight="700" fill="${x.color}" text-anchor="middle">${esc(x.top)}</text>`
      if (x.label) body += `<text x="${(left + w / 2).toFixed(1)}" y="${base + 15}" font-size="11" fill="${FAINT}" text-anchor="middle">${esc(x.label)}</text>`
    })
    if (foot) {
      body += `<text x="0" y="${ht - 1}" font-size="11" fill="${FAINT}">${esc(foot[0])}</text>`
      if (foot[2]) body += `<text x="${W / 2}" y="${ht - 1}" font-size="11" fill="${FAINT}" text-anchor="middle">${esc(foot[2])}</text>`
      body += `<text x="${W}" y="${ht - 1}" font-size="11" fill="${FAINT}" text-anchor="end">${esc(foot[1])}</text>`
    }
    return Svg({ key, alt, width: W, height: ht, isInteractive: true, source: svg(W, ht, body) })
  }
  /** A labelled meter row: name, meter, value, and an action (a Button) or a dim word. The
   *  detail line shows under the row while the pointer is on it. */
  const meterRow = (key: string, r: { label: string; dim?: string; share: number; value: string; color: string; action?: unknown; word?: string; detail?: string; valueColor?: string; stack?: boolean }) => {
    // A row with a button or a word takes two lines: the name and size above, the meter and
    // the button below. A narrow pane then never squeezes the name.
    const twoLines = !!(r.action || r.word || r.stack)
    const mw = twoLines
      ? desktop ? Math.round(W * 0.55) : Math.max(8, Math.round(cols * 0.5))
      : desktop ? Math.max(50, Math.round(W * 0.22)) : Math.max(6, Math.round(cols * 0.18))
    const meter = desktop
      ? Svg({ key: 'm', alt: '', width: mw, height: 7, source: svg(mw, 7, `<rect width="${mw}" height="7" rx="3.5" fill="${FAINT}" opacity="0.16"/><rect width="${Math.max(r.share > 0 ? 7 : 0, Math.min(1, r.share) * mw).toFixed(1)}" height="7" rx="3.5" fill="${r.color}"/>`) })
      : Text({ key: 'm', color: r.color, children: '━'.repeat(Math.max(r.share > 0 ? 1 : 0, Math.round(Math.min(1, r.share) * mw))) + '╌'.repeat(Math.max(0, mw - Math.round(Math.min(1, r.share) * mw))) })
    const name = Box({ key: 'l', flexGrow: 1, flexShrink: 1, flexDirection: 'row', columnGap: 1, children: [
      Text({ key: 't', wrap: 'truncate-end', children: r.label }),
      ...(r.dim ? [Text({ key: 'd', dimColor: true, wrap: 'truncate-end', children: r.dim })] : []),
    ] })
    const value = Text({ key: 'v', weight: 'semibold', tabular: true, ...(r.valueColor ? { color: r.valueColor } : {}), children: r.value })
    const lines = twoLines
      ? [
          Box({ key: 'a', flexDirection: 'row', alignItems: 'center', columnGap: 1, children: [name, value] }),
          Box({ key: 'b', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', columnGap: 1, children: [
            meter,
            ...(r.action ? [r.action] : r.word ? [Text({ key: 'w', size: 'footnote', dimColor: true, children: r.word })] : []),
          ] }),
        ]
      : [Box({ key: 'a', flexDirection: 'row', alignItems: 'center', columnGap: 1, children: [name, meter, Box({ key: 'v', width: 7, justifyContent: 'flex-end', children: [value] })] })]
    // Two-line rows get a little air below, so a list of them reads as separate rows.
    return Box({ key, flexDirection: 'column', ...(twoLines ? { paddingBottom: 'xs' } : {}), children: [
      ...lines,
      ...(r.detail ? [Box({ display: 'none', hover: { display: 'flex' }, children: [Text({ key: 't', size: 'caption', dimColor: true, children: r.detail })] })] : []),
    ] })
  }
  const small = (key: string, label: string, onPress: () => void, tone?: 'primary' | 'amber') => Button({
    key, label, onPress,
    ...(tone === 'primary' ? { variant: 'primary' } : tone === 'amber' ? { variant: 'secondary' } : { plain: true }),
  })
  const busyLine = (key: string, text: string) => Text({ key, size: 'footnote', color: INK.cobalt, children: '◌ ' + text })
  const foot = (key: string, left: string, right?: unknown) => opens(Box({ key, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', children: [
    Text({ key: 'l', size: 'caption', dimColor: true, children: left }),
    ...(right ? [right] : []),
  ] }))

  const tabs = Box({ key: 'tabs', flexDirection: 'row', columnGap: 'sm', flexWrap: 'wrap', children: VIEWS.map(v =>
    Button({ key: 'tab-' + v.tab, label: v.label, hotkey: v.hotkey, ...(v.tab === tab ? { variant: 'primary' } : { plain: true }), onPress: () => act.setTab(v.tab) })) })

  let body: unknown[] = []
  if (tab === 'session') body = sessionView()
  if (tab === 'project') body = projectView()
  if (tab === 'all') body = allView()

  // Sections: a new one at each caption, footer or row of actions.
  const sections: unknown[][] = []
  for (const node of body) {
    if (!sections.length || starts.has(node)) sections.push([])
    sections.at(-1)!.push(node)
  }
  return Box({ flexDirection: 'column', width: cols, gap: 'md', children: [
    Box({ key: 'head', flexDirection: 'column', gap: 'xs', children: [tabs, ...(p.busy.action ? [busyLine('act', p.busy.action)] : [])] }),
    ...sections.map((list, i) => Box({ key: 'sec' + i, flexDirection: 'column', gap: 'xs', children: list })),
  ] })

  // ---------- Session ----------
  function sessionView(): unknown[] {
    const l = p.live
    const pr = p.profile
    const now = p.now
    const tokens = l.tokens ?? 0
    const base = l.fixed ?? 0
    const conv = Math.max(0, tokens - base)
    const tone = contextTone(l.tokens, l.window, ceiling)
    const out: unknown[] = []
    const word = tone === 'hot' ? '▲ Very heavy' : tone === 'warn' ? '● Heavy' : '✓ Light'
    out.push(top('top', tok(tokens), 'tokens per message', word, tone === 'hot' ? INK.coral : tone === 'warn' ? INK.amber : INK.mint))
    if (l.fixed !== null && tokens > 0) {
      out.push(parts('ctx', [
        { value: base, color: FAINT, opacity: 0.5, title: `Base ${tok(base)}: instructions, tools and memory sent with every message` },
        { value: conv, color: tone === 'calm' ? INK.cobalt : INK.amber, title: `Conversation ${tok(conv)}: everything said so far, sent again with every message` },
      ], 14))
      out.push(Box({ key: 'under', flexDirection: 'row', justifyContent: 'space-between', children: [
        Text({ key: 'a', size: 'footnote', dimColor: true, children: `base ${tok(base)}` }),
        Text({ key: 'b', size: 'footnote', color: tone === 'calm' ? INK.cobalt : INK.amber, children: `conversation ${tok(conv)}` }),
      ] }))
    }
    const started = pr?.firstAt || l.startedAt
    const promptCount = pr?.prompts ?? l.turns.filter(t => t.prompt).length
    const toCeiling = promptsToCeiling(l, ceiling)
    out.push(pills('pills', [
      { text: `${promptCount} prompts` },
      ...(started ? [{ text: days(now - started) }] : []),
      ...(pr ? [{ text: `${pr.compactions.length}× compacted` }] : []),
      ...(pr && pr.cold.length ? [{ text: `${pr.cold.length}× cold cache`, color: INK.coral }] : []),
      ...(toCeiling === 0 ? [{ text: '⇣ compact now', color: INK.amber }] : toCeiling !== null ? [{ text: `⇣ compact in ~${toCeiling} prompts` }] : []),
    ]))

    // Context over time: one point per request, compactions and cold returns marked.
    if (pr && pr.series.length > 1) {
      out.push(caption('ch', 'Context', `${new Date(pr.firstAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })} → now`))
      out.push(contextChart(pr, l))
    } else if (p.busy.profile) {
      out.push(caption('ch', 'Context'), busyLine('pb', 'Reading this session… (a few seconds, no tokens)'))
    }

    // What filled it, by source.
    if (pr) {
      const t = pr.filled.tools
      const outputs = Object.values(t).reduce((n, v) => n + v, 0)
      const all = outputs + pr.filled.claude + pr.filled.you || 1
      const pct = (v: number) => `${Math.round((v / all) * 100)}%`
      const tools = Object.entries(t).sort((a, b) => b[1] - a[1])
      out.push(caption('fh', 'What filled it', 'by source'))
      out.push(parts('fill', [
        ...tools.map(([name, v], i) => ({ value: v, color: TEAL, opacity: Math.max(0.3, 1 - i * 0.22), title: `${name} outputs · ${pct(v)} · ${tok(v)} tokens` })),
        { value: pr.filled.claude, color: INK.orchid, title: `Claude's answers, edits and commands · ${pct(pr.filled.claude)} · ${tok(pr.filled.claude)} tokens` },
        { value: pr.filled.you, color: INK.cobalt, title: `Your messages · ${pct(pr.filled.you)} · ${tok(pr.filled.you)} tokens` },
      ], 12))
      const topTool = tools[0]
      out.push(pills('fk', [
        { text: `tool outputs ${pct(outputs)}${topTool ? ` (${topTool[0]} ${pct(topTool[1])})` : ''}`, color: TEAL },
        { text: `Claude ${pct(pr.filled.claude)}`, color: INK.orchid },
        { text: `you ${pct(pr.filled.you)}`, color: INK.cobalt },
      ]))
      if (pr.heavy.length) {
        out.push(caption('hh', 'Heaviest prompts', `of ${tok(pr.sent)}`))
        const max = Math.max(1, ...pr.heavy.map(h => h.tokens))
        pr.heavy.forEach((h, i) => out.push(meterRow('h' + i, {
          label: h.label, dim: new Date(h.at).toLocaleDateString('en', { month: 'short', day: 'numeric' }), share: h.tokens / max, value: tok(h.tokens), color: INK.cobalt,
          detail: `${h.requests} requests · ${Math.round((h.tokens / Math.max(1, pr.sent)) * 100)}% of the session`,
        })))
      }
      // The session's own footprint on the Mac.
      const running = pr.own?.running ?? []
      out.push(caption('mh', 'On this Mac', 'this session'))
      out.push(Box({ key: 'mini', flexDirection: 'row', children: [
        Box({ key: 'd', flexGrow: 1, flexDirection: 'column', children: [Text({ key: 'l', size: 'caption', dimColor: true, children: 'Disk' }), Text({ key: 'v', size: 'heading', weight: 'semibold', children: size(pr.bytes) })] }),
        Box({ key: 'm', flexGrow: 1, flexDirection: 'column', children: [Text({ key: 'l', size: 'caption', dimColor: true, children: 'Memory' }), Text({ key: 'v', size: 'heading', weight: 'semibold', children: pr.own ? mbText(pr.own.mb) : '–' })] }),
        Box({ key: 'r', flexGrow: 1, flexDirection: 'column', children: [Text({ key: 'l', size: 'caption', dimColor: true, children: 'Left running' }),
          Text({ key: 'v', size: 'heading', weight: 'semibold', ...(running.length ? { color: INK.amber } : { color: INK.mint }), children: running.length ? `${running.length} · ${mbText(running.reduce((n, r) => n + r.mb, 0))}` : '✓ nothing' })] }),
      ] }))
      if (running.length) {
        out.push(Box({ key: 'run', flexDirection: 'column', children: running.slice(0, 3).map((r, i) => Text({ key: 'r' + i, dimColor: true, wrap: 'truncate-end', children: `  ${r.what} · ${mbText(r.mb)} · ${span(r.secs * 1000)}` })) }))
      }
    }

    // What to do: the top suggestion, or a new session when the old conversation weighs.
    const topSuggestion = p.suggestions[0]
    const age = started ? now - started : 0
    const isLong = conv >= 100_000 && (age >= 2 * DAY || (pr?.compactions.length ?? 0) >= 3)
    const tip = topSuggestion && topSuggestion.tone !== 'calm' ? topSuggestion.title : isLong ? `New session → −${tok(conv)} per message` : ''
    const fit = p.insights.find(i => i.kind === 'model' && i.tone !== 'calm')
    out.push(opens(Box({ key: 'do', flexDirection: 'column', gap: 'xs', children: [
      ...(tip ? [Text({ key: 'tip', weight: 'semibold', color: topSuggestion?.tone === 'hot' ? INK.coral : INK.amber, children: tip })] : []),
      ...(fit ? [Text({ key: 'fit', color: INK.amber, children: '◆ ' + fit.title })] : []),
      Box({ key: 'b', flexDirection: 'row', columnGap: 'sm', children: [
        ...(isLong ? [small('handover', '↻ Hand-over note', act.handover, 'primary')] : []),
        ...(conv >= 5_000 ? [small('compact', '⇣ Compact', act.compact, isLong ? undefined : 'primary')] : []),
      ] }),
    ] })))
    const saved = p.saved && p.saved.count ? `saved ≈ ${money(p.saved.usd)} in 7 days` : ''
    out.push(foot('ft', saved || (pr ? `read ${span(Math.max(0, now - pr.at))} ago · no tokens` : ''),
      Text({ key: 'usd', dimColor: true, children: l.usd === null ? '' : '≈ ' + money(l.usd) })))
    return out
  }

  function contextChart(pr: Profile, l: Live) {
    const series = pr.series.slice()
    if (l.tokens !== null && (series.at(-1)?.[0] ?? 0) < p.now - 60_000) series.push([p.now, l.tokens])
    const values = series.map(x => x[1])
    const max = Math.max(1, ...values)
    if (!desktop) {
      const n = cols - 1
      const step = series.length / n
      const cells = Array.from({ length: Math.min(n, series.length) }, (_, i) => values[Math.floor(i * step)] ?? 0)
      return Box({ key: 'ctxc', flexDirection: 'column', children: [
        Text({ key: 's', color: INK.cobalt, children: cells.map(v => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]).join('') }),
        Text({ key: 'f', dimColor: true, children: `peak ${tok(max)} · now ${tok(values.at(-1) ?? 0)} · ${pr.compactions.length} compactions · ${pr.cold.length} cold` }),
      ] })
    }
    const H = 112, topY = 8, base = 96, right = W - 38
    const x = (i: number) => (i / Math.max(1, series.length - 1)) * right
    const y = (v: number) => base - (v / max) * (base - topY)
    const indexAt = (t: number) => {
      const i = series.findIndex(s => s[0] >= t)
      return i < 0 ? series.length - 1 : i
    }
    let body = `<line x1="0" x2="${right}" y1="${base + 0.5}" y2="${base + 0.5}" stroke="${FAINT}" stroke-opacity="0.4"/>`
    for (const t of pr.compactions) {
      const cx = x(indexAt(t)) - 1
      body += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${topY}" y2="${base}" stroke="${INK.mint}" stroke-width="1.2" stroke-dasharray="2 2"><title>Compacted ${esc(new Date(t).toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</title></line>`
    }
    const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s[1]).toFixed(1)}`).join(' ')
    body += `<polygon points="0,${base} ${pts} ${x(series.length - 1).toFixed(1)},${base}" fill="${INK.cobalt}" fill-opacity="0.14"/>`
    body += `<polyline points="${pts}" fill="none" stroke="${INK.cobalt}" stroke-width="1.6" stroke-linejoin="round"/>`
    for (const t of pr.cold) {
      const i = indexAt(t)
      body += `<circle cx="${x(i).toFixed(1)}" cy="${y(values[i] ?? 0).toFixed(1)}" r="3" fill="${INK.coral}"><title>Came back after the cache expired: ${esc(tok(values[i] ?? 0))} sent again in full</title></circle>`
    }
    const last = values.at(-1) ?? 0
    body += `<circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" fill="none" stroke="${INK.cobalt}" stroke-width="2"/>`
    body += `<text x="${W}" y="${(y(last) + 4).toFixed(1)}" font-size="11" font-weight="700" fill="${INK.cobalt}" text-anchor="end">${esc(tok(last))}</text>`
    body += `<text x="${W}" y="${(y(max) + 4).toFixed(1)}" font-size="11" fill="${FAINT}" text-anchor="end">${esc(tok(max))}</text>`
    body += `<text x="0" y="${H - 1}" font-size="11" fill="${FAINT}">first message</text><text x="${right}" y="${H - 1}" font-size="11" fill="${FAINT}" text-anchor="end">now</text>`
    return Svg({ key: 'ctxc', alt: `Context per message: peak ${tok(max)}, now ${tok(last)}, ${pr.compactions.length} compactions, ${pr.cold.length} cold returns`, width: W, height: H, isInteractive: true, source: svg(W, H, body) })
  }

  // ---------- Project ----------
  function projectView(): unknown[] {
    const out: unknown[] = []
    const d = p.disk
    const proj = p.project
    if (!proj) return [Text({ key: 'none', dimColor: true, children: 'This session has no project folder.' })]
    if (!d) return [p.busy.disk ? busyLine('busy', 'Reading the sessions on this Mac… (a second, no tokens)') : Text({ key: 'none', dimColor: true, children: 'No reading yet.' }),
      opens(Box({ key: 'b', children: [small('read', 'Read now', () => act.refresh('project'), 'primary')] }))]
    const info = d.projects.find(x => x.key === proj.key)
    const repo = p.trees
    const builds = p.mac ? buildsOf(p.mac.xcode.builds, proj.root) : []
    const sessionsBytes = info?.bytes ?? 0
    const treeBytes = repo?.bytes ?? 0
    const buildBytes = builds.reduce((n, b) => n + b.bytes, 0)
    const total = sessionsBytes + treeBytes + buildBytes
    const share = d.total.bytes ? sessionsBytes / d.total.bytes : 0
    const heavy = total >= 20e9 || share >= 0.3
    out.push(top('top', proj.name, info?.worktrees ? `+ ${info.worktrees} worktrees` : '', heavy ? `● ${size(total)} on this Mac` : `✓ ${size(total)}`, heavy ? INK.amber : INK.mint))

    // Where the project's space goes, with what can go.
    const okTrees = repo ? safeTrees([repo]) : { paths: [], bytes: 0 }
    const okBuilds = p.mac ? safeBuilds(builds, p.mac.xcode.isBuilding) : { folders: [], bytes: 0 }
    const rows: Parameters<typeof meterRow>[1][] = []
    const max = Math.max(1, buildBytes, treeBytes, sessionsBytes)
    if (builds.length) rows.push({ label: 'Xcode builds', dim: `· ${builds.length}`, share: buildBytes / max, value: size(buildBytes), color: INK.orchid,
      ...(okBuilds.bytes > 0 ? { action: small('xc', `Clear old · ${size(okBuilds.bytes)}`, () => act.clearXcode(okBuilds.folders, okBuilds.bytes), 'amber') } : { word: p.mac?.xcode.isBuilding ? 'building' : 'recent' }),
      detail: `${builds.filter(b => b.state === 'orphan').length} for folders that are gone · ${builds.filter(b => b.state === 'old').length} unused 7 days · ${builds.filter(b => b.state === 'recent').length} recent` })
    if (repo && repo.trees.length) {
      const held = repo.trees.length - okTrees.paths.length
      rows.push({ label: 'Worktrees', dim: `· ${repo.trees.length}`, share: treeBytes / max, value: size(treeBytes), color: TEAL,
        ...(okTrees.paths.length ? { action: small('wt', `Remove ${okTrees.paths.length} · ${size(okTrees.bytes)}`, () => act.removeWorktrees(okTrees.paths, okTrees.bytes), 'amber') } : { word: 'in use' }),
        detail: `${okTrees.paths.length} safe to remove · ${held} kept: ${keptWhy(repo)}` })
    }
    rows.push({ label: 'Sessions', dim: `· ${info?.sessions ?? 0}`, share: sessionsBytes / max, value: size(sessionsBytes), color: INK.cobalt,
      detail: `${share > 0 && share < 0.01 ? '< 1' : Math.round(share * 100)}% of all session files · ${info?.folders ?? 0} folder${info?.folders === 1 ? '' : 's'}` })
    if (rows.length > 1) {
      out.push(parts('split', [
        ...(buildBytes ? [{ value: buildBytes, color: INK.orchid, title: `Xcode builds ${size(buildBytes)}` }] : []),
        ...(treeBytes ? [{ value: treeBytes, color: TEAL, title: `Worktrees ${size(treeBytes)}` }] : []),
        { value: sessionsBytes, color: INK.cobalt, title: `Sessions ${size(sessionsBytes)}` },
      ], 14))
    }
    // The rows start their own section, under the headline and its bar.
    rows.forEach((r, i) => out.push(i === 0 ? opens(meterRow('mr' + i, { ...r, stack: true })) : meterRow('mr' + i, { ...r, stack: true })))
    if (p.busy.mac) out.push(busyLine('mb', 'Measuring worktrees and Xcode builds… (up to 2 min, no tokens)'))

    // Sessions by age.
    if (info) {
      const names = ['today', '1–7 d', '7–30 d', '30+ d']
      out.push(caption('ah', 'Sessions by age', 'size on disk'))
      out.push(columnsChart('ages', info.ages.map((a, i) => ({
        value: a.bytes, color: i === 3 ? INK.amber : INK.cobalt, opacity: i === 3 ? 1 : 0.4 + i * 0.2,
        top: size(a.bytes).replace(' ', ''), label: `${names[i]} · ${a.count}`, title: `${names[i]}: ${a.count} sessions · ${size(a.bytes)}`,
      })), 100, 'Session files by last use'))
      // The terminal's sparkline has no labels: the counts go under it.
      if (!desktop) out.push(Box({ key: 'agec', flexDirection: 'row', justifyContent: 'space-around', children: info.ages.map((a, i) => Text({ key: 'c' + i, dimColor: true, children: `${a.count} sess.` })) }))
    }

    // Heaviest sessions: pressing one shows its actions.
    const list = d.project?.top ?? []
    if (list.length) {
      out.push(caption('sh', 'Heaviest sessions', info ? `of ${info.sessions}` : undefined))
      const maxS = Math.max(1, ...list.map(s => s.bytes))
      for (const s of list) {
        const old = p.now - s.at > 30 * DAY
        const isOpen = p.openRow === s.id
        const label = `${s.where} · ${days(p.now - s.at)}`
        // A Button holds text only: the size sits beside it.
        const row = Box({ key: 'r', flexDirection: 'row', columnGap: 1, children: [
          Box({ key: 'l', flexGrow: 1, flexShrink: 1, children: [
            Button({ key: 'row-' + s.id, label: (isOpen ? '▾ ' : '▸ ') + label, plain: true, onPress: () => act.toggleRow(s.id) }),
          ] }),
          Text({ key: 'v', bold: true, ...(old ? { color: INK.amber } : {}), children: size(s.bytes) }),
        ] })
        out.push(Box({ key: 's-' + s.id, flexDirection: 'column', children: [
          row,
          Box({ display: isOpen ? 'flex' : 'none', hover: { display: 'flex' }, paddingLeft: 2, children: [
            Text({ key: 't', dimColor: true, wrap: 'truncate-end', children: [s.title || 'untitled', s.hold ?? 'not open', s.sub ? `subagents ${size(s.sub)}` : ''].filter(Boolean).join(' · ') }),
          ] }),
          ...(isOpen ? [Box({ key: 'acts', flexDirection: 'row', columnGap: 1, paddingLeft: 2, children: [
            small('resume', '⧉ Resume', () => act.resume(s)),
            small('finder', '↗ Finder', () => act.reveal(s.path)),
            // A held session says why in the line above; it has no Trash button.
            ...(s.hold ? [] : [small('trash', '⌫ Trash', () => act.trashSessions([s.path], s.bytes, 1), 'amber')]),
          ] })] : []),
        ] }))
      }
    }

    // What can go.
    const stale = (d.project?.stale ?? []).filter(s => !s.hold)
    const staleBytes = stale.reduce((n, s) => n + s.bytes, 0)
    const longOpen = d.procs.filter(x => x.key === proj.key && x.secs > DAY)
    if (stale.length || longOpen.length) {
      out.push(opens(Box({ key: 'do', flexDirection: 'row', columnGap: 'sm', alignItems: 'center', flexWrap: 'wrap', children: [
        ...(stale.length ? [small('stale', `⌫ Trash ${stale.length} old · ${size(staleBytes)}`, () => act.trashSessions(stale.map(s => s.path), staleBytes, 30), 'amber')] : []),
        ...(longOpen.length ? [Text({ key: 'open', dimColor: true, children: `◷ ${longOpen.length} open > 1 d · ${mbText(longOpen.reduce((n, x) => n + x.mb, 0))}` })] : []),
      ] })))
    }
    out.push(foot('ft', `${d.ms < 1000 ? '< 1 s' : Math.round(d.ms / 1000) + ' s'} · no tokens · ${span(Math.max(0, p.now - d.at))} ago`, small('again', '↻ Refresh', () => act.refresh('project'))))
    return out
  }

  /** Why worktrees stay, most common reason first: "3 open, 2 with changes". */
  function keptWhy(repo: RepoTrees): string {
    const counts = new Map<string, number>()
    for (const t of repo.trees) for (const w of t.why ?? []) {
      const k = w.replace(/:.*$/, '').replace(/^work not in .*/, 'work not in main')
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'
  }

  // ---------- All projects ----------
  function allView(): unknown[] {
    const out: unknown[] = []
    const d = p.disk
    const mac = p.mac
    if (!mac) {
      out.push(top('top', d ? size(d.total.bytes) : '–', 'of session files', d ? `${d.total.sessions} sessions` : '', FAINT))
      out.push(Text({ key: 'why', dimColor: true, children: 'Worktrees, Xcode builds, simulators and memory are measured on request: up to 2 minutes, no tokens.' }))
      out.push(opens(Box({ key: 'b', children: [p.busy.mac ? busyLine('busy', 'Measuring the Mac…') : small('measure', 'Measure this Mac', () => act.refresh('all'), 'primary')] })))
    } else {
      const claude = claudeBytes(d, mac)
      const disk = mac.disk
      out.push(top('top', size(claude), "Claude's work on this Mac", disk ? `● ${size(disk.free)} free` : '', disk && disk.free < 0.2 * disk.total ? INK.amber : INK.mint))
      if (disk) {
        out.push(parts('whole', [
          { value: claude, color: INK.amber, title: `Claude's work ${size(claude)}` },
          { value: Math.max(0, disk.used - claude), color: FAINT, opacity: 0.45, title: `Everything else ${size(Math.max(0, disk.used - claude))}` },
          { value: disk.free, color: FAINT, opacity: 0.12, title: `Free ${size(disk.free)}` },
        ], 16))
        out.push(Box({ key: 'under', flexDirection: 'row', justifyContent: 'space-between', children: [
          Text({ key: 'a', size: 'footnote', color: INK.amber, children: `Claude ${Math.round((claude / disk.total) * 100)}% of the disk` }),
          Text({ key: 'b', size: 'footnote', dimColor: true, children: `free ${size(disk.free)} of ${size(disk.total)}` }),
        ] }))
      }

      // Disk: each place, with what can go.
      const trees = safeTrees(mac.repos)
      const builds = safeBuilds(mac.xcode.builds, mac.xcode.isBuilding)
      const treeBytes = mac.repos.reduce((n, r) => n + r.bytes, 0)
      const keep = d?.keep.find(k => k.days === KEEP_DAYS)
      const canKeep = d && keep && keep.bytes > 0 && keep.sidebar === 0 && (d.cleanupDays === null || d.cleanupDays > KEEP_DAYS)
      const canGo = trees.bytes + builds.bytes + (canKeep ? keep!.bytes : d?.old30.bytes ?? 0)
      out.push(caption('dh', 'Disk', canGo > 1e9 ? `≈ ${size(canGo)} can go` : undefined, INK.mint))
      const max = Math.max(1, treeBytes, mac.xcode.bytes, mac.sims.bytes, d?.total.bytes ?? 0, mac.app.bytes)
      const treeCount = mac.repos.reduce((n, r) => n + r.trees.length, 0)
      const rows: Parameters<typeof meterRow>[1][] = [
        { label: 'Worktrees', dim: `· ${treeCount}`, share: treeBytes / max, value: size(treeBytes), color: TEAL,
          ...(trees.paths.length ? { action: small('wt', `Remove ${trees.paths.length} · ${size(trees.bytes)}`, () => act.removeWorktrees(trees.paths, trees.bytes), 'amber') } : { word: 'in use' }),
          detail: mac.repos.slice(0, 4).map(r => `${r.name} ${size(r.bytes)} (${r.trees.filter(t => !t.why?.length).length} of ${r.trees.length} safe)`).join(' · ') },
        { label: 'Xcode builds', dim: `· ${mac.xcode.builds.length}`, share: mac.xcode.bytes / max, value: size(mac.xcode.bytes), color: INK.orchid,
          ...(builds.folders.length ? { action: small('xc', `Clear old · ${size(builds.bytes)}`, () => act.clearXcode(builds.folders, builds.bytes), 'amber') } : { word: mac.xcode.isBuilding ? 'building' : 'recent' }),
          detail: byProject(mac.xcode.builds) },
        { label: 'iPhone simulators', dim: `· ${mac.sims.devices.length}`, share: mac.sims.bytes / max, value: size(mac.sims.bytes), color: FAINT,
          detail: mac.sims.devices.slice(0, 4).map(s => `${s.name} ${size(s.bytes)}`).join(' · ') },
        { label: 'Sessions', dim: `· ${d?.total.sessions ?? 0}`, share: (d?.total.bytes ?? 0) / max, value: size(d?.total.bytes ?? 0), color: INK.cobalt,
          ...(canKeep ? { action: small('keep', `Keep ${KEEP_DAYS} d · ${size(keep!.bytes)}`, act.keepDays, 'amber') }
            : d && d.old30.count ? { action: small('old', `⌫ ${d.old30.count} old · ${size(d.old30.bytes)}`, () => act.trashSessions(d.old30.paths, d.old30.bytes, 30), 'amber') } : { word: 'kept 30 d' }),
          detail: d ? d.projects.slice(0, 4).map(x => `${x.name} ${size(x.bytes)}`).join(' · ') + (d.old30.count ? ` · ${d.old30.count} older than 30 days` : '') : undefined },
        { label: 'Claude app', share: mac.app.bytes / max, value: size(mac.app.bytes), color: FAINT, detail: 'The Desktop app: its caches, virtual machine and simulator builds' },
      ]
      rows.forEach((r, i) => out.push(meterRow('dr' + i, { ...r, stack: true })))

      // Memory.
      const m = mac.memory
      out.push(caption('mh', 'Memory', m.freePct !== null ? `${m.freePct}% free of ${mbText(m.totalMb)}` : undefined))
      const maxM = Math.max(1, m.simMb, m.sessionsMb, m.appMb)
      const booted = mac.sims.devices.filter(s => s.state === 'Booted')
      booted.forEach((s, i) => out.push(meterRow('sim' + i, {
        label: 'iPhone simulator', dim: `· ${s.name}`, stack: true, share: (s.mb ?? 0) / maxM, value: mbText(s.mb ?? 0), color: INK.amber,
        ...(mac.simBusy ? { word: 'in use' } : { action: small('sd' + i, 'Shut down', () => act.shutdownSim(s.udid, s.name, s.mb ?? 0), 'amber') }),
        detail: mac.simBusy ? 'A build or test is using a simulator: it can be shut down when it ends' : 'Like turning the phone off: open it again from Xcode or Claude',
      })))
      out.push(meterRow('cc', { label: 'Claude Code sessions', dim: `· ${d?.procs.length ?? m.sessions}`, share: m.sessionsMb / maxM, value: mbText(m.sessionsMb), color: INK.cobalt, stack: true }))
      out.push(meterRow('app', { label: 'Claude app', share: m.appMb / maxM, value: mbText(m.appMb), color: FAINT, stack: true }))
    }

    // Open sessions: one column each, older than a day in amber; the tooltip names it.
    if (d && d.procs.length) {
      const procs = [...d.procs].sort((a, b) => b.mb - a.mb)
      const long = procs.filter(x => x.secs > DAY)
      out.push(caption('oh', `Open sessions · ${procs.length}`, long.length ? `${long.length} open > 1 day` : undefined, long.length ? INK.amber : undefined))
      out.push(columnsChart('procs', procs.map(x => ({
        value: x.mb, color: x.secs > DAY ? INK.amber : INK.cobalt, opacity: x.secs > DAY ? 1 : 0.6,
        title: `${processName(x, d.projects)} · ${mbText(x.mb)} · open ${span(x.secs * 1000)}${x.secs > DAY ? ' · archive it in the sidebar if you are done' : ''}`,
      })), 80, 'Memory of each open Claude Code session', [`${mbText(procs.reduce((n, x) => n + x.mb, 0))} in all`, long.length ? `${mbText(long.reduce((n, x) => n + x.mb, 0))} open > 1 day` : '']))
    }

    // Tokens per day.
    const w = p.week
    const dayList = w?.days ? Object.entries(w.days).sort((a, b) => a[0].localeCompare(b[0])).slice(-14) : []
    if (dayList.length) {
      out.push(caption('th', 'Tokens', `last ${dayList.length} days`))
      out.push(columnsChart('days', dayList.map(([day, v]) => {
        const all = v.main + v.sub
        return { value: all, color: v.sub / Math.max(1, all) >= 0.5 ? INK.orchid : INK.cobalt, opacity: 0.85, title: `${day.slice(5)} · ${tok(all)} tokens · subagents ${Math.round((v.sub / Math.max(1, all)) * 100)}% · ${Math.round((v.read / Math.max(1, all)) * 100)}% from cache` }
      }), 92, 'Tokens per day', [dayList[0]![0].slice(5), 'today']))
      const sum = (list: typeof dayList) => list.reduce((n, [, v]) => n + v.main + v.sub, 0)
      const subOf = (list: typeof dayList) => list.reduce((n, [, v]) => n + v.sub, 0) / Math.max(1, sum(list))
      const cur = dayList.slice(-7), prev = dayList.slice(-14, -7)
      const change = prev.length === 7 && sum(prev) ? (sum(cur) - sum(prev)) / sum(prev) : null
      const read = cur.reduce((n, [, v]) => n + v.read, 0) / Math.max(1, sum(cur))
      const sub = subOf(cur)
      out.push(pills('tp', [
        { text: `${tok(sum(cur))} this week${change !== null ? ` ${change >= 0 ? '↑' : '↓'}${Math.abs(Math.round(change * 100))}%` : ''}` },
        { text: `${Math.round(read * 100)}% from cache` },
        { text: `subagents ${Math.round(sub * 100)}%${prev.length && sub > subOf(prev) + 0.1 ? ' ↑' : ''}`, ...(sub >= 0.4 ? { color: INK.amber } : {}) },
      ]))
    } else if (p.busy.disk) {
      out.push(caption('th', 'Tokens'), busyLine('tb', 'Reading the last 14 days… (about a minute, no tokens)'))
    }
    const limits = p.live.limits.map(l => limitOf(l, p.now))
    if (limits.length) out.push(pills('lim', limits.map(r => ({ text: `${r.label} ${Math.round(r.used)}% used`, ...(r.tone === 'calm' ? {} : { color: r.tone === 'hot' ? INK.coral : INK.amber }) }))))
    out.push(foot('ft', mac ? `measured ${span(Math.max(0, p.now - mac.at))} ago · no tokens` : 'no tokens used', small('again', '↻ Refresh', () => act.refresh('all'))))
    return out
  }

  function byProject(builds: XcodeBuild[]): string {
    const m = new Map<string, { bytes: number; n: number; free: number }>()
    for (const b of builds) {
      const k = b.project ?? 'unknown'
      const x = m.get(k) ?? { bytes: 0, n: 0, free: 0 }
      x.bytes += b.bytes
      x.n++
      if (b.state === 'orphan' || b.state === 'old') x.free++
      m.set(k, x)
    }
    return [...m].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 3).map(([k, x]) => `${k} ${size(x.bytes)} in ${x.n}${x.free ? ` (${x.free} unused)` : ''}`).join(' · ')
  }
}
