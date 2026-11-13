// The strip above the prompt: a question Claude is waiting on, context, prompt cache and Claude's
// steps; then the buttons at the right end: the suggestion, insights (when any), Status and details.
// The usage limits and the session cost live in the details card and the pane.
// Pure drawing. It measures every part in cells and keeps the most important ones that fit
// `bodyColumns`, so it is always one line. Desktop draws the gauges as small SVGs; the
// terminal draws them with glyphs.

import type { Limit, Live, StepStatus, Steps, Waiting, Week } from '../types'
import { HEAVY_AT, HOUR, MINUTE, cacheEnd, cacheLeft, cacheWarnAt, clockOf, contextTone, markOf, money, span, tok, ttlOf, whenOf } from './suggestions'
import type { Suggestion } from './suggestions'
import { SUMMARY_TOKENS, sumTokens, tokensUsd } from './prices'
import { paceOf } from './signals'
import { isStepsShown, stepsProgress } from './steps'

export const INK = {
  cobalt: '#5b8def',
  amber: '#e0a030',
  coral: '#e5534b',
  mint: '#3fb68b',
  orchid: '#b866e6',
  grey: '#8a93a6',
}
const TERM: Record<string, string> = { calm: 'green', warn: 'yellow', hot: 'red' }
const TONE: Record<string, string> = { calm: INK.mint, warn: INK.amber, hot: INK.coral }
/** One word and one symbol per state, so a state reads without its color. */
export const MARK: Record<string, string> = { calm: '✓', warn: '◆', hot: '▲' }
type Tone = 'calm' | 'warn' | 'hot'
/** A strip button just pressed, before its work shows. */
export type Pressing = 'status' | 'open' | 'insights' | null

/** Desktop gauges are sized as if a cell were this many CSS pixels wide. */
const PX_PER_CELL = 7.5
const GAP = 2

/** One line of a hover card: a dim label and a bold value, or a plain dim note. */
type CardRow = { label: string; value?: string; color?: string }
/** Most steps a card lists before it says how many more. */
const CARD_STEPS = 12
/** A small bar in a card, with a dim caption at each end. */
type Chart = { source: string; width: number; height: number; alt: string; left: string; right: string }
/**
 * A hover card, kept short: a mark and a title with the value, at most a bar or two
 * label-value lines, and one line saying what to do (`go`).
 */
/** A labelled bar in a card: how much is used, a tick for how much of the time has passed. */
type Meter = { label: string; value: string; share: number; tick?: number | null; color: string }
type Card = { title: string; isTitleDim?: boolean; meters?: Meter[]; mark?: string; color?: string; rows: CardRow[]; chart?: Chart; steps?: { title: string; status: StepStatus }[]; go?: string; isRight?: boolean }
type Part = { key: string; rank: number; cells: number; draw: () => unknown[]; card?: Card; isEnd?: boolean }

export type StripInput = {
  live: Live
  /** The last 7 days, when History has read them: the details card's Fable line. */
  week: Week | null
  suggestion: Suggestion | undefined
  /** How many insights are open: the count on the insights button. */
  insights: number
  now: number
  columns: number
  desktop: boolean
  onSuggestion: () => void
  /** A compaction is queued: the button says so until it runs. */
  isQueued?: boolean
  /** When idle compact runs if you send nothing first; null when it will not. */
  idleAt?: number | null
  onOpen: () => void
  onInsights: () => void
  /** Asks Claude for the project's status and next steps. */
  onStatus?: () => void
  /** The button just pressed: its label says what is happening until the work shows. */
  pressing?: Pressing
  /** Claude's step list: the strip shows `step 2/5` and a bar while it is open. */
  steps?: Steps | null
  /** A question Claude is waiting on you to answer. */
  waiting?: Waiting | null
  /** First session after install: a short welcome above the strip until "got it". */
  isWelcome?: boolean
  onWelcomeDone?: () => void
  /** Tokens of context past which compacting is suggested: where the red line sits. */
  ceiling?: number
}

