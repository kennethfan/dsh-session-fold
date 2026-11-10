/**
 * dsh-session-fold 的核心折叠算法。
 *
 * 设计约束（来自宿主 API，不能违背）：
 * 1. 模型可见的历史只能由「已提交的 session 事件」重建 —— 折叠必须通过
 *    `session.append('tool/result', …, { surfaceOp: { op: 'replace' } })` 落成
 *    真正的 surface 替换事件，不能只改内存里的消息。
 * 2. `compaction/prune` 影子计价事件必须**同步紧跟**在它的 replace 事件之前，
 *    因此所有异步 IO（落盘）必须在替换循环开始前全部做完。
 * 3. 每条替换的 `sourceEventSeqs` 必须完整覆盖被遮蔽的 surface 节点。
 */

/** 折叠标记：模型与回捞逻辑据此识别「这条结果已被折叠」。 */
export const FOLD_MARKER = '[输出已折叠]'

/** 工具调用参数里适合做一行摘要的字段，按优先级排列。 */
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']

/** 一行工具调用摘要的最大字符数。 */
const SUMMARY_MAX_CHARS = 120

/**
 * 按 Unicode 码点计数，不会把 emoji 代理对切成两半。
 * @param {string} text
 * @returns {number}
 */
export function codePointLength(text) {
  if (typeof text !== 'string') return 0
  return [...text].length
}

/**
 * 按码点截取开头。
 * @param {string} text
 * @param {number} chars
 * @returns {string}
 */
export function clipHead(text, chars) {
  if (chars <= 0) return ''
  const units = [...text]
  return units.length <= chars ? text : units.slice(0, chars).join('')
}

/**
 * 按码点截取结尾。
 * @param {string} text
 * @param {number} chars
 * @returns {string}
 */
export function clipTail(text, chars) {
  if (chars <= 0) return ''
  const units = [...text]
  return units.length <= chars ? text : units.slice(units.length - chars).join('')
}

/**
 * 把字节数渲染成人类可读的大小。
 * @param {number} bytes
 * @returns {string}
 */
export function readableSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 统计行数（末尾换行不额外算一行）。
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
  if (text.length === 0) return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * 把工具结果的 content 拍平成纯文本，并统计非文本块数量。
 * 含图片/文件块的富内容一律不折叠（保持块顺序与附件引用，交回给官方 pruner）。
 * @param {readonly any[]} content
 * @returns {{ text: string, rich: number }}
 */
export function flattenTextContent(content) {
  let text = ''
  let rich = 0
  let hasText = false
  for (const block of content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      if (hasText) text += '\n'
      text += block.text
      hasText = true
    } else if (block != null) {
      rich += 1
    }
  }
  return { text, rich }
}

/**
 * 从工具调用参数 JSON 里挑一个字段做一行摘要。
 * @param {string} toolName
 * @param {string} rawArguments 模型产出的原始 JSON 字符串
 * @returns {string}
 */
export function summarizeToolCall(toolName, rawArguments) {
  let args
  try {
    args = JSON.parse(rawArguments ?? '{}')
  } catch {
    // 模型偶尔产出非法 JSON；退化为直接截取原文。
    return clipHead(String(rawArguments ?? '').replace(/\s+/g, ' ').trim(), SUMMARY_MAX_CHARS)
  }
  if (args === null || typeof args !== 'object') return ''
  for (const key of SUMMARY_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return `${key}=${clipHead(value.replace(/\s+/g, ' ').trim(), SUMMARY_MAX_CHARS)}`
    }
  }
  // 没有常见字段时取第一个短字符串值，便于定位「是哪个调用」。
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return clipHead(value.replace(/\s+/g, ' ').trim(), SUMMARY_MAX_CHARS)
    }
  }
  return ''
}

