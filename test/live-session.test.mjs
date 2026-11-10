/**
 * 与真实 Session 契约的集成测试：用宿主随附的 @deepseek-ai/dsh-session 构造
 * detached Session，喂真实的 append 校验（JSON 快照、surface 契约、遮蔽节点
 * 覆盖），验证「折叠」与「恢复」产出的替换事件真的被接受。
 *
 * 依赖 DSH 安装路径，缺失时自动跳过。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { FOLD_MARKER, foldSession, listFoldStubs, unfoldOne } from '../lib/fold.js'

const SESSION_MODULE =
  '/Users/kenneth/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'

let Session
try {
  ;({ Session } = await import(SESSION_MODULE))
} catch {
  Session = undefined
}

const skip = Session === undefined ? '本机没有 DSH 安装路径，跳过真实 Session 契约测试' : false

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
