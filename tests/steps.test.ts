import { expect, test } from 'claude-code/testing'

import type { Live, Steps } from '../types'
import { STEPS_LINGER, isQuestionTool, isStepTool, isStepsShown, questionWaiting, stepsAfter, stepsProgress } from '../hooks/steps'
import { drawStrip } from '../hooks/strip'

const NOW = Date.parse('2026-11-13T15:00:00Z')
const MINUTE = 60_000

const plan = (n: number, at: number) => Array.from({ length: n }, (_, i) => ({ content: `Step ${i + 1}`, status: i < at ? 'completed' : i === at ? 'in_progress' : 'pending' }))

test('the step tools are told apart from the rest', () => {
  for (const t of ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'mcp__ccd_turn__update_plan']) expect(isStepTool(t)).toBe(true)
  for (const t of ['Bash', 'TaskList', 'TaskStop', 'mcp__other__plan']) expect(isStepTool(t)).toBe(false)
  expect(isQuestionTool('AskUserQuestion')).toBe(true)
  expect(isQuestionTool('Bash')).toBe(false)
})

test('TodoWrite replaces the list and keeps the run while it is open', () => {
  const a = stepsAfter(null, 'TodoWrite', { todos: plan(5, 0) }, undefined, NOW)!
  expect(stepsProgress(a)).toEqual({ done: 0, total: 5, at: 1 })
  expect(a.created).toBe(5)
  const b = stepsAfter(a, 'TodoWrite', { todos: plan(5, 1) }, undefined, NOW + 5 * MINUTE)!
  expect(stepsProgress(b)).toEqual({ done: 1, total: 5, at: 2 })
  expect(b.startedAt).toBe(NOW)
  expect(stepsAfter(b, 'TodoWrite', { todos: [] }, undefined, NOW)).toBe(null)
})

test('the desktop plan tool: items, advance, done and start', () => {
  const tool = 'mcp__ccd_turn__update_plan'
  const a = stepsAfter(null, tool, { items: plan(3, 0) }, undefined, NOW)!
  const b = stepsAfter(a, tool, { advance: true }, undefined, NOW)!
  expect(b.items.map(i => i.status)).toEqual(['completed', 'in_progress', 'pending'])
  const c = stepsAfter(b, tool, { done: [2], start: 3 }, undefined, NOW)!
  expect(c.items.map(i => i.status)).toEqual(['completed', 'completed', 'in_progress'])
  const d = stepsAfter(c, tool, { advance: true }, undefined, NOW + MINUTE)!
  expect(d.doneAt).toBe(NOW + MINUTE)
  expect(stepsProgress(d)).toEqual({ done: 3, total: 3, at: 3 })
})

test('TaskCreate adds and TaskUpdate changes one task by its id', () => {
  let s: Steps | null = null
  s = stepsAfter(s, 'TaskCreate', { subject: 'Write the parser' }, { task: { id: '1' } }, NOW)
  s = stepsAfter(s, 'TaskCreate', { subject: 'Draw the strip' }, 'Task #2 created', NOW)
  expect(s!.items.map(i => i.id)).toEqual(['1', '2'])
  s = stepsAfter(s, 'TaskUpdate', { taskId: '1', status: 'completed' }, undefined, NOW)
  s = stepsAfter(s, 'TaskUpdate', { taskId: '2', status: 'in_progress' }, undefined, NOW)
  expect(stepsProgress(s!)).toEqual({ done: 1, total: 2, at: 2 })
  expect(s!.created).toBe(2)
  s = stepsAfter(s, 'TaskUpdate', { taskId: '2', status: 'deleted' }, undefined, NOW)
  expect(s!.items.length).toBe(1)
})

test('a finished list stays a short while, then leaves; a new list starts a new run', () => {
  const done = stepsAfter(null, 'TodoWrite', { todos: plan(2, 2) }, undefined, NOW)!
  expect(isStepsShown(done, NOW + MINUTE)).toBe(true)
  expect(isStepsShown(done, NOW + STEPS_LINGER + 1)).toBe(false)
  const fresh = stepsAfter(done, 'TodoWrite', { todos: plan(4, 0) }, undefined, NOW + 10 * MINUTE)!
  expect(fresh.startedAt).toBe(NOW + 10 * MINUTE)
  expect(fresh.created).toBe(4)
})

test('a question names what Claude asked', () => {
  expect(questionWaiting({ questions: [{ header: 'Approach', question: 'Plan first?' }] }, NOW)).toEqual({ since: NOW, kind: 'question', label: 'Approach' })
  expect(questionWaiting({}, NOW).label).toBe('a question')
})

const el = new Proxy({}, { get: (_t, name) => (props: any) => ({ type: name, ...props }) }) as any

function strip(over: { columns: number; desktop: boolean; steps?: Steps | null; waiting?: any }) {
  const l: Live = {
    startedAt: NOW - 60 * MINUTE, tokens: 186_000, window: 1_000_000, fixed: 46_000, conversation: 140_000, adds: [],
    cacheAt: NOW - 10 * MINUTE, model: 'claude-opus-5-5', limits: [{ kind: 'five_hour', percentUsed: 38 }], usd: 9.8, turnBase: 9.5,
    turns: [], weights: [], mcp: [], mcpUsed: [], budgetWarned: false, lastToastAt: 0,
  }
  return drawStrip(el, { live: l, week: null, suggestion: undefined, insights: 0, now: NOW, onSuggestion() {}, onOpen() {}, onInsights() {}, ...over }) as any
}

test('the strip adds step 2/5 and the waiting part, and keeps every other part', () => {
  const steps = stepsAfter(null, 'TodoWrite', { todos: plan(5, 1) }, undefined, NOW - 12 * MINUTE)!
  const waiting = { since: NOW - 6 * MINUTE, kind: 'question', label: 'Approach' }
  const before = (strip({ columns: 200, desktop: true }).children as any[]).map(c => c.key)
  const tree = strip({ columns: 200, desktop: true, steps, waiting })
  const keys = (tree.children as any[]).map(c => c.key)
  expect(keys[0]).toBe('waiting')
  for (const k of before) expect(keys).toContain(k)
  expect(keys.indexOf('steps')).toBe(keys.indexOf('cache') + 1)
  const json = JSON.stringify(tree)
  expect(json).toContain('step 2/5')
  expect(json).toContain('Claude is waiting · 6 min')
  expect(json).toContain('1 of 5 done · 12m')
  expect(json).toContain('"Step 2"')
  expect(json).toContain('Waiting on you · 6 min')
  expect(json).toContain('"Approach"')
})

test('a narrow strip uses the short forms', () => {
  const steps = stepsAfter(null, 'TodoWrite', { todos: plan(5, 1) }, undefined, NOW)!
  const json = JSON.stringify(strip({ columns: 60, desktop: false, steps, waiting: { since: NOW - 6 * MINUTE, kind: 'question', label: 'x' } }))
  expect(json).toContain('waiting 6m')
  expect(json).not.toContain('step 2/5')
})

test('with the side pane open the desktop strip still has room for the steps', () => {
  const steps = stepsAfter(null, 'TodoWrite', { todos: plan(3, 1) }, undefined, NOW)!
  const tree = strip({ columns: 80, desktop: true, steps, waiting: { since: NOW, kind: 'question', label: 'x' } })
  const keys = (tree.children as any[]).map(c => c.key)
  expect(keys).toContain('steps')
  expect(keys).toContain('cache')
})