// ---------- Gauges ----------

/** The context gauge's scale: the window; the mark at the ceiling, or 85% of the window. */
function contextScale(live: Live, ceiling: number | undefined) {
  return { scale: live.window || HEAVY_AT, notch: markOf(live.window, ceiling).share }
}

function contextCells(live: Live, cells: number, ceiling: number | undefined) {
  const { scale, notch } = contextScale(live, ceiling)
  const tokens = Math.min(live.tokens ?? 0, scale)
  const fixed = Math.min(live.fixed ?? 0, tokens)
  const add = Math.min(live.adds[live.adds.length - 1] ?? 0, tokens - fixed)
  const f = Math.round((fixed / scale) * cells)
  const used = Math.max(f, Math.round((tokens / scale) * cells))
  const fresh = add > 0 ? Math.max(1, Math.round((add / scale) * cells)) : 0
  return { f, used, fresh: Math.min(fresh, used - f), notchAt: Math.round(notch * cells) }
}

function contextSvg(live: Live, ceiling: number | undefined): string {
  const n = 24, w = 3, g = 1, h = 12
  const c = contextCells(live, n, ceiling)
  let rects = ''
  for (let i = 0; i < n; i++) {
    const fill = i < c.f ? INK.grey : i < c.used ? INK.cobalt : INK.grey
    const opacity = i < c.f ? 0.9 : i < c.used - c.fresh ? 0.6 : i < c.used ? 1 : 0.22
    rects += `<rect x="${i * (w + g)}" y="1" width="${w}" height="${h - 2}" rx="0.8" fill="${fill}" opacity="${opacity}"/>`
  }
  const nx = c.notchAt * (w + g) - 0.75
  rects += `<rect x="${nx}" y="0" width="1.5" height="${h}" fill="${INK.coral}"/>`
  const width = n * (w + g) - g
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${rects}</svg>`
}

function cacheState(left: number, warn: number) {
  return left <= 0 ? 'hot' : left < warn ? 'warn' : 'calm'
}

/** `lead`: idle compact runs this long before the cache expires; a small tick marks the spot. */
function cacheSvg(left: number, ttl: number, warn: number, lead: number | null = null): string {
  const W = 52, H = 12
  const color = TONE[cacheState(left, warn)]!
  const x = Math.max(4, Math.min(1, left / ttl) * (W - 8) + 4)
  const burnt = `<line x1="${x}" y1="6" x2="${W - 1}" y2="6" stroke="${INK.grey}" stroke-width="1.2" stroke-dasharray="1.5 2.5" opacity="0.7"/>`
  if (left <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${burnt}<path d="M1.5 2 L8.5 10 M8.5 2 L1.5 10" stroke="${INK.coral}" stroke-width="1.8" stroke-linecap="round"/></svg>`
  }
  const rope = `<path d="M1 6 C ${x * 0.35} 2.5, ${x * 0.65} 9.5, ${x} 6" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`
  const spark = `<circle cx="${x}" cy="6" r="4.5" fill="${color}" opacity="0.25"/><circle cx="${x}" cy="6" r="2.2" fill="${color}"/>`
  const tick = lead !== null && lead > 0 && lead < left
    ? `<line x1="${(lead / ttl) * (W - 8) + 4}" y1="1.5" x2="${(lead / ttl) * (W - 8) + 4}" y2="10.5" stroke="${INK.cobalt}" stroke-width="1.6" stroke-linecap="round"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${burnt}${tick}${rope}${spark}</svg>`
}

const SPANS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

export function limitOf(limit: Limit, now: number) {
  const total = SPANS[limit.kind]
  const reset = Date.parse(limit.resetsAt ?? '')
  const left = Number.isNaN(reset) ? null : reset - now
  const clock = total && left !== null ? Math.max(0, Math.min(100, ((total - left) / total) * 100)) : null
  const used = Math.max(0, Math.min(100, limit.percentUsed))
  const ahead = clock === null ? 0 : used - clock
  const tone = used >= 85 || ahead > 15 ? 'hot' : ahead > 0 ? 'warn' : 'calm'
  return { label: LABELS[limit.kind] ?? limit.kind, used, clock, tone, left }
}

