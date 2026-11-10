/**
 * `/spill-prune` 的单元测试：参数解析、根校验、目录扫描、孤儿判定、删除执行。
 * 全部在 os.tmpdir 下的临时 fixture 里跑，不碰真实 spill 目录。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applyPrune,
  checkSpillRoot,
  collectSpillDirs,
  parsePruneArgs,
  planPrune,
  readableBytes,
  SPILL_DIR_PATTERN,
  spillDirNameForSession,
} from '../lib/prune.js'

const HEX = 'a1b2c3d4e5f6'

/**
 * 造一个 fixture：`<tmp>/spill/<name>/<files>`。
 * @param {object} layout 目录名 → 文件内容数组（空数组表示空目录）
 */
async function makeFixture(layout) {
  const root = await mkdtemp(path.join(tmpdir(), 'fold-prune-'))
  const spill = path.join(root, 'spill')
  await mkdir(spill, { recursive: true })
  for (const [name, files] of Object.entries(layout)) {
    const dir = path.join(spill, name)
    await mkdir(dir, { recursive: true })
    for (const [index, content] of files.entries()) {
      await writeFile(path.join(dir, `f${index}.txt`), content)
    }
  }
  return { root, spill }
}

test('spillDirNameForSession 与 dsh-spill-local 的命名一致', () => {
  const name = spillDirNameForSession('session-71ddee98-7075-4373-965e-45e416082aa1')
  assert.equal(name, 'session-de0590546c35')
  assert.equal(
    name,
    'session-' + createHash('sha256').update('session-71ddee98-7075-4373-965e-45e416082aa1').digest('hex').slice(0, 12),
  )
  assert.match(name, SPILL_DIR_PATTERN)
})

test('parsePruneArgs 解析各种参数组合', () => {
  assert.deepEqual(parsePruneArgs(''), { apply: false, all: false, olderThanDays: undefined })
  assert.deepEqual(parsePruneArgs('   '), { apply: false, all: false, olderThanDays: undefined })
  assert.deepEqual(parsePruneArgs('--apply'), { apply: true, all: false, olderThanDays: undefined })
  assert.deepEqual(parsePruneArgs('--all --apply'), { apply: true, all: true, olderThanDays: undefined })
  assert.deepEqual(parsePruneArgs('--older-than 7 --apply'), { apply: true, all: false, olderThanDays: 7 })
  assert.deepEqual(parsePruneArgs('--older-than=3'), { apply: false, all: false, olderThanDays: 3 })

  assert.equal(parsePruneArgs('--older-than').error, '--older-than 需要天数')
  assert.match(parsePruneArgs('--older-than 0').error, /天数无效/)
  assert.match(parsePruneArgs('--older-than abc').error, /天数无效/)
  assert.match(parsePruneArgs('--nope').error, /无法识别的参数/)
})

test('checkSpillRoot 拒绝危险根', () => {
  assert.equal(checkSpillRoot('').ok, false)
  assert.equal(checkSpillRoot('/').ok, false)
  assert.equal(checkSpillRoot('/tmp').ok, false)
  assert.equal(checkSpillRoot(homedir()).ok, false)
  assert.equal(checkSpillRoot(path.join(homedir(), '.dsh')).ok, false)
  assert.equal(checkSpillRoot(path.join(homedir(), '.dsh', 'sessions')).ok, false)
  assert.equal(checkSpillRoot(path.join(homedir(), '.dsh', 'sessions', 'x')).ok, false)

  const ok = checkSpillRoot('/Users/x/.dsh/spill')
  assert.equal(ok.ok, true)
  assert.equal(ok.root, '/Users/x/.dsh/spill')
})

test('collectSpillDirs 只认 session-<12 hex>，并统计文件与字节', async (t) => {
  const fixture = await makeFixture({
    [`session-${HEX}`]: ['aaa', 'bbb'],
    'session-nothex': ['ccc'],
    keepme: ['ddd'],
  })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const dirs = await collectSpillDirs(fixture.spill)
  assert.equal(dirs.length, 1)
  assert.equal(dirs[0].name, `session-${HEX}`)
  assert.equal(dirs[0].files, 2)
  assert.equal(dirs[0].bytes, 6)
  assert.equal(dirs[0].symlink, false)
})

