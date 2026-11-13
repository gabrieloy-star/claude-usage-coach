// Tests for the scanners and their safety checks, on fixture folders and git repos made here.
// Run: node --test scripts/checks/
// Nothing outside the temporary fixture folder is read for a decision or changed.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPTS = fileURLToPath(new URL('..', import.meta.url))
const DAY = 86_400_000
let home, trashDir

function run(script, args, env = {}) {
  const out = execFileSync('node', [join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, USAGE_COACH_HOME: home, USAGE_COACH_TRASH: trashDir, USAGE_COACH_NO_PROCESSES: '1', ...env },
  })
  return JSON.parse(out)
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(path, text = 'x') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function age(path, days) {
  const t = (Date.now() - days * DAY) / 1000
  utimesSync(path, t, t)
}

const ID = n => `0000000${n}-0000-4000-8000-000000000000`

before(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'usage-coach-check-')))
  trashDir = join(home, 'Trash')
  mkdirSync(trashDir)
})

after(() => rmSync(home, { recursive: true, force: true }))

test('disk: sessions group by repo, worktree folders included, with age buckets', () => {
  const projects = join(home, '.claude', 'projects')
  const main = join(projects, '-Users-me-apps-dev-shop')
  const wt = join(projects, '-Users-me-apps-dev-shop--claude-worktrees-fix-a1b2c3')
  write(join(main, ID(1) + '.jsonl'), 'a'.repeat(1000))
  write(join(main, ID(1), 'subagents', 'agent-1.jsonl'), 'b'.repeat(500))
  write(join(wt, ID(2) + '.jsonl'), 'c'.repeat(200))
  write(join(projects, '-Users-me-spare', 'memory', 'MEMORY.md'), 'keep me')
  age(join(main, ID(1) + '.jsonl'), 40)
  const d = run('disk.mjs', ['scan', '--project', '-Users-me-apps-dev-shop'])
  const shop = d.projects.find(p => p.key === '-Users-me-apps-dev-shop')
  assert.equal(shop.sessions, 2)
  assert.equal(shop.worktrees, 1)
  assert.equal(shop.bytes, 1700)
  assert.equal(shop.ages[3].count, 1)
  assert.equal(shop.ages[0].count, 1)
  assert.equal(d.total.subagents, 500)
  // A folder with only memory/ is not a project with sessions, and never offered.
  assert.ok(!d.projects.some(p => p.key === '-Users-me-spare'))
  assert.equal(d.old30.count, 1)
  assert.deepEqual(d.project.top.map(s => s.where), ['main', 'fix'])
})

test('disk trash: moves an old session and its folder; skips the current, recent and sidebar ones', () => {
  const folder = join(home, '.claude', 'projects', '-Users-me-apps-dev-shop')
  for (const n of [3, 4, 5, 6]) {
    write(join(folder, ID(n) + '.jsonl'), 'z')
    age(join(folder, ID(n) + '.jsonl'), 45)
  }
  write(join(folder, ID(3), 'tool-results', 'r.txt'), 'out')
  age(join(folder, ID(5) + '.jsonl'), 0)
  // A session still open in the Desktop sidebar.
  write(join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'a', 'b', 'local_x.json'),
    JSON.stringify({ cwd: '/Users/me/apps_dev/shop', cliSessionId: ID(6), isArchived: false }))
  const paths = [3, 4, 5, 6].map(n => join(folder, ID(n) + '.jsonl'))
  const r = run('disk.mjs', ['trash', '--current', ID(4), '--older-days', '30', ...paths, join(folder, '..', 'not-a-session.jsonl')])
  assert.deepEqual(r.moved, [paths[0]])
  assert.equal(existsSync(join(folder, ID(3))), false)
  const why = Object.fromEntries(r.skipped.map(s => [s.path.split('/').pop(), s.why]))
  assert.equal(why[ID(4) + '.jsonl'], 'this session')
  assert.equal(why[ID(5) + '.jsonl'], 'used in the last 24 h')
  assert.equal(why[ID(6) + '.jsonl'], 'open in the Desktop sidebar')
  assert.equal(why['not-a-session.jsonl'], 'not a session transcript')
  assert.ok(existsSync(join(home, '.claude', 'projects', '-Users-me-spare', 'memory', 'MEMORY.md')))
})

