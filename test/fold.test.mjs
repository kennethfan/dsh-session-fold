/**
 * dsh-session-fold 的单元/集成测试（node:test，无第三方依赖）。
 *
 * 用一个最小 fake Session 复现宿主的关键语义：
 * - `surface.nodes` 是有序 surface 节点序号列表；
 * - `append(…, { surfaceOp: { op: 'replace', startSeq, endSeq } })` 会把区间节点
 *   从 surface 移除、把新节点压到尾部；
 * - `compaction/prune` 是纯日志事件，不进 surface。
 *
 * 运行：node --test test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FOLD_MARKER,
  clipHead,
  clipTail,
  codePointLength,
  currentTurnOf,
  flattenTextContent,
  foldSession,
  hasOpenCompaction,
  hasOpenTurn,
  listFoldStubs,
  parseFoldStub,
  recoverOriginal,
  renderFoldStub,
  searchFoldedOriginals,
  unfoldAll,
  unfoldOne,
  selectFoldCandidates,
  summarizeToolCall,
} from '../lib/fold.js'

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** 造一个最小 fake Session。 */
function createSession(events) {
  const log = events.map((event, index) => ({ seq: index, time: 1000 + index, ...event }))
  const nodes = log.filter((event) => SURFACE_TYPES.has(event.type)).map((event) => event.seq)
  const session = {
    id: 'session-1',
    surface: {
      get nodes() {
        return nodes
      },
    },
    eventAt: (seq) => log[seq],
    snapshotEvents: () => log,
    requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }),
    deriveEventMessage: (event) => event.data.message,
    append(type, data, opts) {
      const seq = log.length
      const event = { type, seq, time: 2000 + seq, data, ...(opts ?? {}) }
      log.push(event)
      if (SURFACE_TYPES.has(type)) {
        assert.ok(event.surfaceOp, `surface 事件 ${type} 必须带 surfaceOp`)
        if (event.surfaceOp !== 'append') {
          const { startSeq, endSeq } = event.surfaceOp
          const from = nodes.indexOf(startSeq)
          const to = nodes.indexOf(endSeq)
          assert.ok(from >= 0 && to >= from, 'replace 区间必须是当前 surface 节点')
          nodes.splice(from, to - from + 1)
        }
        nodes.push(seq)
      } else {
        assert.equal(event.surfaceOp, undefined, '日志事件不能带 surfaceOp')
      }
      return event
    },
  }
  return session
}

/** 造一个只做「每 4 字符 1 token」估算的 token meter。 */
function createTokenMeter() {
  return {
    estimateMessage(message) {
      const text = (message?.content ?? []).map((block) => block?.text ?? '').join('')
      return Math.max(1, Math.ceil(text.length / 4))
    },
    measure: () => ({ totalTokens: 0 }),
  }
}

/** 造一个总是成功的 spill store。 */
function createSpillStore() {
  const saved = []
  return {
    saved,
    async saveText(input) {
      saved.push(input)
      return {
        locator: `/tmp/spill/${input.suggestedName}`,
        bytes: Buffer.byteLength(input.content, 'utf8'),
        retrievalHint: `read 或 grep 这个文件：/tmp/spill/${input.suggestedName}`,
      }
    },
  }
}

function createCtx() {
  const tokenMeter = createTokenMeter()
  const spillStore = createSpillStore()
  const warnings = []
  return {
    tokenMeter,
    spillStore,
    warnings,
    get: () => undefined,
    logger: {
      info() {},
      warn: (message) => warnings.push(message),
      debug() {},
    },
  }
}

const BASH_ARGS = JSON.stringify({ command: 'go test ./... 2>&1 | tail -n 200' })

/** 一条 2000 字符的假 bash 输出。 */
function longText(tag, size = 2000) {
  return `${tag}-start\n${'x'.repeat(size)}\n${tag}-end`
}