test('collectSpillDirs 跳过软链接（不跟随目标）', async (t) => {
  const fixture = await makeFixture({ [`session-${HEX}`]: ['x'] })
  const real = path.join(fixture.root, 'outside')
  await mkdir(real, { recursive: true })
  await writeFile(path.join(real, 'payload.txt'), 'important')
  await symlink(real, path.join(fixture.spill, 'session-111111111111'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const dirs = await collectSpillDirs(fixture.spill)
  const link = dirs.find((dir) => dir.name === 'session-111111111111')
  assert.equal(link.symlink, true)
  assert.equal(link.files, 0)
})

test('planPrune 孤儿判定：归档会话算存活，--all 才碰存活目录', () => {
  const dirs = [
    { name: 'session-aaaaaaaaaaaa', path: '/x/a', files: 2, bytes: 10, mtimeMs: 100, symlink: false },
    { name: 'session-bbbbbbbbbbbb', path: '/x/b', files: 1, bytes: 5, mtimeMs: 100, symlink: false },
    { name: 'session-cccccccccccc', path: '/x/c', files: 0, bytes: 0, mtimeMs: 100, symlink: false },
    { name: 'session-dddddddddddd', path: '/x/d', files: 1, bytes: 1, mtimeMs: 100, symlink: true },
  ]
  const liveNames = new Set(['session-bbbbbbbbbbbb'])
  const now = 1000

  const dry = planPrune({ dirs, liveNames, all: false, olderThanDays: undefined, now })
  assert.deepEqual(dry.targets.map((dir) => dir.name), ['session-aaaaaaaaaaaa'])
  assert.deepEqual(
    dry.kept.map((dir) => dir.name),
    ['session-bbbbbbbbbbbb', 'session-cccccccccccc'],
  )
  assert.deepEqual(dry.symlinkSkipped.map((dir) => dir.name), ['session-dddddddddddd'])

  const all = planPrune({ dirs, liveNames, all: true, olderThanDays: undefined, now })
  assert.deepEqual(all.targets.map((dir) => dir.name), ['session-aaaaaaaaaaaa', 'session-bbbbbbbbbbbb', 'session-cccccccccccc'])
})

test('planPrune 的 --older-than 只按 mtime 判定', () => {
  const now = Date.UTC(2026, 10, 10)
  const day = 24 * 60 * 60 * 1000
  const dirs = [
    { name: 'session-aaaaaaaaaaaa', path: '/x/a', files: 1, bytes: 1, mtimeMs: now - 10 * day, symlink: false },
    { name: 'session-bbbbbbbbbbbb', path: '/x/b', files: 1, bytes: 1, mtimeMs: now - 2 * day, symlink: false },
  ]
  const liveNames = new Set(['session-aaaaaaaaaaaa', 'session-bbbbbbbbbbbb'])

  const plan = planPrune({ dirs, liveNames, all: false, olderThanDays: 7, now })
  assert.deepEqual(plan.targets.map((dir) => dir.name), ['session-aaaaaaaaaaaa'])
  assert.deepEqual(plan.kept.map((dir) => dir.name), ['session-bbbbbbbbbbbb'])
})

test('applyPrune 只删给了的目录，并二次校验名字', async (t) => {
  const fixture = await makeFixture({
    [`session-${HEX}`]: ['content'],
    'session-ffffffffffff': ['other'],
  })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const dirs = await collectSpillDirs(fixture.spill)
  const target = dirs.find((dir) => dir.name === `session-${HEX}`)
  const applied = await applyPrune([target, { ...target, path: path.join(fixture.spill, 'keepme') }])
  assert.equal(applied.deleted, 1)
  assert.equal(applied.bytes, 7)
  assert.equal(applied.errors.length, 1)
  assert.match(applied.errors[0], /名字不符合规则/)

  const remaining = await collectSpillDirs(fixture.spill)
  assert.deepEqual(remaining.map((dir) => dir.name), ['session-ffffffffffff'])
})

test('readableBytes 分档', () => {
  assert.equal(readableBytes(0), '0 B')
  assert.equal(readableBytes(1023), '1023 B')
  assert.equal(readableBytes(1536), '1.5 KB')
  assert.equal(readableBytes(1024 * 1024 * 3), '3.0 MB')
})