/** A repo with one worktree per case, each committed, merged or left as the case needs. */
function repoWithCases() {
  const repo = join(home, 'apps', 'shop')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 'T')
  write(join(repo, '.gitignore'), 'node_modules/\n.env\nSecrets.xcconfig\nios/App.xcodeproj/\n.claude/\n')
  write(join(repo, 'Secrets.xcconfig'), 'KEY=1')
  write(join(repo, 'ios', 'project.yml'), 'name: App')
  write(join(repo, 'a.txt'), 'a')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  const add = (name, branch) => {
    const path = join(repo, '.claude', 'worktrees', name)
    git(repo, 'worktree', 'add', '-q', '-b', branch, path)
    return path
  }
  const cases = {}
  // Merged and clean, with regenerable and identical ignored files: safe.
  cases.done = add('done', 'claude/done')
  write(join(cases.done, 'node_modules', 'x', 'i.js'))
  write(join(cases.done, 'ios', 'App.xcodeproj', 'project.pbxproj'))
  write(join(cases.done, 'Secrets.xcconfig'), 'KEY=1')
  // Pending changes.
  cases.dirty = add('dirty', 'claude/dirty')
  write(join(cases.dirty, 'a.txt'), 'edited')
  // A commit not in main.
  cases.ahead = add('ahead', 'claude/ahead')
  write(join(cases.ahead, 'b.txt'), 'b')
  git(cases.ahead, 'add', '.')
  git(cases.ahead, 'commit', '-qm', 'work')
  // An ignored file that is not made again.
  cases.env = add('env', 'claude/env')
  write(join(cases.env, '.env'), 'TOKEN=secret')
  // A Secrets.xcconfig that differs from the main checkout's.
  cases.secret = add('secret', 'claude/secret')
  write(join(cases.secret, 'Secrets.xcconfig'), 'KEY=2')
  // Open in a Desktop session.
  cases.open = add('open', 'claude/open')
  write(join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'a', 'b', 'local_open.json'),
    JSON.stringify({ cwd: cases.open, worktreePath: cases.open, isArchived: false }))
  return { repo, cases }
}

test('worktrees: only clean, merged ones with nothing to keep and nobody in them pass', () => {
  const { repo, cases } = repoWithCases()
  const r = run('mac.mjs', ['repos', '--repo', repo]).repos[0]
  const by = Object.fromEntries(r.trees.map(t => [t.name, t.why ?? []]))
  assert.deepEqual(by.done, [])
  assert.deepEqual(by.dirty, ['pending changes'])
  assert.deepEqual(by.ahead, ['work not in main'])
  assert.match(by.env.join(), /files to keep: \.env/)
  assert.match(by.secret.join(), /files to keep: Secrets\.xcconfig/)
  assert.deepEqual(by.open, ['a Desktop session is open in it'])

  // The action checks again: only "done" goes, and its branch stays.
  const done = run('mac.mjs', ['remove-worktrees', ...Object.values(cases)])
  assert.deepEqual(done.removed, [cases.done])
  assert.equal(existsSync(cases.done), false)
  assert.match(git(repo, 'branch', '--list', 'claude/done'), /claude\/done/)
  assert.equal(done.skipped.length, 5)
  for (const p of [cases.dirty, cases.ahead, cases.env, cases.secret, cases.open]) assert.ok(existsSync(p))
})