/** 一个标准的 5 步会话：turn1 一条长输出、turn4 一条长输出、turn5 一条在保留窗口内。 */
function createConversation() {
  return createSession([
    { type: 'user/message', surfaceOp: 'append', data: { message: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '开始干活' }] } } },
    {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        message: {
          id: 'a1',
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: BASH_ARGS }],
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
          content: [{ type: 'text', text: longText('turn1') }],
        },
      },
    },
    {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        message: {
          id: 'a2',
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'tool-call', id: 'call-2', name: 'bash', arguments: BASH_ARGS }],
        },
      },
    },
    {
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 4,
        step: 1,
        message: {
          id: 'r2',
          role: 'tool',
          source: { kind: 'tool', callId: 'call-2' },
          toolCallId: 'call-2',
          content: [{ type: 'text', text: longText('turn4') }],
        },
      },
    },
    {
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 5,
        step: 1,
        message: {
          id: 'r3',
          role: 'tool',
          source: { kind: 'tool', callId: 'call-2' },
          toolCallId: 'call-2',
          content: [{ type: 'text', text: longText('turn5') }],
        },
      },
    },
  ])
}

const BASE_CONFIG = {
  auto: true,
  foldAtRatio: 0.25,
  foldAtTokens: 32768,
  foldThresholdChars: 800,
  headChars: 200,
  tailChars: 80,
  retainTurns: 3,
  minCandidates: 5,
  maxPerPass: 20,
  command: true,
}

test('码点截取不会切开代理对', () => {
  assert.equal(codePointLength('😀a'), 2)
  assert.equal(clipHead('😀😀😀', 2), '😀😀')
  assert.equal(clipTail('😀😀😀', 2), '😀😀')
})

test('flattenTextContent 统计富内容并拼接文本', () => {
  const result = flattenTextContent([
    { type: 'text', text: 'a' },
    { type: 'image', ref: {} },
    { type: 'text', text: 'b' },
  ])
  assert.equal(result.text, 'a\nb')
  assert.equal(result.rich, 1)
})

test('summarizeToolCall 优先取 command 字段', () => {
  assert.equal(summarizeToolCall('bash', BASH_ARGS), 'command=go test ./... 2>&1 | tail -n 200')
  assert.equal(summarizeToolCall('bash', 'not-json'), 'not-json')
})

test('selectFoldCandidates 跳过保留窗口、错误结果与已折叠内容', () => {
  const session = createConversation()
  const candidates = selectFoldCandidates(session, BASE_CONFIG, 7)
  // 当前第 7 轮：turn5 在最近 3 轮内（7-5=2 < 3）不可折；turn1、turn4 可折。
  assert.deepEqual(candidates.map((candidate) => candidate.seq), [2, 4])
  assert.equal(candidates[0].toolName, 'bash')
  assert.match(candidates[0].summary, /command=go test/)

  // 错误结果永远不折。
  const errorSession = createConversation()
  errorSession.eventAt(4).data.message.isError = true
  assert.deepEqual(selectFoldCandidates(errorSession, BASE_CONFIG, 7).map((c) => c.seq), [2])
})

test('renderFoldStub 保留头尾并带上原文路径', () => {
  const candidate = {
    text: longText('t', 2000),
    toolName: 'bash',
    summary: 'command=go test',
  }
  const stub = renderFoldStub(BASE_CONFIG, candidate, {
    locator: '/tmp/spill/bash-9.txt',
    bytes: 2048,
    retrievalHint: 'grep 这个文件',
  })
  assert.ok(stub.includes(FOLD_MARKER))
  assert.ok(stub.includes('原输出'))
  assert.ok(stub.includes('/tmp/spill/bash-9.txt'))
  assert.ok(stub.startsWith('t-start'))
  assert.ok(stub.endsWith('t-end'))
  assert.ok(stub.length < candidate.text.length)
})

test('foldSession 未达压力且候选不足时不动手', async () => {
  const session = createSession([
    {
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'r1',
          role: 'tool',
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
          content: [{ type: 'text', text: longText('only') }],
        },
      },
    },
  ])
  const ctx = createCtx()
  const result = await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, {
    turn: 9,
    force: false,
  })
  assert.equal(result.folded, 0)
  assert.equal(result.candidates, 1)
  assert.equal(ctx.spillStore.saved.length, 0)
})