/**
 * 建立 callId → {name, summary} 索引：tool/result 事件只带 callId，
 * 工具名与参数在对应的 assistant tool-call 块里。
 * @param {any} session
 * @param {readonly number[]} nodes
 * @returns {Map<string, { name: string, summary: string }>}
 */
export function collectToolCalls(session, nodes) {
  const calls = new Map()
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    let message
    try {
      message = session.deriveEventMessage(event)
    } catch {
      continue
    }
    for (const block of message?.content ?? []) {
      if (block?.type !== 'tool-call') continue
      calls.set(block.id, {
        name: block.name,
        summary: summarizeToolCall(block.name, block.arguments),
      })
    }
  }
  return calls
}

/**
 * 会话日志里是否存在未闭合的压缩事务（`compaction/start` 没有配对的
 * `compaction/end`）。压缩进行中时不动 surface，避免与 compaction 抢写。
 * @param {any} session
 * @returns {boolean}
 */
export function hasOpenCompaction(session) {
  let open = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/start') {
      open += 1
    } else if (event.type === 'compaction/end' && open > 0) {
      open -= 1
    }
  }
  return open > 0
}

/**
 * 会话里是否有未结束的轮次（最后一个 `turn/start` 还没有配对的 `turn/end`）。
 * 手动 `/fold` 用它决定保留策略：轮次进行中只保护当前轮，
 * 已经空闲则全折。
 * @param {any} session
 * @returns {boolean}
 */
export function hasOpenTurn(session) {
  let open = false
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/**
 * 取会话当前的最大轮次编号，用于手动折叠时判定保留窗口。
 * @param {any} session
 * @returns {number}
 */
export function currentTurnOf(session) {
  let turn = 0
  for (const event of session.snapshotEvents()) {
    const value = event?.data?.turn
    if (typeof value === 'number' && value > turn) turn = value
  }
  return turn
}

/**
 * 选出本轮可折叠的候选。
 * 规则：只看 surface 上的 tool/result；跳过错误结果、富内容、已折叠的、
 * 单条不足阈值的、以及落在最近 retainTurns 轮里的。
 * @param {any} session
 * @param {object} config
 * @param {number} turn 当前轮次
 * @returns {any[]}
 */
export function selectFoldCandidates(session, config, turn, retainTurns = config.retainTurns) {
  const nodes = [...session.surface.nodes]
  const calls = collectToolCalls(session, nodes)
  const candidates = []

  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue

    const message = event.data?.message
    if (message == null) continue
    // 错误结果是排障关键线索，且通常很短：永不折叠。
    if (message.isError === true) continue

    // 保留窗口：最近 retainTurns 轮之内的工具结果原样保留。
    const nodeTurn = event.data?.turn
    if (typeof nodeTurn === 'number' && turn - nodeTurn < retainTurns) continue

    const { text, rich } = flattenTextContent(message.content)
    if (rich > 0) continue
    if (text.length === 0) continue
    if (text.includes(FOLD_MARKER)) continue
    if (codePointLength(text) < config.foldThresholdChars) continue

    const callId = message.source?.callId ?? message.toolCallId
    const call = callId === undefined ? undefined : calls.get(callId)
    candidates.push({
      seq,
      event,
      message,
      text,
      callId,
      toolName: call?.name ?? 'tool',
      summary: call?.summary ?? '',
    })
  }
  return candidates
}

/**
 * 渲染折叠后的替身文本：保留原文开头 + 元信息标记 + 原文结尾。
 * @param {object} config
 * @param {any} candidate
 * @param {{ locator: string, bytes: number, retrievalHint: string }} ref
 * @returns {string}
 */