test('worktrees: a worktree that changes after the scan is skipped by the action', () => {
  const repo = join(home, 'apps', 'shop')
  const late = join(repo, '.claude', 'worktrees', 'late')
  git(repo, 'worktree', 'add', '-q', '-b', 'claude/late', late)
  assert.deepEqual(run('mac.mjs', ['repos', '--repo', repo]).repos[0].trees.find(t => t.name === 'late').why, undefined)
  write(join(late, 'new.txt'), 'started working again')
  const r = run('mac.mjs', ['remove-worktrees', late])
  assert.deepEqual(r.removed, [])
  assert.equal(r.skipped[0].why, 'pending changes')
  assert.ok(existsSync(late))
})

test('xcode: orphan and old builds go to the Trash; recent and unknown ones stay', () => {
  const derived = join(home, 'Library', 'Developer', 'Xcode', 'DerivedData')
  const plist = (workspace, last) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>LastAccessedDate</key><date>${new Date(last).toISOString().replace(/\.\d+Z$/, 'Z')}</date><key>WorkspacePath</key><string>${workspace}</string></dict></plist>`
  const exists = join(home, 'apps', 'shop', 'a.txt')
  const make = (name, workspace, last) => write(join(derived, name, 'info.plist'), plist(workspace, last))
  make('Gone-aaa', join(home, 'nowhere', 'Gone.xcworkspace'), Date.now())
  make('Old-bbb', exists, Date.now() - 10 * DAY)
  make('Recent-ccc', exists, Date.now() - DAY)
  write(join(derived, 'NoInfo-ddd', 'x'))
  const r = run('mac.mjs', ['clear-xcode', ...['Gone-aaa', 'Old-bbb', 'Recent-ccc', 'NoInfo-ddd'].map(n => join(derived, n)), join(home, 'elsewhere')])
  assert.deepEqual(r.moved.map(p => p.split('/').pop()).sort(), ['Gone-aaa', 'Old-bbb'])
  const why = Object.fromEntries(r.skipped.map(s => [s.path.split('/').pop(), s.why]))
  assert.equal(why['Recent-ccc'], 'used in the last 7 days')
  assert.equal(why['NoInfo-ddd'], 'no build information')
  assert.equal(why.elsewhere, 'not an Xcode build folder')
  assert.deepEqual(readdirSync(derived).sort(), ['NoInfo-ddd', 'Recent-ccc'])
})

test('session: context per request, compactions, cold returns, heavy prompts and what filled it', () => {
  const folder = join(home, '.claude', 'projects', '-Users-me-apps-dev-shop')
  const id = ID(9)
  const at = i => new Date(Date.UTC(2026, 10, 1, 10, i)).toISOString()
  const rows = [
    { type: 'user', timestamp: at(0), message: { content: 'Base directory for this skill: /x' } },
    { type: 'assistant', timestamp: at(1), message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 150_000, output_tokens: 100 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'o'.repeat(4000) }] } },
    { type: 'assistant', timestamp: at(3), message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 151_000, cache_creation_input_tokens: 1_000, output_tokens: 50 }, content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'compact_boundary', timestamp: at(4) },
    { type: 'user', timestamp: at(5), message: { content: 'fix the login redirect please' } },
    { type: 'assistant', timestamp: at(6), message: { id: 'm3', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500, output_tokens: 10 }, content: [{ type: 'text', text: 'ok' }] } },
  ]
  write(join(folder, id + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'))
  const p = run('session.mjs', ['--id', id])
  assert.equal(p.prompts, 2)
  assert.equal(p.requests, 3)
  assert.equal(p.compactions.length, 1)
  assert.equal(p.cold.length, 1)
  assert.deepEqual(p.series.map(x => x[1]), [150_010, 152_010, 20_510])
  assert.deepEqual(p.heavy.map(h => h.label), ['Skill', '“fix the login redirect plea…”'])
  assert.equal(p.filled.tools.Bash, 1000)
  assert.ok(p.filled.you > 0 && p.filled.claude > 0)
})
