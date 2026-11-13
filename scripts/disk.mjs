#!/usr/bin/env node
// Usage Coach's disk scanner: what Claude Code's sessions take on disk, by project, and the
// Claude Code sessions running now. Reads file sizes and dates only (no transcript is read,
// except the first lines of the few sessions a list names). Sends nothing.
//
//   node disk.mjs scan [--project <folder key>] [--current <session id>] [--root <projects dir>]
//   node disk.mjs trash --current <session id> --older-days <n> <transcript path>...
//
// trash checks every session again and moves only those that pass to the macOS Trash:
// the transcript and its own folder, never a project folder, memory/ or any other file.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DAY, PROJECTS, bytesOf, desktopSessions, done, encode, isClaudeCode, nameOf, processFolders, processTable, readJson, repoKeyOf, trash, HOME } from './lib.mjs'

const args = process.argv.slice(2)
const mode = args[0] ?? 'scan'
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const root = resolve(opt('--root', PROJECTS))
const current = opt('--current', '')
const now = Date.now()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
const BUCKETS = [1, 7, 30]

/** Every transcript under the projects folder, with the size of its own folder split by kind. */
function sessionsOf() {
  const list = []
  let folders = []
  try {
    folders = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return { list, folders }
  }
  for (const folder of folders) {
    let names = []
    try {
      names = readdirSync(join(root, folder))
    } catch {
      continue
    }
    for (const name of names) {
      if (!UUID.test(name)) continue
      const path = join(root, folder, name)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      const id = name.slice(0, -6)
      const side = join(root, folder, id)
      let sub = 0, results = 0, other = 0
      try {
        for (const part of readdirSync(side)) {
          const b = bytesOf(join(side, part))
          if (part === 'subagents') sub += b
          else if (part === 'tool-results') results += b
          else other += b
        }
      } catch {
        // No folder of its own.
      }
      list.push({ id, folder, path, at: st.mtimeMs, conv: st.size, sub, results, bytes: st.size + sub + results + other })
    }
  }
  return { list, folders }
}

/** Claude Code processes running now, with their folders. */
function claudeProcesses() {
  const rows = processTable().filter(isClaudeCode)
  const cwd = new Map(processFolders().map(p => [p.pid, p.cwd]))
  return rows.map(r => {
    const folder = cwd.get(r.pid) ?? ''
    return { pid: r.pid, mb: Math.round(r.mb), secs: r.secs, cwd: folder, key: folder ? repoKeyOf(encode(folder)) : '' }
  }).filter(p => p.cwd)
}

/** Why a session must not be touched, or null when nothing holds it. */
function holdOf(s, ctx) {
  if (s.id === current) return 'this session'
  if (now - s.at < DAY) return 'used in the last 24 h'
  if (ctx.sidebar.has(s.id)) return 'open in the Desktop sidebar'
  if (ctx.newestOfLive.has(s.path)) return 'its folder has a Claude session running'
  return null
}

function contextOf(list, procs) {
  const records = desktopSessions()
  const sidebar = new Set(records.filter(r => !r.isArchived && r.transcript).map(r => r.transcript))
  const titles = new Map(records.filter(r => r.title && r.transcript).map(r => [r.transcript, r.title]))
  const cwdOf = new Map(records.filter(r => r.cwd && r.transcript).map(r => [r.transcript, r.cwd]))
  const liveFolders = new Set(procs.map(p => encode(p.cwd)))
  const newest = new Map()
  for (const s of list) if (!newest.has(s.folder) || newest.get(s.folder).at < s.at) newest.set(s.folder, s)
  const newestOfLive = new Set([...newest].filter(([f]) => liveFolders.has(f)).map(([, s]) => s.path))
  return { sidebar, titles, cwdOf, newestOfLive }
}

/** The first user prompt and working folder, from the first 64 KB of a transcript. */
function headOf(path) {
  let text = ''
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(65_536)
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    text = buf.subarray(0, n).toString('utf8')
  } catch {
    return {}
  }
  let prompt = '', cwd = ''
  for (const line of text.split('\n')) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd
    if (!prompt && row.type === 'user' && !row.isSidechain) {
      const c = row.message?.content
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find(x => x?.type === 'text')?.text : ''
      if (t && !t.startsWith('<')) prompt = t.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
    if (prompt && cwd) break
  }
  return { prompt, cwd }
}

function titleOf(s, ctx) {
  const custom = readJson(join(dirname(s.path), s.id, 'custom-title.json'))?.customTitle
  const head = headOf(s.path)
  let title = ctx.titles.get(s.id) || (typeof custom === 'string' ? custom : '') || head.prompt || ''
  if (/^This session is being continued/.test(title)) title = 'Continued session'
  const cwd = ctx.cwdOf.get(s.id) || head.cwd || ''
  return { title, cwd: cwd && encode(cwd) === s.folder ? cwd : '' }
}

function where(folder) {
  const i = folder.indexOf('--claude-worktrees-')
  return i < 0 ? 'main' : folder.slice(i + '--claude-worktrees-'.length).replace(/-[0-9a-f]{6}$/, '')
}