export function renderFoldStub(config, candidate, ref) {
  const chars = codePointLength(candidate.text)
  const lines = countLines(candidate.text)
  const head = clipHead(candidate.text, config.headChars)
  const tail = clipTail(candidate.text, config.tailChars)

  const call = candidate.summary ? ` ${candidate.summary}` : ''
  const meta = [
    `${FOLD_MARKER} #${candidate.seq} ${candidate.toolName}${call}`,
    `原输出 ${lines} 行 / ${chars} 字符 / ${readableSize(ref.bytes)}`,
    `完整原文：${ref.locator}`,
    `回捞：${ref.retrievalHint}`,
  ].join('\n')

  const parts = [head, `…${meta}…`]
  if (tail.length > 0) parts.push(tail)
  return parts.join('\n\n')
}

/**
 * 从替身文本里解析出折叠项元信息。
 * @param {string} text
 * @returns {{ sourceSeq: number, head: string, stats: string, locator: string } | undefined}
 */
export function parseFoldStub(text) {
  const match = /\[输出已折叠\] #(\d+)(.*)/.exec(text)
  if (match === null) return undefined
  const lines = text.split('\n')
  const locatorLine = lines.find((line) => line.startsWith('完整原文：'))
  const statsLine = lines.find((line) => line.startsWith('原输出 '))
  return {
    sourceSeq: Number(match[1]),
    head: `${match[2].startsWith(' ') ? '' : ' '}${match[2]}`.trim(),
    stats: statsLine === undefined ? '' : statsLine.replace('原输出 ', '').trim(),
    locator: locatorLine === undefined ? '' : locatorLine.slice('完整原文：'.length).trim(),
  }
}

/**
 * 列出当前 surface 上所有折叠替身。
 * @param {any} session
 * @returns {any[]}
 */
export function listFoldStubs(session) {
  const stubs = []
  for (const nodeSeq of session.surface.nodes) {
    const event = session.eventAt(nodeSeq)
    if (event?.type !== 'tool/result') continue
    const { text } = flattenTextContent(event.data?.message?.content)
    const parsed = parseFoldStub(text)
    if (parsed === undefined) continue
    stubs.push({ nodeSeq, ...parsed })
  }
  return stubs
}

/**
 * 从会话日志里取回某条被折叠的原始 tool/result。
 * 折叠只是新增遮蔽事件，原事件永远在日志里，所以这里**不依赖 spill 文件是否还在**。
 * @param {any} session
 * @param {number} sourceSeq
 * @returns {{ event: any, message: any, text: string } | undefined}
 */
export function recoverOriginal(session, sourceSeq) {
  const event = session.eventAt(sourceSeq)
  if (event?.type !== 'tool/result') return undefined
  const message = session.deriveEventMessage(event)
  const { text } = flattenTextContent(message?.content)
  return { event, message, text }
}

/**
 * 恢复一条折叠项：把替身节点换回原始 tool/result。
 * @param {any} session
 * @param {number} sourceSeq 替身里标注的 #序号
 * @param {object} deps
 * @param {any} deps.ctx
 * @param {any} deps.logger
 * @returns {{ ok: true, chars: number } | { ok: false, reason: string }}
 */
export function unfoldOne(session, sourceSeq, deps) {
  const stub = listFoldStubs(session).find((item) => item.sourceSeq === sourceSeq)
  if (stub === undefined) {
    // 替身不在当前 surface：要么从没折过，要么已被后续压缩摘要吞掉。
    const original = recoverOriginal(session, sourceSeq)
    return { ok: false, reason: original === undefined ? 'source-missing' : 'not-on-surface' }
  }
  const original = recoverOriginal(session, sourceSeq)
  if (original === undefined) return { ok: false, reason: 'source-missing' }

  const stubMessage = session.deriveEventMessage(session.eventAt(stub.nodeSeq))
  const stubPrice = deps.ctx.tokenMeter.estimateMessage(stubMessage)
  try {
    // 与 pruner 同构：先影子计价（被替换区间是替身本身），再同步替换回原文。
    session.append('compaction/prune', {
      shadowedRange: { start: stub.nodeSeq, end: stub.nodeSeq },
      shadowedSeqs: [stub.nodeSeq],
      shadowedTokenCount: stubPrice,
    })
  } catch (error) {
    deps.logger?.debug?.(`session-fold: 恢复时无法记录影子计价：${describeError(error)}`)
  }
  session.append(
    'tool/result',
    { ...original.event.data, message: original.message },
    {
      surfaceOp: { op: 'replace', startSeq: stub.nodeSeq, endSeq: stub.nodeSeq },
      sourceEventSeqs: [stub.nodeSeq],
    },
  )
  return { ok: true, chars: codePointLength(original.text) }
}

