import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-18T15:00:00Z')
const MINUTE = 60_000
const HEADLESS = "$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on"

/**
 * The world beneath the mod: a session of 200k tokens on Opus, every call the mod makes answered.
 * `headless` stands for the desktop app and the SDK, where only /compact compacts between turns.
 */
function world($: Engine, on: On, { headless = false } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>()
  const compacts: { trigger: string; instructions?: string }[] = []
  const commands: { command: string; args?: string }[] = []
  const status: (string | undefined)[] = []
  let isCommand = false
  on('store.get', async (_$, e: any) => ({ value: store.get(e.key) ?? null }))
  on('store.set', async (_$, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.usage', async () => ({ value: { startedAt: NOW - 60 * MINUTE, context: { tokens: 200_000, window: 1_000_000 }, rateLimits: [], cost: { usd: 10 } } }))
  on('session.compact', async (_$, e) => {
    if (headless && !isCommand) throw new Error(HEADLESS)
    compacts.push({ trigger: e.trigger, instructions: e.instructions })
    return { messages: [{ role: 'user' as const, text: 'Summary.', toolUses: [] }] as any, tokensBefore: 200_000, tokensAfter: 15_000 }
  })
  // /compact as a session runs it: a compaction of the engine's own, through the mod's session.compact hook.
  on('command.run', async (_$, e: any) => {
    commands.push({ command: e.command, args: e.args })
    if (e.command !== 'compact') return { value: {} } as any
    isCommand = true
    try {
      await $.session.compact({ trigger: 'manual', instructions: e.args, messages: [{ role: 'user', text: 'Hello.', toolUses: [] }] as any })
    } finally {
      isCommand = false
    }
    return { value: {} } as any
  })
  on('ui.status', async (_$, e) => {
    status.push((e as any).text)
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('command.register', async () => ({ value: {} }) as any)
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false } }) as any)
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId, index: e.index, answer: 'done', toolUses: [], stopReason: 'end_turn' as const,
      usage: { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 190_000, cache_creation_input_tokens: 10_000, model: e.model },
    }
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  return { clock, compacts, commands, status, savings: () => (store.get('savings') as { kind: string; usd: number }[] | undefined) ?? [] }
}

/** One main-loop turn of one request, as the engine raises it. */
async function turn($: Engine, id: string) {
  await $.turn.start({ text: 'go on', turnId: id })
  const step = $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 4 })
  for await (const _ of step) {
    // The mod's hook reads the step's usage once the stream ends.
  }
  await $.turn.complete({ turnId: id, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
}

test('idle compact runs five minutes before the 1-hour cache expires', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world($, on)
  await turn($, 't1')
  await w.clock.advance(50 * MINUTE)
  expect(w.compacts).toEqual([])
  expect(w.status.some(s => s?.includes('Usage Coach compacts at'))).toBe(true)
  await w.clock.advance(6 * MINUTE)
  expect(w.compacts.length).toBe(1)
  expect(w.compacts[0]!.instructions).toContain('compacted this idle session')
})

test('in the desktop app idle compact goes through /compact', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world($, on, { headless: true })
  await turn($, 't1')
  await w.clock.advance(56 * MINUTE)
  expect(w.commands.filter(c => c.command === 'compact').length).toBe(1)
  expect(w.compacts.length).toBe(1)
  expect(w.compacts[0]!.instructions).toContain('compacted this idle session')
  expect(w.status.some(s => s?.includes('Usage Coach compacted at'))).toBe(true)
})

test('a return after the cache would have expired counts the idle saving', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world($, on, { headless: true })
  await turn($, 't1')
  await w.clock.advance(56 * MINUTE)
  expect(w.savings()).toEqual([])
  await w.clock.advance(30 * MINUTE)
  await turn($, 't2')
  const idle = w.savings().filter(s => s.kind === 'idle')
  expect(idle.length).toBe(1)
  // 200k tokens rewritten on Opus at twice $4 per million, less the compaction: about $1.32.
  expect(idle[0]!.usd).toBeGreaterThan(1.2)
})

test('a return before the cache would have expired saved nothing', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world($, on, { headless: true })
  await turn($, 't1')
  await w.clock.advance(57 * MINUTE)
  await turn($, 't2')
  expect(w.savings().filter(s => s.kind === 'idle')).toEqual([])
})

test('a message before the timer stops idle compact', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world($, on)
  await turn($, 't1')
  await w.clock.advance(30 * MINUTE)
  await $.turn.start({ text: 'next', turnId: 't2' })
  await w.clock.advance(40 * MINUTE)
  expect(w.compacts).toEqual([])
  expect(w.commands.filter(c => c.command === 'compact')).toEqual([])
})
