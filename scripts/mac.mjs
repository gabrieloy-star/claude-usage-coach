#!/usr/bin/env node
// Usage Coach's Mac scanner: what Claude's work takes on this Mac beyond its sessions. Worktree
// folders of your repos, Xcode builds, iPhone simulators, the Claude app, and memory. Reads
// sizes, dates, git status and the process list. Sends nothing.
//
//   node mac.mjs scan [--repo <path>]...
//   node mac.mjs repos --repo <path>...                 worktrees only, for one project
//   node mac.mjs remove-worktrees <worktree path>...   git worktree remove, never --force
//   node mac.mjs clear-xcode <DerivedData folder>...    to the Trash
//   node mac.mjs shutdown-sim <udid>                    xcrun simctl shutdown, never kill
//
// Every action checks each item again first and skips any that no longer passes.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DAY, HOME, PROJECTS, desktopSessions, done, encode, isClaudeCode, isInside, processFolders, processTable, real, sh, trash } from './lib.mjs'

const args = process.argv.slice(2)
const mode = args[0] ?? 'scan'
const now = Date.now()
const DERIVED = join(HOME, 'Library', 'Developer', 'Xcode', 'DerivedData')
const DEVICES = join(HOME, 'Library', 'Developer', 'CoreSimulator', 'Devices')
const APP_DIRS = [
  join(HOME, 'Library', 'Application Support', 'Claude'),
  join(HOME, 'Library', 'Caches', 'com.anthropic.claudefordesktop'),
  join(HOME, 'Library', 'Caches', 'com.anthropic.claudefordesktop.ShipIt'),
  join(HOME, 'Library', 'Caches', 'claude-cli-nodejs'),
  join(HOME, 'Library', 'Logs', 'Claude'),
]
const OLD_BUILD = 7 * DAY

/** Ignored paths that tools make again: caches, dependencies and build output. */
const REGEN = /(^|\/)(node_modules|\.expo|\.next|dist|build|Pods|DerivedData|\.gradle|\.turbo|\.cache|coverage|\.DS_Store|[^/]*\.log|\.swiftpm|\.build|xcuserdata|\.metro-cache|\.claude|__pycache__)(\/|$)/

/** Sizes of a folder's children in one walk: { name: bytes }. */
function childSizes(folder) {
  const out = sh('du', ['-k', '-d', '1', folder], { timeout: 600_000 }) ?? ''
  const sizes = {}
  for (const line of out.split('\n')) {
    const [kb, path] = line.split('\t')
    if (path && path !== folder) sizes[basename(path)] = Number(kb) * 1024
  }
  return sizes
}

// ---------- In use ----------

function usageContext() {
  const records = desktopSessions()
  return {
    openDesktop: records.filter(r => !r.isArchived).map(r => r.cwd).filter(Boolean).map(real),
    records,
    folders: processFolders(),
    table: processTable(),
  }
}

/** The newest transcript Claude wrote for a folder, in ms (0 when none). */
function lastTranscript(folder) {
  let t = 0
  try {
    const dir = join(PROJECTS, encode(folder))
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) t = Math.max(t, statSync(join(dir, f)).mtimeMs)
  } catch {
    // No sessions there.
  }
  return t
}

/** Reasons a folder is in use: an open Desktop session, a running process, recent work. */
function inUse(folder, ctx) {
  const why = []
  if (ctx.openDesktop.some(c => isInside(c, folder))) why.push('a Desktop session is open in it')
  if (ctx.folders.some(p => isInside(p.cwd, folder))) why.push('a program is running in it')
  if (now - lastTranscript(folder) < DAY) why.push('Claude worked in it in the last 24 h')
  return why
}

// ---------- Worktrees ----------

/** Repo roots to look at: the ones Desktop sessions and running Claude sessions name, and any given. */
function repoRoots(ctx, given) {
  const roots = new Set(given.map(p => resolve(p)))
  const add = p => {
    if (!p) return
    const i = p.indexOf('/.claude/worktrees/')
    roots.add(i >= 0 ? p.slice(0, i) : p)
  }
  for (const r of ctx.records) {
    add(r.cwd)
    add(r.origin)
  }
  for (const p of ctx.table.filter(isClaudeCode)) add(ctx.folders.find(f => f.pid === p.pid)?.cwd)
  return [...new Set([...roots].map(real))].filter(r => existsSync(join(r, '.claude', 'worktrees')) && existsSync(join(r, '.git')))
}