test('foldSession 达压力阈值时折叠并正确记账', async () => {
  const session = createConversation()
  const ctx = createCtx()
  ctx.tokenMeter.measure = () => ({ totalTokens: 100_000 })
  const nodesBefore = [...session.surface.nodes]
  const result = await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, {
    turn: 7,
    force: false,
  })

  assert.equal(result.folded, 2)
  assert.ok(result.savedTokens > 0)
  assert.equal(ctx.spillStore.saved.length, 2)
  // 每次替换前紧邻一条 prune 影子计价事件。
  const log = session.snapshotEvents()
  for (const event of log.filter((item) => item.type === 'compaction/prune')) {
    const next = log[event.seq + 1]
    assert.equal(next.type, 'tool/result')
    assert.equal(next.seq, event.seq + 1)
    // 被遮蔽的节点必须完整出现在 sourceEventSeqs 里。
    assert.deepEqual(next.sourceEventSeqs, event.data.shadowedSeqs)
  }
  // 被折的两条离开 surface，新替身进入 surface；最近一轮那条原样保留。
  assert.deepEqual(session.surface.nodes, [0, 1, 3, 5, ...log.filter((e) => e.surfaceOp?.op === 'replace').map((e) => e.seq)])
  assert.ok(session.surface.nodes.includes(5))
  // 替身必须包含落盘路径与折叠标记。
  const replacement = session.deriveEventMessage(session.eventAt(session.surface.nodes[4]))
  assert.ok(replacement.content[0].text.includes(FOLD_MARKER))
  assert.ok(replacement.content[0].text.includes('/tmp/spill/bash-2.txt'))
  assert.ok(nodesBefore.includes(2))
})

test('foldSession 幂等：第二次不再折叠', async () => {
  const session = createConversation()
  const ctx = createCtx()
  ctx.tokenMeter.measure = () => ({ totalTokens: 100_000 })
  const first = await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, { turn: 7, force: false })
  assert.equal(first.folded, 2)
  // 同样走自动路径再跑一次：已折叠的替身不会再被折（幂等）。
  const second = await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, { turn: 7, force: false })
  assert.equal(second.folded, 0)
})

test('foldSession 在压缩进行中直接让路', async () => {
  const session = createConversation()
  session.append('compaction/start', {})
  assert.equal(hasOpenCompaction(session), true)
  const ctx = createCtx()
  const result = await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, { turn: 7, force: true })
  assert.equal(result.busy, true)
  assert.equal(result.folded, 0)
  // 闭合后再折是允许的。
  session.append('compaction/end', {})
  assert.equal(hasOpenCompaction(session), false)
})

test('富内容工具结果不折叠', async () => {
  const session = createSession([
    {
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'r1',
          role: 'tool',
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
          content: [
            { type: 'text', text: longText('rich') },
            { type: 'image', ref: { id: 'img' } },
          ],
        },
      },
    },
  ])
  const candidates = selectFoldCandidates(session, BASE_CONFIG, 9)
  assert.equal(candidates.length, 0)
})

test('手动折叠只保护进行中的当前轮，空闲时全折', async () => {
  const session = createConversation()
  session.append('turn/start', { turn: 6 })
  assert.equal(hasOpenTurn(session), true)
  const ctx = createCtx()
  // force=true + 轮次进行中 → 保留窗口退化为 1 轮，turn 5 的结果不动。
  const result = await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, {
    turn: 5,
    force: true,
  })
  assert.equal(result.folded, 2)
  assert.ok(session.surface.nodes.includes(5))

  session.append('turn/end', { turn: 6 })
  assert.equal(hasOpenTurn(session), false)
  const second = await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, {
    turn: 6,
    force: true,
  })
  // 空闲后 turn 5 的那条也进入折叠范围。
  assert.equal(second.folded, 1)
})

