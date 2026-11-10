/**
 * dsh-session-fold — 会话折叠压缩（Host 半身）。
 *
 * 痛点：长会话里成串的命令执行与输出会在上下文里不断累积。DSH 自带的
 * `dsh-spill-policy` 只在单条结果超过 12500 token 时落盘预览，
 * `dsh-compaction-tool-result-pruner` 只在压缩触发时裁 8k 以上的结果，
 * `dsh-compaction-basic` 则要等到窗口 80% 才花一次 LLM 调用写摘要。
 *
 * 本插件补的是这段空档：在 step 边界用**零 LLM** 的确定性方式，把较早的
 * 超长工具结果折叠成「保留头尾 + 元信息 + 原文路径」的一条短文本，原文
 * 通过宿主 `ctx.spillStore` 落盘，需要细节时模型可直接 read/grep 那个文件。
 *
 * 与现有组件的关系：
 * - 不替换 `dsh-compaction-basic`：它继续作为 80% 压力时的 LLM 摘要兜底；
 *   折叠让上下文提前瘦下来，它自然很少被触发。
 * - 不重复 `dsh-compaction-tool-result-pruner` 的工作：本插件只在较早、较
 *   轻的位置动手，且对富内容（图片/文件块）一律让路。
 * - 遵循 `compaction/prune` 影子计价协议，token 统计与实际可见内容保持一致。
 *
 * @module dsh-session-fold
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describeConfig, resolveConfig } from './lib/config.js'
import {
  applyPrune,
  checkSpillRoot,
  collectSpillDirs,
  parsePruneArgs,
  planPrune,
  readableBytes,
  spillDirNameForSession,
} from './lib/prune.js'
import {
  currentTurnOf,
  describeError,
  foldSession,
  hasOpenCompaction,
  listFoldStubs,
  recoverOriginal,
  searchFoldedOriginals,
  unfoldAll,
  unfoldOne,
} from './lib/fold.js'

export const name = 'session-fold'

/** 需要的服务：缺任一个就不激活（而不是抛错）。 */
export const inject = ['tokenMeter', 'spillStore']

/** 本包名，用于在浏览器模块图里定位自己的半身。 */
const PACKAGE_NAME = 'dsh-session-fold'

const COMMAND_DISABLED = {
  kind: 'error',
  text: '手动命令已在插件配置里关闭（command），可在「插件 → 会话折叠压缩」里打开。',
}

const PRUNE_DISABLED = {
  kind: 'error',
  text: '/spill-prune 已在插件配置里关闭（prune），可在「插件 → 会话折叠压缩」里打开。',
}