function worktreesOf(repo) {
  const out = sh('git', ['worktree', 'list', '--porcelain'], { cwd: repo }) ?? ''
  return out.trim().split('\n\n').map(block => {
    const t = {}
    for (const line of block.split('\n')) {
      const [k, ...v] = line.split(' ')
      t[k] = v.join(' ') || true
    }
    return t
  }).filter(t => typeof t.worktree === 'string' && t.worktree.includes('/.claude/worktrees/'))
}

function defaultBranch(repo) {
  const head = (sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo }) ?? '').trim().replace(/^origin\//, '')
  if (head) return head
  return sh('git', ['rev-parse', '--verify', '--quiet', 'main'], { cwd: repo }) !== null ? 'main' : 'master'
}

/** Ignored files in a worktree that a removal would lose. */
function filesToKeep(wt, repo) {
  const out = sh('git', ['status', '--porcelain', '--ignored', '--untracked-files=normal'], { cwd: wt }) ?? ''
  const ignored = out.split('\n').filter(l => l.startsWith('!! ')).map(l => l.slice(3))
  return ignored.filter(p => {
    if (REGEN.test(p)) return false
    // An Xcode project made by XcodeGen from a project.yml beside it is made again from that file.
    if (/\.xcodeproj\/?$/.test(p) && existsSync(join(wt, p.replace(/[^/]+\.xcodeproj\/?$/, 'project.yml')))) return false
    // An identical copy at the same path in the main checkout loses nothing.
    if (!p.endsWith('/')) {
      try {
        if (readFileSync(join(wt, p)).equals(readFileSync(join(repo, p)))) return false
      } catch {
        // No copy in the main checkout.
      }
    }
    return true
  })
}

/** Every reason this worktree must stay; empty when removing it loses nothing. */
function worktreeHolds(t, repo, main, merged, ctx) {
  const wt = t.worktree
  const why = []
  if (!isInside(wt, join(repo, '.claude', 'worktrees'))) return ['not a Claude worktree']
  if (t.locked) why.push('locked')
  if (t.prunable || !existsSync(wt)) return ['folder missing']
  const branch = typeof t.branch === 'string' ? t.branch.replace('refs/heads/', '') : ''
  if (branch && !merged.has(branch)) why.push(`work not in ${main}`)
  if (!branch) {
    const head = (sh('git', ['rev-parse', 'HEAD'], { cwd: wt }) ?? '').trim()
    if (!head || sh('git', ['merge-base', '--is-ancestor', head, main], { cwd: repo }) === null) why.push(`work not in ${main}`)
  }
  const status = sh('git', ['status', '--porcelain'], { cwd: wt })
  if (status === null) why.push('git could not read it')
  else if (status.trim()) why.push('pending changes')
  const keep = filesToKeep(wt, repo)
  if (keep.length) why.push(`files to keep: ${keep.slice(0, 2).join(', ')}${keep.length > 2 ? ', …' : ''}`)
  why.push(...inUse(wt, ctx))
  return why
}

function repoReport(repo, ctx) {
  const main = defaultBranch(repo)
  const merged = new Set((sh('git', ['branch', '--merged', main, '--format=%(refname:short)'], { cwd: repo }) ?? '').split('\n').filter(Boolean))
  const sizes = childSizes(join(repo, '.claude', 'worktrees'))
  const trees = worktreesOf(repo).map(t => {
    const why = worktreeHolds(t, repo, main, merged, ctx)
    return { path: t.worktree, name: basename(t.worktree), bytes: sizes[basename(t.worktree)] ?? 0, ...(why.length ? { why } : {}) }
  }).sort((a, b) => b.bytes - a.bytes)
  return { repo, name: basename(repo), main, bytes: trees.reduce((n, t) => n + t.bytes, 0), trees }
}

// ---------- Xcode builds ----------

/** One value of a plist, as text (dates come as ISO text); null when missing. */
function plistValue(path, key) {
  const out = sh('plutil', ['-extract', key, 'raw', '-o', '-', path])
  return out === null ? null : out.trim()
}

function buildRunning(table) {
  return table.some(r => /(^|\/)(xcodebuild|XCBBuildService)(\s|$)/.test(r.command))
}

