/**
 * `/spill-prune` 的纯逻辑：解析参数、扫描 spill 根、判定孤儿、执行删除。
 *
 * 设计约束：
 * - **只碰 spill 根的直接子目录**，且名字必须形如 `session-<sha256(sessionId) 前 12 位>`，
 *   其它任何目录一律不动（避免误删用户自己放进根里的东西）。
 * - **默认 dry-run**，`--apply` 才真正删除。
 * - 归档会话算存活：白名单直接来自会话索引（持久化 ∪ 活实例），不做归档过滤。
 * - 白名单为空时拒绝执行（宁可什么都不做，也不能把全部目录当孤儿）。
 */

import { createHash } from 'node:crypto'
import { lstat, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** spill 会话目录名的正则，与 dsh-spill-local 的 `sessionDir()` 命名一致。 */
export const SPILL_DIR_PATTERN = /^session-[0-9a-f]{12}$/

/**
 * 会话 id → spill 目录名。
 * @param {string} sessionId
 * @returns {string}
 */
export function spillDirNameForSession(sessionId) {
  return 'session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
}

/**
 * 解析命令参数。
 * @param {string} raw
 * @returns {{ apply: boolean, all: boolean, olderThanDays: number | undefined, error?: string }}
 */
export function parsePruneArgs(raw) {
  const result = { apply: false, all: false, olderThanDays: undefined }
  const tokens = String(raw ?? '').trim().split(/\s+/).filter((token) => token.length > 0)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--apply') {
      result.apply = true
      continue
    }
    if (token === '--all') {
      result.all = true
      continue
    }
    const match = /^--older-than(?:=([^ ]+))?$/.exec(token)
    if (match !== null) {
      const value = match[1] ?? tokens[(index += 1)]
      if (value === undefined) { result.error = '--older-than 需要天数'; return result }
      const days = Number.parseInt(value, 10)
      if (!Number.isInteger(days) || days <= 0) {
        result.error = `--older-than 的天数无效：${value}`
        return result
      }
      result.olderThanDays = days
      continue
    }
    result.error = `无法识别的参数：${token}（用法：/spill-prune [--apply] [--all] [--older-than N]）`
    return result
  }
  return result
}

/**
 * 校验 spill 根是否可安全清理：绝对路径、足够深、不是家目录/.dsh/会话根。
 * @param {string} root
 * @returns {{ ok: true, root: string } | { ok: false, reason: string }}
 */
export function checkSpillRoot(root) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    return { ok: false, reason: '没有可用的 spill 根（既没有配置，也拿不到后端根路径）' }
  }
  const resolved = path.resolve(root)
  const segments = resolved.split(path.sep).filter((segment) => segment.length > 0)
  if (segments.length < 2) {
    return { ok: false, reason: `spill 根太浅，拒绝清理：${resolved}` }
  }
  const home = path.resolve(homedir())
  const forbidden = new Set([home, path.join(home, '.dsh'), path.join(home, '.dsh', 'sessions')])
  if (forbidden.has(resolved)) {
    return { ok: false, reason: `拒绝把 ${resolved} 当作 spill 根` }
  }
  if (resolved.startsWith(path.join(home, '.dsh', 'sessions') + path.sep)) {
    return { ok: false, reason: `拒绝清理会话日志目录：${resolved}` }
  }
  return { ok: true, root: resolved }
}

/**
 * 扫描 spill 根下的会话目录。只认 `session-<12 hex>`，软链接一律跳过。
 * @param {string} root
 * @returns {Promise<{ name: string, path: string, files: number, bytes: number, mtimeMs: number, symlink: boolean }[]>}
 */
export async function collectSpillDirs(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const dirs = []
  for (const entry of entries) {
    if (!SPILL_DIR_PATTERN.test(entry.name)) continue
    const full = path.join(root, entry.name)
    let stat
    try {
      stat = await lstat(full)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) {
      dirs.push({ name: entry.name, path: full, files: 0, bytes: 0, mtimeMs: stat.mtimeMs, symlink: true })
      continue
    }
    if (!stat.isDirectory()) continue
    let files = 0
    let bytes = 0
    try {
      for (const file of await readdir(full, { withFileTypes: true })) {
        if (!file.isFile()) continue
        const fileStat = await lstat(path.join(full, file.name))
        files += 1
        bytes += fileStat.size
      }
    } catch {
      // 目录权限或竞态：按「有内容但不计大小」处理，删除仍然安全（只删这一层）。
    }
    dirs.push({ name: entry.name, path: full, files, bytes, mtimeMs: stat.mtimeMs, symlink: false })
  }
  return dirs.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 规划清理：算出要删哪些、跳过哪些。
 * @param {object} input
 * @param {object[]} input.dirs collectSpillDirs 的结果
 * @param {Set<string>} input.liveNames 存活会话对应的目录名
 * @param {boolean} input.all 是否忽略白名单
 * @param {number | undefined} input.olderThanDays 额外的按龄阈值
 * @param {number} input.now 当前时间戳，便于测试注入
 * @returns {{ targets: object[], kept: object[], symlinkSkipped: object[] }}
 */
export function planPrune({ dirs, liveNames, all, olderThanDays, now }) {
  const targets = []
  const kept = []
  const symlinkSkipped = []
  const cutoff = olderThanDays === undefined ? undefined : now - olderThanDays * 24 * 60 * 60 * 1000

  for (const dir of dirs) {
    if (dir.symlink) {
      symlinkSkipped.push(dir)
      continue
    }
    const orphan = !liveNames.has(dir.name)
    // 存活会话可能带 0 个文件（之前被清空），这种空壳目录留给 sweep 收拾，这里不动。
    const deletable = all ? true : orphan || (cutoff !== undefined && dir.mtimeMs < cutoff)
    if (!deletable || (dir.files === 0 && !all)) {
      kept.push(dir)
      continue
    }
    targets.push(dir)
  }
  return { targets, kept, symlinkSkipped }
}

/**
 * 执行删除。删除前再校验一次名字，避免对意外输入动手。
 * @param {object[]} targets planPrune 的 targets
 * @returns {Promise<{ deleted: number, bytes: number, errors: string[] }>}
 */
export async function applyPrune(targets) {
  let deleted = 0
  let bytes = 0
  const errors = []
  for (const dir of targets) {
    if (!SPILL_DIR_PATTERN.test(path.basename(dir.path))) {
      errors.push(`名字不符合规则，跳过：${dir.path}`)
      continue
    }
    try {
      await rm(dir.path, { recursive: true, force: true })
      deleted += 1
      bytes += dir.bytes
    } catch (error) {
      errors.push(`${dir.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { deleted, bytes, errors }
}

/**
 * 人类可读的字节数。
 * @param {number} bytes
 * @returns {string}
 */
export function readableBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