/** Claude's steps: a bar filled by the share done, blue while open, green when all are done. */
function stepsSvg(share: number, isDone: boolean): string {
  const W = 40, H = 10
  const x = 3 + Math.max(0, Math.min(1, share)) * (W - 6)
  const color = isDone ? INK.mint : INK.cobalt
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<line x1="3" y1="5" x2="${W - 3}" y2="5" stroke="${INK.grey}" stroke-width="3" stroke-linecap="round" opacity="0.35"/>` +
    (share > 0 ? `<line x1="3" y1="5" x2="${x}" y2="5" stroke="${color}" stroke-width="3" stroke-linecap="round"/>` : '') + '</svg>'
}

/** A card's bar: filled segments from the left, and thin marks (a limit, a planned compaction). */
const METER_W = 200, METER_H = 12
function meterSvg(segments: { share: number; color: string }[], marks: { share: number; color: string }[] = []): string {
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  let x = 0, fill = ''
  for (const seg of segments) {
    const w = clamp(seg.share) * METER_W
    if (w > 0) fill += `<rect x="${x}" y="3" width="${w}" height="6" fill="${seg.color}"/>`
    x += w
  }
  const ticks = marks.map(m => `<rect x="${Math.min(METER_W - 2, clamp(m.share) * METER_W)}" y="0" width="2" height="${METER_H}" rx="1" fill="${m.color}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${METER_W}" height="${METER_H}" viewBox="0 0 ${METER_W} ${METER_H}">` +
    `<clipPath id="r"><rect x="0" y="3" width="${METER_W}" height="6" rx="3"/></clipPath>` +
    `<rect x="0" y="3" width="${METER_W}" height="6" rx="3" fill="${INK.grey}" opacity="0.3"/><g clip-path="url(#r)">${fill}</g>${ticks}</svg>`
}

/** A step's mark, as Claude's task list draws it: a filled check, a turning ring, a dashed circle. */
function stepIconSvg(status: StepStatus): string {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">'
  if (status === 'completed') return open + `<circle cx="7" cy="7" r="6.5" fill="${INK.grey}"/><path d="M4.1 7.2l2 2 3.8-4.2" fill="none" stroke="#1f1f1d" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  if (status === 'in_progress') return open + `<circle cx="7" cy="7" r="5.6" fill="none" stroke="${INK.grey}" stroke-width="1.5" opacity="0.3"/><path d="M7 1.4a5.6 5.6 0 0 1 5.6 5.6" fill="none" stroke="${INK.grey}" stroke-width="1.5" stroke-linecap="round"/></svg>`
  return open + `<circle cx="7" cy="7" r="5.6" fill="none" stroke="${INK.grey}" stroke-width="1.3" stroke-dasharray="2.2 2"/></svg>`
}

/** The first sentence of a longer text: a card's "what to do" line. */
function firstSentence(text: string): string {
  const one = text.split(/(?<=\.)\s/)[0]!.replace(/\.$/, '')
  return one.length > 70 ? one.slice(0, 69) + '…' : one
}

/** Below this many columns the new parts take their short form. */
const NARROW = 100
/** How much more text the desktop strip holds than its `bodyColumns` say. */
const DESKTOP_ROOM = 1.2
/** The buttons, left to right, at the right end of the strip: Ask status last, against the edge. */
const ACTIONS = ['suggestion', 'insights', 'compact', 'open', 'status']
/** The buttons are icons, all in one style; each one's card names it. */
const ICON = { compact: '⇲', details: '☰', status: '✦', insights: 'ⓘ' }
const ICON_CELLS = 5

// ---------- The strip ----------

function cellsOf(px: number) {
  return Math.ceil(px / PX_PER_CELL)
}