test('替身里带稳定 #序号，且能被 parseFoldStub 解析', () => {
  const candidate = { seq: 7, text: longText('t', 2000), toolName: 'bash', summary: 'command=go test' }
  const stub = renderFoldStub(BASE_CONFIG, candidate, {
    locator: '/tmp/spill/bash-7.txt',
    bytes: 2048,
    retrievalHint: 'grep 这个文件',
  })
  assert.ok(stub.includes('[输出已折叠] #7 bash'))
  const parsed = parseFoldStub(stub)
  assert.equal(parsed.sourceSeq, 7)
  assert.equal(parsed.head, 'bash command=go test')
  assert.equal(parsed.locator, '/tmp/spill/bash-7.txt')
  assert.match(parsed.stats, /2014 字符/)
})

test('listFoldStubs 只列当前 surface 上的替身', async () => {
  const session = createConversation()
  const ctx = createCtx()
  ctx.tokenMeter.measure = () => ({ totalTokens: 100_000 })
  assert.equal(listFoldStubs(session).length, 0)
  await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, { turn: 7, force: false })
  const stubs = listFoldStubs(session)
  assert.equal(stubs.length, 2)
  assert.deepEqual(stubs.map((stub) => stub.sourceSeq), [2, 4])
  assert.equal(stubs[0].head, 'bash command=go test ./... 2>&1 | tail -n 200')
})

test('unfoldOne 把替身换回原文，且日志仍可回放', async () => {
  const session = createConversation()
  const ctx = createCtx()
  ctx.tokenMeter.measure = () => ({ totalTokens: 100_000 })
  await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, { turn: 7, force: false })

  const result = unfoldOne(session, 2, { ctx, logger: ctx.logger })
  assert.equal(result.ok, true)
  assert.equal(result.chars, longText('turn1').length)

  // 恢复后的节点回到 surface，内容逐字等于原文。
  const restoredNode = [...session.surface.nodes].map((seq) => session.eventAt(seq)).find((event) => event.type === 'tool/result' && event.data.turn === 1)
  const text = restoredNode.data.message.content.map((block) => block.text).join('')
  assert.equal(text, longText('turn1'))

  // #2 不再是折叠项，#4 仍是。
  assert.deepEqual(listFoldStubs(session).map((stub) => stub.sourceSeq), [4])
  // 恢复事件本身也是一条 replace，日志 append-only。
  const log = session.snapshotEvents()
  const last = log.at(-1)
  assert.equal(last.type, 'tool/result')
  assert.equal(last.surfaceOp.op, 'replace')
  assert.equal(last.sourceEventSeqs.length, 1)

  // 恢复不需要 spill 文件：直接从日志里取原文。
  assert.equal(recoverOriginal(session, 2)?.text, longText('turn1'))
})

test('unfoldAll 恢复全部，且对未折叠序号给出原因', async () => {
  const session = createConversation()
  const ctx = createCtx()
  ctx.tokenMeter.measure = () => ({ totalTokens: 100_000 })
  await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, { turn: 7, force: false })
  assert.equal(listFoldStubs(session).length, 2)
  const all = unfoldAll(session, { ctx, logger: ctx.logger })
  assert.deepEqual(all, { restored: 2, failed: 0 })
  assert.equal(listFoldStubs(session).length, 0)
  // 不存在的序号：源事件本身还在但不是折叠项 → source-missing 之外的路径
  assert.equal(unfoldOne(session, 99, { ctx, logger: ctx.logger }).reason, 'source-missing')
})

test('searchFoldedOriginals 按行搜索折叠原文', async () => {
  const session = createConversation()
  const ctx = createCtx()
  ctx.tokenMeter.measure = () => ({ totalTokens: 100_000 })
    await foldSession({ ctx, config: BASE_CONFIG, logger: ctx.logger }, session, { turn: 7, force: false })
  const { matches, scanned } = searchFoldedOriginals(session, 'turn1-end', 10)
  assert.equal(scanned, 2)
  assert.equal(matches.length, 1)
  assert.match(matches[0], /^#2:3: /)
  assert.match(matches[0], /turn1-end/)
})

test('currentTurnOf 取日志中最大轮次', () => {
  const session = createConversation()
  assert.equal(currentTurnOf(session), 5)
})