function row(s, ctx, withTitle) {
  const hold = holdOf(s, ctx)
  return {
    id: s.id, path: s.path, where: where(s.folder), bytes: s.bytes, sub: s.sub, at: s.at,
    ...(hold ? { hold } : {}),
    ...(withTitle ? titleOf(s, ctx) : {}),
  }
}

function scan() {
  const t0 = Date.now()
  const { list, folders } = sessionsOf()
  const procs = claudeProcesses()
  const ctx = contextOf(list, procs)
  const byKey = new Map()
  const total = { bytes: 0, sessions: list.length, conversations: 0, subagents: 0, toolResults: 0 }
  for (const s of list) {
    total.bytes += s.bytes
    total.conversations += s.conv
    total.subagents += s.sub
    total.toolResults += s.results
    const key = repoKeyOf(s.folder)
    const p = byKey.get(key) ?? { key, name: nameOf(key), sessions: 0, bytes: 0, last: 0, folders: new Set(), ages: BUCKETS.concat(Infinity).map(() => ({ count: 0, bytes: 0 })) }
    byKey.set(key, p)
    p.sessions++
    p.bytes += s.bytes
    p.last = Math.max(p.last, s.at)
    p.folders.add(s.folder)
    // Today, the last 7 days, 7 to 30 days, over 30 days.
    const age = (now - s.at) / DAY
    const i = BUCKETS.findIndex(d => age < d)
    const bucket = p.ages[i < 0 ? BUCKETS.length : i]
    bucket.bytes += s.bytes
    bucket.count++
  }
  for (const f of folders) {
    const key = repoKeyOf(f)
    if (byKey.has(key)) byKey.get(key).folders.add(f)
  }
  // Two projects of one name in different places: the heavier keeps the plain name, the other
  // gets its place, as in "shop (Documents)".
  const seen = new Set()
  for (const p of [...byKey.values()].sort((a, b) => b.bytes - a.bytes)) {
    if (seen.has(p.name)) p.name = `${p.name} (${p.key.split('-').filter(Boolean)[2] ?? 'other'})`
    seen.add(p.name)
  }
  const projects = [...byKey.values()].sort((a, b) => b.bytes - a.bytes).map(p => ({
    key: p.key, name: p.name, sessions: p.sessions, bytes: p.bytes, last: p.last, ages: p.ages,
    folders: p.folders.size, worktrees: [...p.folders].filter(f => f.includes('--claude-worktrees-')).length,
    agentWorktrees: [...p.folders].filter(f => f.includes('--claude-worktrees-agent-')).length,
  }))
  const movable = days => list.filter(s => (now - s.at) / DAY > days && !holdOf(s, ctx))
  const old30 = movable(30)
  const keep = [14, 7].map(days => {
    const older = list.filter(s => (now - s.at) / DAY > days)
    return { days, count: older.length, bytes: older.reduce((n, s) => n + s.bytes, 0), sidebar: older.filter(s => ctx.sidebar.has(s.id)).length }
  })
  const settings = readJson(join(HOME, '.claude', 'settings.json'))
  const project = opt('--project', '')
  let detail
  if (project) {
    const mine = list.filter(s => repoKeyOf(s.folder) === project)
    detail = {
      key: project,
      top: [...mine].sort((a, b) => b.bytes - a.bytes).slice(0, 4).map(s => row(s, ctx, true)),
      stale: mine.filter(s => (now - s.at) / DAY > 30).sort((a, b) => b.bytes - a.bytes).map(s => row(s, ctx, false)),
    }
  }
  done({
    at: now, ms: Date.now() - t0, total, projects,
    old30: { count: old30.length, bytes: old30.reduce((n, s) => n + s.bytes, 0), paths: old30.map(s => s.path), held: list.filter(s => (now - s.at) / DAY > 30).length - old30.length },
    keep,
    cleanupDays: typeof settings?.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : null,
    procs,
    ...(detail ? { project: detail } : {}),
  })
}

/** Checks every session again, then moves those that pass to the Trash. */
function trashSessions() {
  const olderDays = Number(opt('--older-days', '30'))
  const paths = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'))
  const { list } = sessionsOf()
  const procs = claudeProcesses()
  const ctx = contextOf(list, procs)
  const byPath = new Map(list.map(s => [s.path, s]))
  const moved = [], skipped = []
  let bytes = 0
  for (const p of paths) {
    const path = resolve(p)
    const s = byPath.get(path)
    // Only a session transcript directly inside a project folder of ~/.claude/projects.
    if (!s || dirname(dirname(path)) !== root || !UUID.test(basename(path))) {
      skipped.push({ path, why: 'not a session transcript' })
      continue
    }
    const hold = holdOf(s, ctx)
    if (hold) {
      skipped.push({ path, why: hold })
      continue
    }
    if ((now - s.at) / DAY <= olderDays) {
      skipped.push({ path, why: `used in the last ${olderDays} days` })
      continue
    }
    const side = join(dirname(path), s.id)
    const failed = trash(path)
    if (failed) {
      skipped.push({ path, why: failed })
      continue
    }
    // The session's own folder (subagents, tool outputs) goes with it.
    try {
      if (statSync(side).isDirectory()) trash(side)
    } catch {
      // None.
    }
    moved.push(path)
    bytes += s.bytes
  }
  done({ moved, skipped, bytes })
}

if (mode === 'trash') trashSessions()
else scan()