/** orphan: its project is gone. old: unused for 7 days. recent. none: no info.plist. */
function buildState(folder) {
  const info = join(folder, 'info.plist')
  const workspace = plistValue(info, 'WorkspacePath')
  if (!workspace) return { state: 'none' }
  const last = Date.parse(plistValue(info, 'LastAccessedDate') ?? '') || 0
  const project = basename(workspace).replace(/\.(xcworkspace|xcodeproj)$/, '')
  if (!existsSync(workspace)) return { state: 'orphan', workspace, last, project }
  return { state: now - last > OLD_BUILD ? 'old' : 'recent', workspace, last, project }
}

function xcodeReport(table) {
  const sizes = existsSync(DERIVED) ? childSizes(DERIVED) : {}
  const builds = Object.entries(sizes).filter(([name]) => name !== 'ModuleCache.noindex').map(([name, bytes]) => ({ folder: join(DERIVED, name), bytes, ...buildState(join(DERIVED, name)) }))
  return { bytes: Object.values(sizes).reduce((n, b) => n + b, 0), isBuilding: buildRunning(table), builds: builds.sort((a, b) => b.bytes - a.bytes) }
}

// ---------- Simulators ----------

/** Memory of a booted simulator: its launchd_sim and everything under it. */
function simMemory(udid, table) {
  const top = table.find(r => r.command.includes('launchd_sim') && r.command.includes(udid))
  if (!top) return 0
  const kids = new Map()
  for (const r of table) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r])
  let mb = 0
  const stack = [top]
  while (stack.length) {
    const r = stack.pop()
    mb += r.mb
    stack.push(...(kids.get(r.pid) ?? []))
  }
  return Math.round(mb)
}

function simsReport(table) {
  const out = sh('xcrun', ['simctl', 'list', 'devices', '-j'], { timeout: 60_000 })
  let devices = []
  try {
    devices = Object.values(JSON.parse(out ?? '{}').devices ?? {}).flat()
  } catch {
    devices = []
  }
  const sizes = existsSync(DEVICES) ? childSizes(DEVICES) : {}
  const list = devices.map(d => ({ udid: d.udid, name: d.name, state: d.state, bytes: sizes[d.udid] ?? 0, ...(d.state === 'Booted' ? { mb: simMemory(d.udid, table) } : {}) }))
    .filter(d => d.bytes > 0 || d.state === 'Booted')
  return { bytes: Object.values(sizes).reduce((n, b) => n + b, 0), devices: list.sort((a, b) => b.bytes - a.bytes) }
}

/** What would stop a simulator now: a build, a test run or a simctl command using it. */
function simBusy(table) {
  return table.filter(r => /(^|\/)(xcodebuild|XCTRunner|xctest|simctl)(\s|$)/.test(r.command) && r.pid !== process.pid).length
}

// ---------- Memory and disk ----------

function memoryReport(table, sims) {
  const totalMb = Math.round(Number((sh('sysctl', ['-n', 'hw.memsize']) ?? '0').trim()) / 1048576)
  const m = /(\d+)%/.exec(sh('memory_pressure', [], { timeout: 20_000 }) ?? '')
  const claude = table.filter(isClaudeCode)
  const app = table.filter(r => r.command.startsWith('/Applications/Claude.app/'))
  return {
    totalMb, freePct: m ? Number(m[1]) : null,
    sessionsMb: Math.round(claude.reduce((n, r) => n + r.mb, 0)), sessions: claude.length,
    appMb: Math.round(app.reduce((n, r) => n + r.mb, 0)),
    simMb: sims.devices.reduce((n, d) => n + (d.mb ?? 0), 0),
  }
}

function diskReport() {
  for (const vol of ['/System/Volumes/Data', '/']) {
    const out = sh('df', ['-k', vol])
    const cols = out?.trim().split('\n')[1]?.split(/\s+/)
    if (cols && cols.length > 3) return { total: Number(cols[1]) * 1024, used: Number(cols[2]) * 1024, free: Number(cols[3]) * 1024 }
  }
  return null
}

function givenRepos() {
  const given = []
  for (let i = 1; i < args.length; i++) if (args[i] === '--repo' && args[i + 1]) given.push(args[++i])
  return given
}