/**
 * 恢复当前 surface 上全部折叠项。
 * @param {any} session
 * @param {object} deps
 * @returns {{ restored: number, failed: number }}
 */
export function unfoldAll(session, deps) {
  const stubs = listFoldStubs(session)
  let restored = 0
  let failed = 0
  for (const stub of stubs) {
    const result = unfoldOne(session, stub.sourceSeq, deps)
    if (result.ok === true) restored += 1
    else failed += 1
  }
  return { restored, failed }
}

/**
 * 在所有折叠项的原文里按行搜索（不依赖 spill 文件）。
 * @param {any} session
 * @param {string} pattern 不区分大小写的子串
 * @param {number} limit 最多返回多少条匹配行
 * @returns {{ matches: string[], scanned: number }}
 */
export function searchFoldedOriginals(session, pattern, limit) {
  const needle = pattern.toLowerCase()
  const matches = []
  let scanned = 0
  for (const stub of listFoldStubs(session)) {
    const original = recoverOriginal(session, stub.sourceSeq)
    if (original === undefined) continue
    scanned += 1
    const lines = original.text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= limit) return { matches, scanned }
      if (lines[index].toLowerCase().includes(needle)) {
        matches.push(`#${stub.sourceSeq}:${index + 1}: ${lines[index].slice(0, 200)}`)
      }
    }
  }
  return { matches, scanned }
}

/**
 * 执行一轮折叠。
 *
 * 两阶段：先把要落盘的原文异步写完（spill 是 IO），再同步做 surface 替换
 * —— 因为 `compaction/prune` 必须紧邻它的 replace 事件，中间不能有 await。
 *
 * @param {object} deps
 * @param {any} deps.ctx cordis 上下文（需要 tokenMeter 与 spillStore）
 * @param {object} deps.config 已归一化的配置
 * @param {any} session
 * @param {object} options
 * @param {number} options.turn
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.force] 手动触发：跳过压力与候选数量门槛
 * @returns {Promise<object>}
 */
