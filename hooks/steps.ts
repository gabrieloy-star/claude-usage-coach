// Claude's step list and the questions it waits on. Pure: the hooks in register.tsx feed it.
// A step list comes from three tools: TodoWrite (Claude Code's list, sent whole each time),
// TaskCreate / TaskUpdate (one task at a time) and the desktop app's update_plan.

import type { Step, StepStatus, Steps, Waiting } from '../types'

/** How long a finished list stays on the strip before it goes. */
export const STEPS_LINGER = 3 * 60_000

const PLAN_TOOL = /(^|__)update_plan$/
const STATUSES: StepStatus[] = ['pending', 'in_progress', 'completed']

/** The tools that write Claude's step list. */
export function isStepTool(tool: string): boolean {
  return tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate' || PLAN_TOOL.test(tool)
}

/** The tools that put a question to the person and wait for the answer. */
export function isQuestionTool(tool: string): boolean {
  return tool === 'AskUserQuestion'
}

function statusOf(v: unknown): StepStatus {
  return STATUSES.includes(v as StepStatus) ? (v as StepStatus) : 'pending'
}

function titleOf(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

/** A list replaced whole: a new run when the old one was finished or empty, else the same run. */
function replaced(prev: Steps | null, items: Step[], now: number): Steps | null {
  if (!items.length) return null
  const isNewRun = !prev || prev.doneAt !== null || !prev.items.length
  return settle({ items, startedAt: isNewRun ? now : prev!.startedAt, created: isNewRun ? items.length : Math.max(prev!.created, items.length), doneAt: null }, now)
}

/** Marks the moment every step is completed; clears it when one is open again. */
function settle(s: Steps, now: number): Steps {
  const isDone = s.items.length > 0 && s.items.every(i => i.status === 'completed')
  return { ...s, doneAt: isDone ? (s.doneAt ?? now) : null }
}

/** The id TaskCreate gave its task: from the result, else the next number. */
function createdId(result: unknown, prev: Steps | null): string {
  const r = result as any
  const id = r?.task?.id ?? r?.taskId ?? r?.id
  if (typeof id === 'string' || typeof id === 'number') return String(id)
  const text = typeof r === 'string' ? r : typeof r?.text === 'string' ? r.text : ''
  const m = /#(\d+)/.exec(text) ?? /\btask\s+(\d+)/i.exec(text)
  if (m) return m[1]!
  const nums = (prev?.items ?? []).map(i => Number(i.id)).filter(Number.isFinite)
  return String((nums.length ? Math.max(...nums) : 0) + 1)
}

/** The list after one call of a step tool. `args` are the tool's arguments; `result` its answer. */
export function stepsAfter(prev: Steps | null, tool: string, args: any, result: unknown, now: number): Steps | null {
  if (tool === 'TodoWrite') {
    const todos = Array.isArray(args?.todos) ? args.todos : []
    return replaced(prev, todos.map((t: any) => ({ title: titleOf(t?.content), status: statusOf(t?.status) })).filter((t: Step) => t.title), now)
  }
  if (tool === 'TaskCreate') {
    const title = titleOf(args?.subject)
    if (!title) return prev
    const base = prev && prev.doneAt === null ? prev : null
    const item: Step = { id: createdId(result, base), title, status: 'pending' }
    return settle({ items: [...(base?.items ?? []), item], startedAt: base?.startedAt ?? now, created: (base?.created ?? 0) + 1, doneAt: null }, now)
  }
  if (tool === 'TaskUpdate') {
    if (!prev) return prev
    const id = String(args?.taskId ?? '')
    if (!prev.items.some(i => i.id === id)) return prev
    const items = args?.status === 'deleted'
      ? prev.items.filter(i => i.id !== id)
      : prev.items.map(i => i.id !== id ? i : {
        ...i,
        title: titleOf(args?.subject) || i.title,
        status: args?.status ? statusOf(args.status) : i.status,
      })
    return items.length ? settle({ ...prev, items }, now) : null
  }
  if (PLAN_TOOL.test(tool)) {
    if (Array.isArray(args?.items)) {
      return replaced(prev, args.items.map((t: any) => ({ title: titleOf(t?.content), status: statusOf(t?.status) })).filter((t: Step) => t.title), now)
    }
    if (!prev) return prev
    let items = prev.items.map(i => ({ ...i }))
    const at = (n: unknown) => (typeof n === 'number' && n >= 1 && n <= items.length ? n - 1 : -1)
    if (args?.advance === true) {
      const cur = items.findIndex(i => i.status === 'in_progress')
      if (cur >= 0) items[cur]!.status = 'completed'
      const nextAt = items.findIndex((i, k) => k > cur && i.status === 'pending')
      if (nextAt >= 0) items[nextAt]!.status = 'in_progress'
    }
    if (Array.isArray(args?.done)) for (const n of args.done) { const k = at(n); if (k >= 0) items[k]!.status = 'completed' }
    const start = at(args?.start)
    if (start >= 0) {
      items = items.map(i => (i.status === 'in_progress' ? { ...i, status: 'pending' as StepStatus } : i))
      items[start]!.status = 'in_progress'
    }
    return settle({ ...prev, items }, now)
  }
  return prev
}

/** Whether the strip shows the list: while it is open, and a short while after its last step is done. */
export function isStepsShown(s: Steps | null, now: number): s is Steps {
  return !!s && s.items.length > 0 && (s.doneAt === null || now - s.doneAt < STEPS_LINGER)
}

/** The figures the strip draws: steps done, the total, and the step to show (the open one, or the last done). */
export function stepsProgress(s: Steps): { done: number; total: number; at: number } {
  const total = s.items.length
  const done = s.items.filter(i => i.status === 'completed').length
  const open = s.items.findIndex(i => i.status === 'in_progress')
  const firstPending = s.items.findIndex(i => i.status === 'pending')
  const at = open >= 0 ? open + 1 : firstPending >= 0 ? firstPending + 1 : total
  return { done, total, at }
}

/** What Claude is waiting on, from a question it asked. */
export function questionWaiting(args: any, now: number): Waiting {
  const q = Array.isArray(args?.questions) ? args.questions[0] : null
  const label = titleOf(q?.header) || titleOf(q?.question) || 'a question'
  return { since: now, kind: 'question', label: label.length > 60 ? label.slice(0, 59) + '…' : label }
}

/** What Claude is waiting on, from a permission prompt for a tool. */
export function permissionWaiting(tool: string, now: number): Waiting {
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool
  return { since: now, kind: 'permission', label: name }
}
