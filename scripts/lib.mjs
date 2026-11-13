// Shared helpers for Usage Coach's scanners. Node only; every function reads, except trash().
// Nothing here sends data anywhere.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Tests point this at a fixture folder; nothing else sets it.
export const HOME = process.env.USAGE_COACH_HOME || homedir()
export const PROJECTS = join(HOME, '.claude', 'projects')
export const DESKTOP_SESSIONS = join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
export const DAY = 86_400_000

/** Claude Code's folder name for a path: every character that is not a letter or a digit becomes "-". */
export function encode(path) {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

/** The repo key of a project folder: the folder name without its worktree suffix. */
export function repoKeyOf(folder) {
  return folder.split('--claude-worktrees-')[0]
}

/** "-Users-me-apps-dev-shop" -> "shop"; the last readable part of an encoded path. */
export function nameOf(key) {
  const m = key.lastIndexOf('-apps-dev-')
  if (m >= 0) return key.slice(m + '-apps-dev-'.length) || key
  const parts = key.split('-').filter(Boolean)
  return parts.slice(-1)[0] || 'home'
}

/** Runs a command by its argument vector; null when it fails or is missing. */
export function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256e6, timeout: opts.timeout ?? 120_000, cwd: opts.cwd })
  } catch {
    return null
  }
}

/** Bytes under a path, by stat: fast, no file is opened. */
export function bytesOf(path) {
  let total = 0
  let st
  try {
    st = statSync(path)
  } catch {
    return 0
  }
  if (!st.isDirectory()) return st.size
  let entries
  try {
    entries = readdirSync(path)
  } catch {
    return 0
  }
  for (const name of entries) total += bytesOf(join(path, name))
  return total
}

/** Bytes under a large folder through du (kilobytes), for trees of many files. */
export function duBytes(path) {
  const out = sh('du', ['-sk', path], { timeout: 300_000 })
  const kb = out ? Number(out.split('\t')[0]) : NaN
  return Number.isFinite(kb) ? kb * 1024 : bytesOf(path)
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Every Desktop session record: its folder, whether it is archived, and the transcript it continues. */
export function desktopSessions(root = DESKTOP_SESSIONS) {
  const out = []
  ;(function walk(dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.json')) {
        const j = readJson(p)
        if (j && typeof j === 'object') {
          out.push({
            cwd: String(j.worktreePath || j.cwd || ''),
            origin: String(j.originCwd || ''),
            transcript: String(j.cliSessionId || ''),
            isArchived: j.isArchived === true,
            title: typeof j.title === 'string' ? j.title : '',
          })
        }
      }
    }
  })(root)
  return out
}

/** A path as the file system names it (macOS writes /var as /private/var); the path itself when missing. */
export function real(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** True when `path` is `folder` or inside it. */
export function isInside(path, folder) {
  return path === folder || path.startsWith(folder.endsWith('/') ? folder : folder + '/')
}

/** Each running process's working folder (any process: dev servers and tests count too). */
export function processFolders() {
  // Tests run without this Mac's processes, so a build or a session running here cannot change them.
  if (process.env.USAGE_COACH_NO_PROCESSES) return []
  const out = sh('lsof', ['-a', '-d', 'cwd', '-Fpn'], { timeout: 60_000 }) ?? ''
  const list = []
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n')) list.push({ pid, cwd: line.slice(1) })
  }
  return list
}

/** Process table rows: pid, parent, memory in MB, seconds running, command. */
export function processTable() {
  if (process.env.USAGE_COACH_NO_PROCESSES) return []
  const out = sh('ps', ['-axo', 'pid=,ppid=,rss=,etime=,command=']) ?? ''
  const rows = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), mb: Number(m[3]) / 1024, secs: etimeSecs(m[4]), command: m[5] })
  }
  return rows
}

/** "1-12:27:29" -> seconds. */
export function etimeSecs(s) {
  const [d, rest] = s.includes('-') ? s.split('-') : ['0', s]
  const parts = rest.split(':').map(Number).reverse()
  return Number(d) * 86400 + (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600
}

/** A Claude Code session process (the CLI the Desktop app or a terminal runs), not its wrappers. */
export function isClaudeCode(row) {
  return row.mb > 1 && /(\/claude-code\/[\d.]+\/.*\/claude(\s|$)|\/claude\.app\/Contents\/MacOS\/claude(\s|$)|(^|\/)claude(\s|$))/.test(row.command) && !/--chrome-native-host|disclaimer/.test(row.command)
}

/** Moves one path to the Trash with macOS's own command, so Finder's Put Back works. */
export function trash(path) {
  // Tests name a folder that stands for the Trash.
  if (process.env.USAGE_COACH_TRASH) {
    try {
      renameSync(path, join(process.env.USAGE_COACH_TRASH, path.split('/').pop() + '-' + Date.now()))
      return null
    } catch {
      return 'the Trash refused it'
    }
  }
  if (!existsSync('/usr/bin/trash')) return 'the trash command is missing on this Mac'
  return sh('/usr/bin/trash', [path]) === null ? 'the Trash refused it' : null
}

/** Prints the result as one JSON line and ends. */
export function done(value) {
  process.stdout.write(JSON.stringify(value))
}
