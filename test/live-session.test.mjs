/**
 * 与真实 Session 契约的集成测试：用宿主随附的 @deepseek-ai/dsh-session 构造
 * detached Session，喂真实的 append 校验（JSON 快照、surface 契约、遮蔽节点
 * 覆盖），验证「折叠」与「恢复」产出的替换事件真的被接受。
 *
 * 这个包不在本仓库的依赖里（只是 peerDependency），所以按下面的顺序动态查找；
 * 一个都找不到就跳过，不算失败。
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { FOLD_MARKER, foldSession, listFoldStubs, unfoldOne } from '../lib/fold.js'

/** 全局安装的 dsh 本体里，其嵌套依赖的相对路径。 */
const NESTED_SUFFIX = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'node_modules',
  '@deepseek-ai',
  'dsh-session',
  'lib',
  'index.js',
)

/**
 * 按优先级列出候选位置：显式环境变量 → 本地 node_modules → 常见全局安装根。
 * @returns {string[]} 去重后的绝对路径（或环境变量给的模块标识符）
 */
function sessionModuleCandidates() {
  const candidates = []

  const override = process.env.DSH_SESSION_MODULE
  if (override !== undefined && override.trim() !== '') candidates.push(override.trim())

  // 本地已安装：包被装进本仓库或上层 node_modules 时可直接解析。
  try {
    candidates.push(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session'))
  } catch {
    // 未安装时忽略，继续找全局安装。
  }

  // 全局安装根：nvm 各版本、Homebrew、系统级、用户级。
  const globalRoots = []
  const nvmRoot = path.join(homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvmRoot)) {
    for (const version of readdirSync(nvmRoot)) {
      globalRoots.push(path.join(nvmRoot, version, 'lib'))
    }
  }
  globalRoots.push('/usr/local/lib', '/opt/homebrew/lib', path.join(homedir(), '.local', 'lib'))

  for (const root of globalRoots) {
    candidates.push(path.join(root, NESTED_SUFFIX))
  }

  return [...new Set(candidates)]
}

/**
 * 依次尝试导入候选位置，取第一个能给出 `Session` 的模块。
 * @returns {Promise<{ Session: any, from: string } | undefined>}
 */
async function loadSessionModule() {
  for (const candidate of sessionModuleCandidates()) {
    if (candidate.startsWith('/') && !existsSync(candidate)) continue
    const specifier = candidate.startsWith('/') || candidate.startsWith('file:')
      ? pathToFileURL(candidate).href
      : candidate
    try {
      const module = await import(specifier)
      if (module?.Session !== undefined) return { Session: module.Session, from: candidate }
    } catch {
      // 解析或加载失败都继续试下一个。
    }
  }
  return undefined
}

const loaded = await loadSessionModule()
const Session = loaded?.Session
const skip =
  Session === undefined
    ? '找不到 @deepseek-ai/dsh-session；装好 DSH 或设置 DSH_SESSION_MODULE 后即可运行真实契约测试'
    : false

if (loaded !== undefined) {
  test('真实 Session 契约测试已启用', (t) => {
    // 把解析到的模块路径打进诊断输出，跳过与启用两种状态都能排查。
    t.diagnostic(`使用 ${loaded.from} 的真实 Session 实现`)
  })
}

const OUTPUT = `go-test-start\n${'x'.repeat(2000)}\ngo-test-end`

function seedEvents() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      surfaceOp: 'append',
      data: { message: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '跑测试' }] } },
    },
    {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        message: {
          id: 'a1',
          role: 'assistant',
          source: { kind: 'model', provider: 'test', model: 'test' },
          content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'go test ./...' }) }],
        },
      },
    },
    {
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'r1',
          role: 'tool',
          source: { kind: 'tool', callId: 'call-1' },
          toolCallId: 'call-1',
          content: [{ type: 'text', text: OUTPUT }],
        },
      },
    },
    { type: 'turn/end', data: { turn: 1 } },
  ]
}

function createSession() {
  const session = Session.create('session-fold-test')
  for (const event of seedEvents()) {
    session.append(
      event.type,
      event.data,
      event.surfaceOp === undefined ? undefined : { surfaceOp: event.surfaceOp },
    )
  }
  return session
}

function createCtx() {
  return {
    tokenMeter: {
      estimateMessage: (message) => Math.max(1, Math.ceil(JSON.stringify(message?.content ?? []).length / 4)),
      measure: () => ({ totalTokens: 100_000 }),
    },
    spillStore: {
      async saveText(input) {
        return {
          locator: `/tmp/spill/${input.suggestedName}`,
          bytes: Buffer.byteLength(input.content, 'utf8'),
          retrievalHint: `grep ${input.suggestedName}`,
        }
      },
    },
    get: () => undefined,
    logger: { info() {}, warn() {}, debug() {} },
  }
}

const CONFIG = {
  auto: true,
  foldAtRatio: 0.25,
  foldAtTokens: 32768,
  foldThresholdChars: 800,
  headChars: 200,
  tailChars: 80,
  retainTurns: 0,
  minCandidates: 5,
  maxPerPass: 20,
}

test('真实 Session 接受折叠产生的 replace 与 prune 影子计价', { skip }, async () => {
  const session = createSession()
  assert.deepEqual([...session.surface.nodes], [1, 2, 3])

  const ctx = createCtx()
  const result = await foldSession({ ctx, config: CONFIG, logger: ctx.logger }, session, { turn: 1, force: true })
  assert.equal(result.folded, 1)
  assert.ok(!session.surface.nodes.includes(3))

  const stub = session.deriveEventMessage(session.eventAt(session.surface.nodes.at(-1)))
  assert.match(stub.content[0].text, /输出已折叠/)

  const log = session.snapshotEvents()
  const prune = log.find((event) => event.type === 'compaction/prune')
  assert.ok(prune !== undefined, '应当记录 compaction/prune')
  const replacement = log[prune.seq + 1]
  assert.equal(replacement.type, 'tool/result')
  assert.deepEqual(replacement.sourceEventSeqs, prune.data.shadowedSeqs)
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  // 替身里带 #序号，指向原始事件 seq。
  assert.ok(stub.content[0].text.includes(`${FOLD_MARKER} #3 bash`))
})

test('真实 Session 接受恢复事件，原文逐字回到 surface', { skip }, async () => {
  const session = createSession()
  const ctx = createCtx()
  await foldSession({ ctx, config: CONFIG, logger: ctx.logger }, session, { turn: 1, force: true })
  assert.equal(listFoldStubs(session).length, 1)

  const restored = unfoldOne(session, 3, { ctx, logger: ctx.logger })
  assert.equal(restored.ok, true)
  assert.equal(listFoldStubs(session).length, 0)

  const last = session.snapshotEvents().at(-1)
  assert.equal(last.type, 'tool/result')
  assert.equal(last.surfaceOp.op, 'replace')
  assert.deepEqual(last.sourceEventSeqs, [6]) // 被遮蔽的是替身节点（折叠时 append 的 seq）

  const message = session.deriveEventMessage(session.eventAt(session.surface.nodes.at(-1)))
  assert.equal(message.content[0].text, OUTPUT)
})
