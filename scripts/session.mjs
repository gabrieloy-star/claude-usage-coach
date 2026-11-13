#!/usr/bin/env node
// Usage Coach's session profile: one session's transcript read on this Mac. How its context grew
// request by request, where it was compacted, when the cache had expired, which of your prompts
// sent the most tokens, and what filled the context. Also the session's own process: its memory
// and what it left running. Reads only; sends nothing.
//
//   node session.mjs --id <session id> [--root <projects dir>]

import { createReadStream, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { PROJECTS, done, isClaudeCode, processTable } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const id = opt('--id', '')
const root = resolve(opt('--root', PROJECTS))
const COLD_AT = 100_000
const MAX_POINTS = 2000
/** What an image costs in context, roughly. */
const IMAGE = 1600

function find() {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null
  for (const folder of readdirSync(root)) {
    const path = join(root, folder, id + '.jsonl')
    try {
      if (statSync(path).isFile()) return path
    } catch {
      // Not here.
    }
  }
  return null
}

/** Tokens a piece of content takes, estimated from its text (4 characters a token). */
function size(c) {
  if (typeof c === 'string') return c.length / 4
  if (!Array.isArray(c)) return c ? JSON.stringify(c).length / 4 : 0
  let n = 0
  for (const x of c) {
    if (x?.type === 'image') n += IMAGE
    else if (x?.type === 'text') n += (x.text ?? '').length / 4
    else if (x?.type === 'tool_result') n += size(x.content)
    else if (x?.type === 'tool_use') n += JSON.stringify(x.input ?? {}).length / 4
    else if (x?.type !== 'thinking' && x?.type !== 'redacted_thinking') n += JSON.stringify(x).length / 4
  }
  return n
}

function toolGroup(name) {
  if (/^mcp__(claude-in-chrome|Claude_Browser|Control_Chrome)__/.test(name)) return 'Browser'
  if (['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(name)) return name === 'Grep' || name === 'Glob' ? 'Search' : name.startsWith('Web') ? 'Web' : name
  if (name === 'Agent' || name === 'Task') return 'Subagents'
  return 'Other tools'
}

/** How a prompt reads in a list: its first words, or what kind of prompt it was. */
function labelOf(text) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (/^Base directory for this skill:/.test(t)) return 'Skill'
  if (/^This session is being continued/.test(t)) return 'Continued session'
  if (/^\[Image/.test(t)) return 'Image'
  return `“${t.length > 28 ? t.slice(0, 27) + '…' : t}”`
}

async function profile(path) {
  const seen = new Set()
  const points = []
  const compactions = []
  const cold = []
  const prompts = []
  const filled = { tools: {}, claude: 0, you: 0 }
  const toolName = new Map()
  let current = null
  let firstOfTurn = false
  let requests = 0
  let firstAt = 0, lastAt = 0
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(row.timestamp ?? '') || 0
    if (at) {
      firstAt ||= at
      lastAt = at
    }
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      compactions.push(at)
      continue
    }
    if (row.isSidechain) continue
    const c = row.message?.content
    if (row.type === 'user') {
      if (row.isCompactSummary) continue
      const isResult = Array.isArray(c) && c.some(x => x?.type === 'tool_result')
      if (isResult) {
        for (const x of c) if (x?.type === 'tool_result') {
          const g = toolGroup(toolName.get(x.tool_use_id) ?? '')
          filled.tools[g] = (filled.tools[g] ?? 0) + size(x.content)
        }
        continue
      }
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join(' ') : ''
      if (!text || text.startsWith('<')) continue
      filled.you += size(c)
      current = { label: labelOf(text), at, tokens: 0, requests: 0 }
      prompts.push(current)
      firstOfTurn = true
      continue
    }
    if (row.type !== 'assistant') continue
    const m = row.message
    if (Array.isArray(c)) {
      for (const x of c) if (x?.type === 'tool_use') toolName.set(x.id, x.name)
    }
    // One answer is written as several rows (one per block) that repeat its usage: count each
    // row's content, and the usage once.
    if (m?.model !== '<synthetic>') filled.claude += size(c)
    if (!m?.usage || !m.id || seen.has(m.id) || m.model === '<synthetic>') continue
    seen.add(m.id)
    const u = m.usage
    const write = u.cache_creation_input_tokens ?? 0
    const read = u.cache_read_input_tokens ?? 0
    const context = (u.input_tokens ?? 0) + read + write
    requests++
    points.push([at, context])
    if (firstOfTurn && write >= COLD_AT && read < write) cold.push(at)
    firstOfTurn = false
    if (current) {
      current.tokens += context + (u.output_tokens ?? 0)
      current.requests++
    }
  }
  const step = Math.max(1, Math.ceil(points.length / MAX_POINTS))
  const series = points.filter((_, i) => i % step === 0 || i === points.length - 1)
  const sent = prompts.reduce((n, p) => n + p.tokens, 0)
  return {
    prompts: prompts.length, requests, firstAt, lastAt, sent,
    series, compactions, cold,
    heavy: [...prompts].sort((a, b) => b.tokens - a.tokens).slice(0, 4),
    filled: { tools: Object.fromEntries(Object.entries(filled.tools).map(([k, v]) => [k, Math.round(v)])), claude: Math.round(filled.claude), you: Math.round(filled.you) },
  }
}

/** The Claude Code process that ran this script: its memory, and what it left running. */
function own() {
  const table = processTable()
  const byPid = new Map(table.map(r => [r.pid, r]))
  // Walk up to the session's process; the shells in between ran this script and are not left running.
  const chain = new Set([process.pid])
  let r = byPid.get(process.ppid)
  for (let hops = 0; r && !isClaudeCode(r) && hops < 6; hops++) {
    chain.add(r.pid)
    r = byPid.get(r.ppid)
  }
  if (!r || !isClaudeCode(r)) return null
  const kids = table.filter(k => k.ppid === r.pid && !chain.has(k.pid))
  // MCP servers start with every session; they are not something the session left behind.
  const left = kids.filter(k => !/(mcp|uvx|npm exec|--mcp|server\.py|chrome-native-host)/i.test(k.command) && !/^\S*node\s+\S*\/session\.mjs/.test(k.command))
  return {
    pid: r.pid, mb: Math.round(r.mb),
    running: left.map(k => ({ pid: k.pid, mb: Math.round(k.mb), what: commandName(k.command), secs: k.secs })).slice(0, 8),
  }
}

/** A short name for a command line: the eval'd command of a Claude shell, or the program's name. */
function commandName(command) {
  const m = /eval '([^']{1,200})/.exec(command)
  const text = m ? m[1] : command
  return text.replace(/\s+/g, ' ').trim().slice(0, 60)
}

const path = find()
if (!path) done({ error: 'transcript not found' })
else {
  const p = await profile(path)
  done({ at: Date.now(), id, bytes: statSync(path).size, ...p, own: own() })
}