export function drawStrip(el: any, s: StripInput): unknown | null {
  const { Box, Text, Button, Svg } = el
  const { live, now } = s
  if (live.tokens === null && live.usd === null) return null
  const desktop = s.desktop && !!Svg
  // Desktop draws text narrower than the cells `bodyColumns` counts (measured: about a third
  // of the strip stayed empty while parts were dropped), so it fits against a wider budget.
  const columns = desktop ? Math.floor(s.columns * DESKTOP_ROOM) : s.columns
  const parts: Part[] = []

  // Context
  if (live.tokens !== null) {
    const value = tok(live.tokens)
    const add = live.adds[live.adds.length - 1] ?? 0
    const addText = add > 0 ? '+' + tok(add) : ''
    const gauge = desktop ? cellsOf(96) : 13
    parts.push({
      key: 'context', rank: 1, cells: gauge + 1 + value.length + (addText ? 1 + addText.length : 0),
      card: (() => {
        const mark = markOf(live.window, s.ceiling)
        const tone: Tone = contextTone(live.tokens, live.window, s.ceiling)
        const w = live.window || 1
        const fixed = Math.min(live.fixed ?? 0, live.tokens ?? 0)
        const chat = Math.max(0, (live.tokens ?? 0) - fixed)
        return {
          title: `Context · ${value}`, mark: MARK[tone], color: TONE[tone],
          chart: {
            source: meterSvg([{ share: fixed / w, color: INK.grey }, { share: chat / w, color: INK.cobalt }], [{ share: mark.tokens / w, color: INK.coral }]),
            width: METER_W, height: METER_H, alt: `Context: ${value} of ${tok(live.window)}`,
            left: `${tok(fixed)} fixed · ${tok(chat)} chat`, right: `${mark.label} · ${tok(live.window)}`,
          },
          rows: addText ? [{ label: 'Last message', value: addText }] : [],
          go: tone === 'hot' ? 'compact now' : tone === 'warn' ? '/clear before an unrelated task' : 'nothing',
        }
      })(),
      draw: () => {
        const out: unknown[] = []
        if (desktop) out.push(Svg({ key: 'g', source: contextSvg(live, s.ceiling), width: 95, height: 12, alt: `Context: ${value} of ${tok(live.window)}` }))
        else {
          const c = contextCells(live, 12, s.ceiling)
          const glyphs: unknown[] = []
          for (let i = 0; i < 12; i++) {
            if (i === c.notchAt) glyphs.push(Text({ key: 'n', color: INK.coral, children: '│' }))
            const isUsed = i < c.used
            const color = i < c.f ? INK.grey : isUsed ? INK.cobalt : undefined
            glyphs.push(Text({ key: 'c' + i, color, dimColor: !isUsed, bold: isUsed && i >= c.used - c.fresh && i >= c.f, children: isUsed ? '▰' : '▱' }))
          }
          out.push(Box({ key: 'g', flexDirection: 'row', children: glyphs }))
        }
        out.push(Text({ key: 'v', bold: true, children: value }))
        if (addText) out.push(Text({ key: 'a', dimColor: true, children: addText }))
        return out
      },
    })
  }

  // Prompt cache
  const left = cacheLeft(live, now)
  if (left !== null) {
    const ttl = ttlOf(live)
    const warn = cacheWarnAt(live)
    const state = cacheState(left, warn)
    const value = span(left)
    parts.push({
      key: 'cache', rank: 3, cells: (desktop ? cellsOf(52) : 7) + 1 + value.length,
      card: (() => {
        const end = cacheEnd(live)!
        const idle = s.idleAt && s.idleAt > now ? s.idleAt : null
        return {
          title: left > 0 ? `Cache · ${value} left` : 'Cache · expired', mark: MARK[state], color: TONE[state],
          ...(left > 0 ? { chart: {
            source: meterSvg([{ share: left / ttl, color: TONE[state]! }], idle ? [{ share: (idle - now) / ttl, color: INK.cobalt }] : []),
            width: METER_W, height: METER_H, alt: `Prompt cache: ${value} left`,
            left: 'now', right: idle ? `compacts ${clockOf(idle)} · ends ${clockOf(end)}` : `ends ${clockOf(end)}`,
          } } : {}),
          rows: left > 0 ? [] : [{ label: 'Your next message sends the whole context again' }],
          go: state === 'hot' ? 'compact, or start a new session' : state === 'warn' ? `send before ${clockOf(end)}, or compact before a break` : 'nothing',
        }
      })(),
      draw: () => {
        const out: unknown[] = []
        if (desktop) out.push(Svg({ key: 'g', source: cacheSvg(left, ttl, warn, s.idleAt ? cacheEnd(live)! - s.idleAt : null), width: 52, height: 12, alt: `Prompt cache: ${value} left` }))
        else {
          const r = left <= 0 ? 0 : Math.max(1, Math.min(6, Math.round((left / ttl) * 6)))
          const glyph = left <= 0 ? '✕' + '┄'.repeat(6) : '━'.repeat(r - 1) + '✦' + '┄'.repeat(7 - r)
          out.push(Text({ key: 'g', color: TERM[state], children: glyph }))
        }
        out.push(Text({ key: 'v', bold: true, color: state === 'calm' ? undefined : TONE[state], children: value }))
        return out
      },
    })
  }

  // Claude is waiting on you: a question it asked, unanswered
  if (s.waiting) {
    const w = s.waiting
    const waited = Math.max(0, now - w.since)
    const mins = waited < MINUTE ? 'now' : Math.floor(waited / MINUTE) + ' min'
    const isNarrow = columns < NARROW
    const label = isNarrow ? 'waiting ' + (waited < MINUTE ? 'now' : Math.floor(waited / MINUTE) + 'm') : 'Claude is waiting · ' + mins
    const cache = cacheLeft(live, now)
    parts.push({
      key: 'waiting', rank: 0.5, cells: 2 + label.length,
      card: {
        title: `Waiting on you · ${waited < MINUTE ? 'just now' : mins}`, mark: '●', color: INK.amber,
        rows: [
          { label: 'Question', value: w.label },
          ...(cache !== null ? [{ label: 'Cache left', value: cache > 0 ? span(cache) : 'expired' }] : []),
        ],
        go: 'answer in the chat',
      },
      draw: () => [Text({ key: 'w', bold: true, color: INK.amber, children: '● ' + label })],
    })
  }

  // Claude's step list
  if (isStepsShown(s.steps ?? null, now)) {
    const list = s.steps!
    const p = stepsProgress(list)
    const value = (columns < NARROW ? '' : 'step ') + `${p.at}/${p.total}`
    const share = p.total ? p.done / p.total : 0
    const isDone = p.done === p.total
    const rows: CardRow[] = list.items.length > CARD_STEPS ? [{ label: `+${list.items.length - CARD_STEPS} more` }] : []
    parts.push({
      key: 'steps', rank: 2.5, cells: value.length + 1 + (desktop ? cellsOf(40) : 6),
      // Drawn like Claude's own task list: a round mark per step, done steps dimmed.
      card: { title: `${p.done} of ${p.total} done · ${span(now - list.startedAt)}`, isTitleDim: true, steps: list.items.slice(0, CARD_STEPS), rows },
      draw: () => {
        const out: unknown[] = [Text({ key: 'l', dimColor: true, children: value })]
        if (desktop) out.push(Svg({ key: 'g', source: stepsSvg(share, isDone), width: 40, height: 10, alt: `Claude's steps: ${p.done} of ${p.total} done` }))
        else {
          const filled = Math.round(share * 6)
          out.push(Text({ key: 'g', color: isDone ? TERM.calm : 'blue', children: '━'.repeat(filled) + '─'.repeat(6 - filled) }))
        }
        return out
      },
    })
  }

  // The suggestion
  const suggestion = s.suggestion
  const long = suggestion ? `${suggestion.short}${suggestion.usd > 0.01 ? ' · saves ' + money(suggestion.usd) + (suggestion.unit === 'now' ? '' : ' ' + suggestion.unit) : ''}` : 'all good'
  const short = suggestion ? `${suggestion.short}${suggestion.usd > 0.01 && suggestion.unit === 'now' ? ' ' + money(suggestion.usd) : ''}` : 'all good'
  const suggestionCells = (label: string) => label.length + (suggestion?.key ? 4 : 2)
  const drawSuggestion = (label: string) => () => {
    if (!suggestion) return [Text({ key: 'm', color: INK.mint, children: MARK.calm + ' ' + label })]
    if (suggestion.key && s.isQueued) return [Text({ key: 'm', color: INK.amber, children: MARK.warn + ' compaction queued' })]
    if (suggestion.key) return [Button({ key: 'suggestion', label, variant: 'primary', onPress: s.onSuggestion })]
    return [Text({ key: 'm', color: TONE[suggestion.tone], children: MARK[suggestion.tone] + ' ' + label })]
  }
  const suggestionCard = ((): Card | undefined => {
    if (!suggestion) return undefined
    const base = { mark: MARK[suggestion.tone], color: TONE[suggestion.tone], isRight: true }
    if (suggestion.key === 'c' && live.tokens) {
      const after = Math.min(live.tokens, (live.fixed ?? 0) + SUMMARY_TOKENS)
      return { ...base, title: `Compact · ${tok(live.tokens)} → ${tok(after)}`,
        rows: [{ label: 'Each message', value: `−${Math.round((1 - after / live.tokens) * 100)}% tokens` }],
        go: suggestion.id === 'break' ? 'click compact before a break' : 'click compact between tasks' }
    }
    return { ...base, title: suggestion.title, rows: [], go: firstSentence(suggestion.how) }
  })()
  if (suggestion && !suggestion.key) parts.push({ key: 'suggestion', rank: 1.2, cells: suggestionCells(long), draw: drawSuggestion(long), card: suggestionCard })
  // Compact: always there; its card says what it saves now.
  if (live.tokens) {
    const after = Math.min(live.tokens, (live.fixed ?? 0) + SUMMARY_TOKENS)
    const isSuggested = suggestion?.key === 'c'
    parts.push({
      key: 'compact', rank: 1.2, cells: ICON_CELLS,
      draw: () => [Button({ key: 'compact', label: s.isQueued ? '…' : ICON.compact, onPress: s.onSuggestion })],
      card: isSuggested && suggestionCard ? { ...suggestionCard, mark: ICON.compact }
        : { title: `Compact · ${tok(live.tokens)} → ${tok(after)}`, mark: ICON.compact, isRight: true, rows: [], go: s.isQueued ? 'queued: runs after this answer' : 'nothing worth saving now' },
    })
  }
  // Insights: only when there is one to read.
  const insightLabel = s.pressing === 'insights' ? '…' : `${ICON.insights} ${s.insights}`
  if (s.insights > 0) parts.push({
    key: 'insights', rank: 3.5, cells: insightLabel.length + 4,
    draw: () => [Button({ key: 'insights', label: insightLabel, onPress: s.onInsights })],
    card: { title: `Insights · ${s.insights}`, isRight: true, rows: [{ label: 'Limits, model fit and habits' }], go: 'click to read' },
  })
  if (s.onStatus) parts.push({
    key: 'status', rank: 2, cells: ICON_CELLS,
    draw: () => [Button({ key: 'status', label: s.pressing === 'status' ? '…' : ICON.status, onPress: s.onStatus })],
    // A card opening leftward: the button sits at the right end.
    card: { title: 'Ask status', mark: ICON.status, isRight: true, rows: [{ label: 'Done · decisions · next steps' }], go: 'sends Claude 1 message' },
  })
  parts.push({ key: 'open', rank: 1.5, cells: ICON_CELLS, draw: () => [Button({ key: 'open', label: s.pressing === 'open' ? '…' : ICON.details, onPress: s.onOpen })], card: { ...statusCard(s), mark: ICON.details, isRight: true } })

  // Fit: keep parts by rank while they fit; a long suggestion label gives way to the short one first.
  const fit = (list: Part[]) => {
    const kept: Part[] = []
    let used = 0
    for (const p of [...list].sort((a, b) => a.rank - b.rank)) {
      const need = p.cells + (kept.length ? GAP : 0)
      if (used + need <= columns) {
        kept.push(p)
        used += need
      }
    }
    return kept
  }
  let kept = fit(parts)
  if (!kept.some(p => p.key === 'suggestion') || kept.length < Math.min(parts.length, 4)) {
    const shorter = parts.map(p => (p.key === 'suggestion' ? { ...p, cells: suggestionCells(short), draw: drawSuggestion(short) } : p))
    kept = fit(shorter)
  }
  const order = ['waiting', 'context', 'cache', 'steps', ...ACTIONS]
  kept.sort((a, b) => (order.indexOf(a.key) + 99) % 99 - (order.indexOf(b.key) + 99) % 99)
  // The buttons sit together at the right end: the first one takes the room left.
  const firstAction = kept.find(p => ACTIONS.includes(p.key))
  if (firstAction) firstAction.isEnd = true

  const line = Box({
    key: 'strip',
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: GAP,
    children: kept.map(p => Box({
      key: p.key, flexDirection: 'row', alignItems: 'center', columnGap: 1, flexShrink: 0,
      // An end part takes the room left and sits against the right edge.
      ...(p.isEnd ? { flexGrow: 1, justifyContent: 'flex-end' } : {}),
      children: desktop && p.card ? [...p.draw(), richCard(el, p.card)] : p.draw(),
    })),
  })
  if (!s.isWelcome) return line
  const welcome = Box({
    key: 'welcome', flexDirection: 'column', borderStyle: 'round', borderColor: INK.cobalt, paddingX: 1,
    children: [
      Text({ key: 'a', bold: true, children: 'Usage Coach: this line shows your context, prompt cache, usage limits and session cost. It costs no tokens.' }),
      Text({ key: 'b', dimColor: true, children: desktop
        ? 'Hover any part to see what it means and what to do. The right end shows the change that saves the most.'
        : 'The right end shows the change that saves the most. Click insights for more.' }),
      Box({ key: 'c', flexDirection: 'row', columnGap: 2, alignItems: 'center', children: [
        Text({ key: 't', dimColor: true, children: 'Click details for the full panel.' }),
        Button({ key: 'ok', label: 'got it', variant: 'primary', onPress: s.onWelcomeDone ?? (() => {}) }),
      ] }),
    ],
  })
  return Box({ flexDirection: 'column', children: [welcome, line] })
}