export async function foldSession({ ctx, config, logger }, session, options) {
  const { turn, signal, force = false } = options
  const empty = { folded: 0, candidates: 0, savedTokens: 0, spilledBytes: 0, busy: false }

  if (hasOpenCompaction(session)) {
    logger?.debug?.('session-fold: 有压缩事务进行中，跳过折叠')
    return { ...empty, busy: true }
  }
  if (signal?.aborted) return empty

  // 自动触发遵守配置的保留窗口；手动 /fold 只保护「仍在进行中的当前轮」，
  // 空闲时则全折（否则短会话里手动命令永远无事可做）。
  const retainTurns = force ? (hasOpenTurn(session) ? 1 : 0) : config.retainTurns
  const candidates = selectFoldCandidates(session, config, turn, retainTurns)
  if (candidates.length === 0) return empty

  if (!force) {
    const threshold = await resolvePressureThreshold(ctx, config, session)
    const pressureTokens = ctx.tokenMeter.measure(session).totalTokens
    const underPressure = pressureTokens >= threshold.tokens
    if (!underPressure && candidates.length < config.minCandidates) {
      return { ...empty, candidates: candidates.length, pressureTokens, thresholdTokens: threshold.tokens }
    }
  }

  const batch = candidates.slice(0, config.maxPerPass)

  // 阶段一：落盘（异步）。任何一条失败只跳过该条，保留原始内联内容。
  const prepared = []
  for (const candidate of batch) {
    if (signal?.aborted) break
    try {
      const ref = await ctx.spillStore.saveText({
        owner: { sessionId: session.id },
        source: {
          kind: 'tool',
          toolName: candidate.toolName,
          callId: candidate.callId,
          label: 'folded-result',
        },
        suggestedName: `${candidate.toolName || 'tool'}-${candidate.seq}.txt`,
        content: candidate.text,
      })
      prepared.push({ candidate, ref })
    } catch (error) {
      logger?.warn?.(`session-fold: 落盘失败，保留原始结果：${describeError(error)}`)
    }
  }

  // 阶段二：同步替换。中途不再 await，保证 prune 事件与 replace 紧邻。
  const liveSurface = new Set(session.surface.nodes)
  let folded = 0
  let savedTokens = 0
  let spilledBytes = 0
  let pruneUnavailable = false

  for (const { candidate, ref } of prepared) {
    // 并发写者（例如压缩）可能已经遮掉了这个节点。
    if (!liveSurface.has(candidate.seq)) continue
    const current = session.eventAt(candidate.seq)
    if (current?.type !== 'tool/result') continue

    const original = session.deriveEventMessage(current)
    if (original?.isError === true) continue

    const stub = renderFoldStub(config, candidate, ref)
    if (stub.length >= candidate.text.length) continue

    const replacement = { ...original, content: [{ type: 'text', text: stub }] }
    const originalTokens = ctx.tokenMeter.estimateMessage(original)
    const replacementTokens = ctx.tokenMeter.estimateMessage(replacement)
    if (replacementTokens >= originalTokens) continue

    if (!pruneUnavailable) {
      try {
        session.append('compaction/prune', {
          shadowedRange: { start: candidate.seq, end: candidate.seq },
          shadowedSeqs: [candidate.seq],
          shadowedTokenCount: originalTokens,
        })
      } catch (error) {
        // 没挂载压缩体系时事件类型未注册：放弃记账，但替换本身仍然合法。
        pruneUnavailable = true
        logger?.debug?.(`session-fold: 无法记录 compaction/prune 影子计价（${describeError(error)}），后续折叠省略该事件`)
      }
    }

    try {
      session.append(
        'tool/result',
        { ...current.data, message: replacement },
        {
          surfaceOp: { op: 'replace', startSeq: candidate.seq, endSeq: candidate.seq },
          sourceEventSeqs: [candidate.seq],
        },
      )
    } catch (error) {
      logger?.warn?.(`session-fold: 替换失败，保留原始结果：${describeError(error)}`)
      continue
    }

    folded += 1
    savedTokens += originalTokens - replacementTokens
    spilledBytes += ref.bytes
  }

  return { folded, candidates: candidates.length, savedTokens, spilledBytes, busy: false }
}

/**
 * 解析压力阈值：能用 llm 解析出模型窗口就按比例，否则退化到绝对阈值。
 * @param {any} ctx
 * @param {object} config
 * @param {any} session
 * @returns {Promise<{ tokens: number, source: 'ratio' | 'absolute', window?: number }>}
 */
export async function resolvePressureThreshold(ctx, config, session) {
  try {
    const header = session.requestHeader?.()
    const provider = header?.config?.provider
    const model = header?.config?.model
    const llm = ctx.get('llm')
    if (llm !== undefined && typeof provider === 'string' && typeof model === 'string') {
      const info = await llm.resolveModelInfo(provider, model)
      const window = info?.context?.contextWindow
      if (Number.isInteger(window) && window > 0) {
        return { tokens: Math.floor(window * config.foldAtRatio), source: 'ratio', window }
      }
    }
  } catch {
    // 路由未就绪、模型未配置等：静默退化到绝对阈值。
  }
  return { tokens: config.foldAtTokens, source: 'absolute' }
}

/** 统一的错误描述，避免把整个对象塞进日志。 */
export function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