/** 模型可调用工具的规范输出声明。 */
const RECALL_OUTPUT = {
  // 注意：defineTool 的 output 走宿主的 ValueSchema DSL，不是裸 JSON Schema ——
  // 字段级用 required: true，不能写顶层 required 数组。
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

export const Config = z.object({
    auto: z.boolean().default(true).volatile()
      .description('自动折叠：在每次 step 开始前按压力或候选数量触发一次'),
    foldAtRatio: z.percent().default(0.25).volatile()
      .description('上下文估算量达到模型窗口的该比例时折叠（无法解析窗口时忽略）'),
    foldAtTokens: z.natural().default(32768).volatile()
      .description('解析不出模型窗口时使用的绝对压力阈值（估算 token）'),
    foldThresholdChars: z.natural().default(800).volatile()
      .description('单条工具结果的纯文本超过该字符数才折叠'),
    headChars: z.natural().default(200).volatile()
      .description('折叠后保留原文开头的字符数'),
    tailChars: z.natural().default(80).volatile()
      .description('折叠后保留原文结尾的字符数'),
    retainTurns: z.natural().default(3).volatile()
      .description('最近 N 轮的工具结果不折叠'),
    minCandidates: z.natural().default(5).volatile()
      .description('未达压力阈值时，累计多少条候选才触发折叠'),
    maxPerPass: z.natural().default(20).volatile()
      .description('单次折叠最多处理多少条'),
    command: z.boolean().default(true).volatile()
      .description('注册 /fold、/folds、/unfold 手动命令'),
    recallTool: z.boolean().default(true).volatile()
      .description('给模型注册 session_fold_recall 工具，按 #序号/关键词取回折叠原文'),
    prune: z.boolean().default(true).volatile()
      .description('注册 /spill-prune 命令，手动清理 spill 目录（默认只预览）'),
    pruneRoot: z.string().default('').volatile()
      .description('spill 根路径；留空则用后端 ctx.spillStore.root'),
})

/**
 * 插件入口。
 * @param {any} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig) {
  const raw = rawConfig ?? {}
  let effective = resolveConfig(raw)
  let complained = false

  /**
   * 读当前生效配置。
   *
   * 所有字段都是 volatile：Loader 在配置变更时**就地改写** `raw`（不重启插件），
   * 所以每次使用前重新解析一遍。若某次写入让配置暂时自相矛盾（例如 UI 先把
   * headChars 调大、再调阈值），沿用上一次可用值并只告警一次。
   *
   * @returns {object}
   */
  const readConfig = () => {
    try {
      effective = resolveConfig(raw)
      complained = false
    } catch (error) {
      if (!complained) {
        complained = true
        ctx.logger.warn(`session-fold: 配置暂不合法，沿用上一次生效值：${describeError(error)}`)
      }
    }
    return effective
  }

  const deps = {
    ctx,
    logger: ctx.logger,
    get config() {
      return readConfig()
    },
  }
  ctx.logger.info(
    `session-fold: 已启用（阈值 ${effective.foldThresholdChars} 字符，保留最近 ${effective.retainTurns} 轮，` +
      `压力 ${effective.foldAtRatio} 窗口 / ${effective.foldAtTokens} token）`,
  )

  // 允许用户从插件配置页实时开关：注册一次，判定放到运行期。
  {
    ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
      if (!readConfig().auto) return next()
      if (!signal.aborted) {
        try {
          const result = await foldSession(deps, agent.session, { turn, signal, force: false })
          if (result.folded > 0) {
            ctx.logger.info(
              `session-fold: 自动折叠 ${result.folded} 条工具结果，约省 ${result.savedTokens} tokens`,
            )
          }
        } catch (error) {
          // 折叠是优化手段，任何失败都不能打断回合。
          ctx.logger.warn(`session-fold: 自动折叠失败，继续回合：${describeError(error)}`)
        }
      }
      return next()
    })
  }

  // 命令一律注册：volatile 开关不重启插件，所以「关掉命令」只能靠运行期判定。
  ctx.inject(['commands'], (ctx) => {
    ctx.commands.register({
      name: 'fold',
      description: 'Fold older tool outputs into spill files (session compaction)',
      handler: async (invocation) => {
        const config = readConfig()
        if (!config.command) return COMMAND_DISABLED
        if (invocation.rawInput.trim().length > 0) {
          return { kind: 'error', text: '用法：/fold（无参数）' }
        }
        try {
          const result = await foldSession(deps, invocation.agent.session, {
            turn: currentTurnOf(invocation.agent.session),
            signal: invocation.signal,
            force: true,
          })
          if (result.busy) {
            return { kind: 'error', text: '当前有压缩事务进行中，稍后再试。' }
          }
          if (result.folded === 0) {
            return { kind: 'success', text: '没有需要折叠的工具输出。' }
          }
          return {
            kind: 'success',
            text:
              `已折叠 ${result.folded} 条工具结果（候选 ${result.candidates} 条），` +
              `约省 ${result.savedTokens} tokens，落盘 ${result.spilledBytes} 字节。`,
          }
        } catch (error) {
          return { kind: 'error', text: `折叠失败：${describeError(error)}` }
        }
      },
    })

    ctx.commands.register({
      name: 'folds',
      description: 'List folded tool results that can be restored with /unfold',
      handler: (invocation) => {
        if (!readConfig().command) return COMMAND_DISABLED
        const stubs = listFoldStubs(invocation.agent.session)
        if (stubs.length === 0) {
          return { kind: 'success', text: '当前没有已折叠的工具结果。' }
        }
        const lines = stubs.map(
          (stub) => `#${stub.sourceSeq}  ${stub.head}  ·  ${stub.stats}  ·  ${stub.locator}`,
        )
        lines.push('', '用 /unfold <序号> 恢复一条，/unfold all 全部恢复。')
        return { kind: 'success', text: lines.join('\n') }
      },
    })

    ctx.commands.register({
      name: 'unfold',
      description: 'Restore folded tool results back into the conversation (append-only, replay-safe)',
      handler: (invocation) => {
        if (!readConfig().command) return COMMAND_DISABLED
        const argument = invocation.rawInput.trim()
        if (argument.length === 0) {
          return { kind: 'error', text: '用法：/unfold <序号>，或 /unfold all（序号见 /folds）' }
        }
        if (hasOpenCompaction(invocation.agent.session)) {
          return { kind: 'error', text: '当前有压缩事务进行中，等它结束再恢复。' }
        }
        try {
          if (argument === 'all') {
            const { restored, failed } = unfoldAll(invocation.agent.session, deps)
            if (restored === 0) {
              return { kind: 'success', text: `没有可恢复的折叠项${failed > 0 ? `（${failed} 条失败）` : ''}。` }
            }
            return {
              kind: 'success',
              text: `已恢复 ${restored} 条折叠项${failed > 0 ? `，${failed} 条失败` : ''}。`,
            }
          }
          const sourceSeq = Number.parseInt(argument, 10)
          if (!Number.isInteger(sourceSeq) || sourceSeq < 0) {
            return { kind: 'error', text: `「${argument}」不是有效序号；序号见 /folds。` }
          }
          const result = unfoldOne(invocation.agent.session, sourceSeq, deps)
          if (result.ok === true) {
            return { kind: 'success', text: `已恢复 #${sourceSeq}（${result.chars} 字符）。` }
          }
          if (result.reason === 'not-on-surface') {
            return {
              kind: 'error',
              text: `#${sourceSeq} 的替身已不在当前会话表面（可能被压缩摘要吞掉了）；原文仍在日志里，可用 session_fold_recall 按序号取回。`,
            }
          }
          return { kind: 'error', text: `没有找到 #${sourceSeq} 对应的原始结果，序号可能不对（用 /folds 查看）。` }
        } catch (error) {
          return { kind: 'error', text: `恢复失败：${describeError(error)}` }
        }
      },
    })

    ctx.commands.register({
      name: 'fold-config',
      description: 'Show the effective session-fold configuration and where each value comes from',
      handler: () => {
        const config = readConfig()
        return {
          kind: 'success',
          text: [
            '生效配置：',
            describeConfig(config),
            '',
            '在「插件 → 会话折叠压缩」的配置页改这些值，或写 profile 的 cordis.patch.yml；两者都即时生效。',
          ].join('\n'),
        }
      },
    })

    ctx.commands.register({
      name: 'spill-prune',
      description: 'Preview (default) or delete stale spill directories; archived sessions count as live',
      handler: async (invocation) => {
        const config = readConfig()
        if (!config.prune) return PRUNE_DISABLED
        const args = parsePruneArgs(invocation.rawInput)
        if (args.error !== undefined) return { kind: 'error', text: args.error }

        // 根优先取后端真实生效值：LocalSpillStore 把解析后的路径挂在实例上。
        const backendRoot = ctx.get('spillStore')?.root
        const chosenRoot = checkSpillRoot(config.pruneRoot !== '' ? config.pruneRoot : backendRoot)
        if (chosenRoot.ok !== true) return { kind: 'error', text: chosenRoot.reason }
        const root = chosenRoot.root

        const query = ctx.get('sessionQuery')
        if (query?.listSessions === undefined) {
          return { kind: 'error', text: '拿不到会话索引（sessionQuery 未就绪），为避免误删全部目录，已放弃。' }
        }
        let sessions
        try {
          sessions = await query.listSessions(invocation.signal)
        } catch (error) {
          return { kind: 'error', text: `读取会话索引失败：${describeError(error)}` }
        }
        if (sessions.length === 0) {
          return { kind: 'error', text: '会话索引返回 0 条，拒绝清理（否则会把所有目录当成孤儿）。' }
        }

        const liveNames = new Set(sessions.map((record) => spillDirNameForSession(record.header.id)))
        // 当前会话一定保护，即使它还没落进索引。
        liveNames.add(spillDirNameForSession(invocation.agent.session.id))

        const dirs = await collectSpillDirs(root)
        const plan = planPrune({
          dirs,
          liveNames,
          all: args.all,
          olderThanDays: args.olderThanDays,
          now: Date.now(),
        })

        const totalBytes = dirs.reduce((sum, dir) => sum + dir.bytes, 0)
        const head = [
          `spill 根：${root}`,
          `会话索引：${sessions.length} 个（含归档，归档算存活）`,
          `目录：${dirs.length} 个，共 ${readableBytes(totalBytes)}`,
        ]

        const listLines = (list) =>
          list.slice(0, 20).map((dir) => `  ${dir.name}  ${readableBytes(dir.bytes)}  (${dir.files} 个文件)`)

        const tail = []
        if (plan.symlinkSkipped.length > 0) {
          tail.push('', `软链接已跳过 ${plan.symlinkSkipped.length} 个：`, ...listLines(plan.symlinkSkipped))
        }

        if (plan.targets.length === 0) {
          return {
            kind: 'success',
            text: [...head, '本次无可清理目录。'].join('\n'),
          }
        }

        if (args.apply !== true) {
          return {
            kind: 'success',
            text: [
              ...head,
              `可删除 ${plan.targets.length} 个，共 ${readableBytes(
                plan.targets.reduce((sum, dir) => sum + dir.bytes, 0),
              )}：`,
              ...listLines(plan.targets),
              '',
              '这是预览。真正删除请加 --apply。',
              ...tail,
            ].join('\n'),
          }
        }

        const applied = await applyPrune(plan.targets)
        const report = [
          ...head,
          `已删除 ${applied.deleted} 个目录，回收 ${readableBytes(applied.bytes)}。`,
        ]
        if (applied.errors.length > 0) {
          report.push('', ...applied.errors.slice(0, 10))
        }
        return { kind: applied.errors.length === 0 ? 'success' : 'error', text: [...report, ...tail].join('\n') }
      },
    })
  })

  ctx.inject(['tools'], (ctx) => {
    ctx.tools.register(
      defineTool({
        name: 'session_fold_diagnose',
        description:
          'Diagnose the session-fold config page: report the effective config, whether the Host serves a ' +
          'settings form for this plugin, and whether the browser half is composed into the Web module graph.',
        parameters: {},
        output: RECALL_OUTPUT,
        execute() {
          const lines = ['生效配置：', describeConfig(readConfig())]

          const settings = ctx.get('settings')
          if (settings?.describe === undefined) {
            lines.push('', '表单服务（settings）：未挂载')
          } else {
            try {
              const descriptors = settings.describe()
              const mine = descriptors.filter((entry) => String(entry.ns ?? '').includes('session-fold'))
              lines.push(
                '',
                `表单服务（settings）：profile 可写=${settings.writable === true}，命名空间 ${descriptors.length} 个`,
                mine.length === 0
                  ? '  ├ 没有 session-fold 命名空间：配置页拿不到表单'
                  : `  ├ ${mine
                      .map((entry) => `${entry.ns}（revision ${entry.revision}，autoGenerate=${entry.autoGenerate}）`)
                      .join('、')}`,
              )
            } catch (error) {
              lines.push('', `表单服务（settings）：读取失败 — ${describeError(error)}`)
            }
          }

          const modules = ctx.get('clientModules')
          if (modules?.graph === undefined) {
            lines.push('', '浏览器模块图（clientModules）：未挂载')
          } else {
            try {
              const graph = modules.graph()
              const mine = graph.entries.find((entry) => entry.id === PACKAGE_NAME)
              lines.push(
                '',
                `浏览器模块图：共 ${graph.entries.length} 项`,
                mine === undefined
                  ? `  ├ ${PACKAGE_NAME} 不在图里：浏览器半身没有组成（检查 package.json 的 dsh.client 与 loader 行）`
                  : `  ├ ${mine.id} rev=${mine.rev} inject=${JSON.stringify(mine.inject ?? [])}`,
              )
            } catch (error) {
              lines.push('', `浏览器模块图读取失败 — ${describeError(error)}`)
            }
          }

          return { text: lines.join('\n') }
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'session_fold_recall',
        description:
          'Read or search the full original text of tool results folded by session-fold. ' +
          'Folded stubs carry a #序号 (original event seq); pass seq to read that entry, ' +
          'or pattern to grep line-by-line across every folded original. ' +
          'Works even when the spill file was cleaned up, because originals stay in the session log.',
        parameters: {
          seq: {
            type: 'number',
            description: 'The #序号 shown in a folded stub. Omit to list all folded entries.',
          },
          pattern: {
            type: 'string',
            description: 'Case-insensitive substring searched line-by-line across all folded originals.',
          },
          max_chars: {
            type: 'number',
            description: 'Max characters returned when reading one entry (default 6000).',
          },
        },
        output: RECALL_OUTPUT,
        execute(args, exec) {
          if (!readConfig().recallTool) {
            return { text: '取回工具已在插件配置里关闭（recallTool），需要时可在插件配置页打开。' }
          }
          const session = exec.agent?.session
          if (session === undefined) return { text: '没有可用的会话。' }

          if (args.seq !== undefined) {
            const original = recoverOriginal(session, args.seq)
            if (original === undefined) {
              return { text: `#${args.seq} 没有对应的原始工具结果；序号见折叠替身里的 # 或 /folds。` }
            }
            const limit = args.max_chars ?? 6000
            const truncated = original.text.length > limit
            const body = truncated ? original.text.slice(0, limit) : original.text
            const onSurface = listFoldStubs(session).some((stub) => stub.sourceSeq === args.seq)
            const notices = []
            if (!onSurface) {
              notices.push(`（#${args.seq} 的替身已不在当前表面，可能被压缩摘要吞掉；下面是日志里的原文。）`)
            }
            if (truncated) notices.push(`（原文 ${original.text.length} 字符，已截断到前 ${limit} 字符）`)
            return { text: [...notices, body].join('\n') }
          }

          const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
          if (pattern.length > 0) {
            const { matches, scanned } = searchFoldedOriginals(session, pattern, 50)
            if (matches.length === 0) {
              return { text: `在 ${scanned} 条折叠原文里没有匹配「${pattern}」的行。` }
            }
            return { text: matches.join('\n') }
          }

          const stubs = listFoldStubs(session)
          if (stubs.length === 0) return { text: '当前没有已折叠的工具结果。' }
          return {
            text: stubs.map((stub) => `#${stub.sourceSeq}  ${stub.head}  ·  ${stub.stats}  ·  ${stub.locator}`).join('\n'),
          }
        },
      }),
    )
  })

  // 本插件自带配置页，关掉宿主的自动生成页，避免将来出现两个入口。
  ctx.inject(['settings'], (ctx) => {
    ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'session-fold: settings page policy')
  })
}