/** Tokens and list-price dollars a model family spent in the week, main and subagents together. */
export function familyWeek(w: Week, family: string) {
  let tokens = 0, usd = 0
  for (const byModel of [w.main, w.sub]) {
    for (const [model, t] of Object.entries(byModel)) {
      if (!model.includes(family)) continue
      tokens += sumTokens(t)
      usd += tokensUsd(t, model)
    }
  }
  return { tokens, usd }
}

/** The details card: this session, both usage limits with their reset time, and the week's Fable use. */
export function statusCard(s: StripInput): Card {
  const { live, now } = s
  const rows: CardRow[] = []
  const meters: Meter[] = []
  const model = live.model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')
  const elapsed = live.startedAt ? span(now - live.startedAt) : ''
  const names: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' }
  for (const limit of live.limits) {
    const r = limitOf(limit, now)
    const left = Math.max(0, 100 - Math.round(r.used))
    const pace = paceOf(limit, live.limitSamples?.[limit.kind], now)
    const tone = pace?.isShort ? (pace.tone === 'hot' ? 'hot' : 'warn') : r.tone
    meters.push({
      label: names[limit.kind] ?? limit.kind,
      value: `${left}% left` + (r.left !== null && r.left > 0 ? ` · resets in ${span(r.left)}` : ''),
      share: r.used / 100, tick: r.clock === null ? null : r.clock / 100, color: TONE[tone]!,
    })
    if (pace?.isShort) rows.push({ label: `${names[limit.kind] ?? limit.kind} runs out`, value: `${whenOf(pace.runsOutAt, now)} · ${span(pace.resetsAt! - pace.runsOutAt)} early`, color: TONE[tone] })
  }
  if (!live.limits.length) rows.push({ label: 'Usage limits show after the next message' })
  if (s.week) {
    const fable = familyWeek(s.week, 'fable')
    rows.push({ label: 'Fable · 7 days', value: fable.tokens ? tok(fable.tokens) + ' tokens' : 'not used' })
  }
  return {
    title: ['Session', elapsed, model].filter(Boolean).join(' · '), mark: ICON.details,
    meters, rows, go: 'click for the side panel', isRight: true,
  }
}