/** Only the worktrees of the repos given: what the Project view needs, without the whole Mac. */
function reposOnly() {
  const ctx = usageContext()
  const roots = givenRepos().map(r => real(resolve(r))).filter(r => existsSync(join(r, '.claude', 'worktrees')))
  done({ at: now, repos: roots.map(r => repoReport(r, ctx)) })
}

function scan() {
  const t0 = Date.now()
  const ctx = usageContext()
  const repos = repoRoots(ctx, givenRepos()).map(r => repoReport(r, ctx)).filter(r => r.trees.length).sort((a, b) => b.bytes - a.bytes)
  const xcode = xcodeReport(ctx.table)
  const sims = simsReport(ctx.table)
  const appSizes = APP_DIRS.filter(existsSync).map(d => sh('du', ['-sk', d], { timeout: 300_000 })).map(o => Number((o ?? '0').split('\t')[0]) * 1024)
  done({
    at: now, disk: diskReport(), repos, xcode, sims,
    app: { bytes: appSizes.reduce((n, b) => n + b, 0) },
    memory: memoryReport(ctx.table, sims),
    simBusy: simBusy(ctx.table),
    took: Date.now() - t0,
  })
}

// ---------- Actions ----------

function removeWorktrees(paths) {
  const ctx = usageContext()
  const removed = [], skipped = []
  let bytes = 0
  for (const p of paths.map(x => real(resolve(x)))) {
    const i = p.indexOf('/.claude/worktrees/')
    const repo = i >= 0 ? p.slice(0, i) : ''
    const t = repo ? worktreesOf(repo).find(x => x.worktree === p) : undefined
    if (!t) {
      skipped.push({ path: p, why: 'not a worktree of its repo' })
      continue
    }
    const main = defaultBranch(repo)
    const merged = new Set((sh('git', ['branch', '--merged', main, '--format=%(refname:short)'], { cwd: repo }) ?? '').split('\n').filter(Boolean))
    const why = worktreeHolds(t, repo, main, merged, ctx)
    if (why.length) {
      skipped.push({ path: p, why: why[0] })
      continue
    }
    const size = Number((sh('du', ['-sk', p], { timeout: 300_000 }) ?? '0').split('\t')[0]) * 1024
    // No --force: git itself refuses a worktree with changes.
    if (sh('git', ['worktree', 'remove', p], { cwd: repo }) === null) {
      skipped.push({ path: p, why: 'git refused to remove it' })
      continue
    }
    removed.push(p)
    bytes += size
  }
  done({ removed, skipped, bytes })
}

function clearXcode(folders) {
  const table = processTable()
  const building = buildRunning(table)
  const moved = [], skipped = []
  let bytes = 0
  for (const f of folders.map(x => real(resolve(x)))) {
    if (dirname(f) !== real(DERIVED) || !existsSync(f)) {
      skipped.push({ path: f, why: 'not an Xcode build folder' })
      continue
    }
    const s = buildState(f)
    const ok = s.state === 'orphan' || (s.state === 'old' && !building)
    if (!ok) {
      skipped.push({ path: f, why: s.state === 'old' ? 'a build is running' : s.state === 'recent' ? 'used in the last 7 days' : 'no build information' })
      continue
    }
    const size = Number((sh('du', ['-sk', f], { timeout: 300_000 }) ?? '0').split('\t')[0]) * 1024
    const failed = trash(f)
    if (failed) {
      skipped.push({ path: f, why: failed })
      continue
    }
    moved.push(f)
    bytes += size
  }
  done({ moved, skipped, bytes })
}

function shutdownSim(udid) {
  const table = processTable()
  const sims = simsReport(table)
  const d = sims.devices.find(x => x.udid === udid)
  if (!d || d.state !== 'Booted') return done({ ok: false, why: 'the simulator is not running' })
  if (simBusy(table)) return done({ ok: false, why: 'a build or test is using a simulator' })
  const out = sh('xcrun', ['simctl', 'shutdown', udid], { timeout: 120_000 })
  done(out === null ? { ok: false, why: 'the simulator did not shut down' } : { ok: true, mb: d.mb ?? 0 })
}

if (mode === 'remove-worktrees') removeWorktrees(args.slice(1))
else if (mode === 'clear-xcode') clearXcode(args.slice(1))
else if (mode === 'shutdown-sim') shutdownSim(args[1] ?? '')
else if (mode === 'repos') reposOnly()
else scan()