function richCard(el: any, card: Card) {
  const { Box, Text, Svg } = el
  const chart = card.chart && Svg ? [
    Svg({ key: 'c', source: card.chart.source, width: card.chart.width, height: card.chart.height, alt: card.chart.alt }),
    Box({ key: 'cs', flexDirection: 'row', justifyContent: 'space-between', columnGap: 3, children: [
      Text({ key: 'a', dimColor: true, children: card.chart.left }),
      Text({ key: 'b', dimColor: true, children: card.chart.right }),
    ] }),
  ] : []
  return Box({
    position: 'absolute',
    bottom: 1,
    ...(card.isRight ? { right: 0 } : { left: 0 }),
    display: 'none',
    hover: { display: 'flex' },
    flexDirection: 'column',
    paddingX: 1,
    borderStyle: 'round',
    borderColor: 'subtle',
    backgroundColor: 'background',
    children: [
      Box({ key: 'h', flexDirection: 'row', columnGap: 1, children: [
        ...(card.mark ? [Text({ key: 'm', bold: true, ...(card.color ? { color: card.color } : {}), children: card.mark })] : []),
        Text({ key: 't', ...(card.isTitleDim ? { dimColor: true } : { bold: true }), children: card.title }),
      ] }),
      ...chart,
      ...(card.meters ?? []).flatMap((m, i) => [
        Box({ key: 'mh' + i, flexDirection: 'row', justifyContent: 'space-between', columnGap: 3, children: [
          Text({ key: 'l', dimColor: true, children: m.label }),
          Text({ key: 'v', bold: true, children: m.value }),
        ] }),
        ...(Svg ? [Svg({ key: 'mb' + i, source: meterSvg([{ share: m.share, color: m.color }], m.tick == null ? [] : [{ share: m.tick, color: INK.grey }]), width: METER_W, height: METER_H, alt: `${m.label}: ${m.value}` })] : []),
      ]),
      ...(card.steps ?? []).map((st, i) => Box({ key: 's' + i, flexDirection: 'row', alignItems: 'center', columnGap: 1, children: [
        ...(Svg ? [Svg({ key: 'i', source: stepIconSvg(st.status), width: 14, height: 14, alt: st.status.replace('_', ' ') })]
          : [Text({ key: 'i', dimColor: true, children: st.status === 'completed' ? '✓' : st.status === 'in_progress' ? '◌' : '○' })]),
        Text({ key: 't', ...(st.status === 'completed' ? { dimColor: true } : {}), children: st.title }),
      ] })),
      ...card.rows.map((r, i) => r.value === undefined
        ? Text({ key: 'r' + i, ...(r.color ? { color: r.color, bold: true } : { dimColor: true }), children: r.label })
        : Box({ key: 'r' + i, flexDirection: 'row', justifyContent: 'space-between', columnGap: 3, children: [
          Text({ key: 'l', dimColor: true, children: r.label }),
          Text({ key: 'v', bold: true, ...(r.color ? { color: r.color } : {}), children: r.value }),
        ] })),
      ...(card.go ? [Text({ key: 'go', bold: true, children: '→ ' + card.go })] : []),
    ],
  })
}
