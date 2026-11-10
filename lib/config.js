/**
 * 配置字段元数据与校验（Host 侧）。
 *
 * 浏览器半身读不到这个文件（client 包是手写的自包含 bundle），所以
 * `client.js` 里有一份精简的 label/描述副本；**数值校验只在这里**，
 * 那一份只负责画控件，真正的对错由 Host 的 `validateConfig` 决定。
 *
 * @module dsh-session-fold/lib/config
 */

/** 字段分组：常用参数之外的高级项默认收起。 */
export const CONFIG_GROUPS = {
  basic: { zh: '常用参数', en: 'Common' },
  advanced: { zh: '高级参数', en: 'Advanced' },
}

/** 与 Config schema 的默认值一一对应（见 index.js 的 `Config`）。 */
export const CONFIG_DEFAULTS = {
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
  recallTool: true,
  prune: true,
  pruneRoot: '',
}

/**
 * 字段元数据（顺序即表单顺序）。
 * @type {ReadonlyArray<{
 *   name: keyof typeof CONFIG_DEFAULTS,
 *   group: 'basic' | 'advanced',
 *   type: 'boolean' | 'ratio' | 'integer' | 'string',
 *   formHidden?: boolean,
 *   min?: number,
 *   max?: number,
 *   zh: string,
 *   en: string,
 *   descZh: string,
 *   descEn: string,
 * }>}
 */
export const CONFIG_FIELDS = [
  {
    name: 'auto',
    group: 'basic',
    type: 'boolean',
    zh: '自动折叠',
    en: 'Auto fold',
    descZh: '每次 step 开始前按压力或候选数量自动折叠一次',
    descEn: 'Fold once before each step when pressure or the candidate count reaches the threshold',
  },
  {
    name: 'foldAtRatio',
    group: 'basic',
    type: 'ratio',
    min: 0.01,
    max: 1,
    zh: '触发压力（窗口比例）',
    en: 'Trigger pressure (window ratio)',
    descZh: '上下文估算量达到模型窗口的该比例时折叠；解析不出窗口时改用下面的绝对阈值',
    descEn: 'Fold at this fraction of the model window; falls back to the absolute token threshold',
  },
  {
    name: 'foldThresholdChars',
    group: 'basic',
    type: 'integer',
    min: 1,
    zh: '折叠阈值（字符）',
    en: 'Fold threshold (chars)',
    descZh: '单条工具结果的纯文本超过该字符数才有资格折叠',
    descEn: 'Only tool results whose plain text exceeds this length are foldable',
  },
  {
    name: 'headChars',
    group: 'basic',
    type: 'integer',
    min: 0,
    zh: '保留开头（字符）',
    en: 'Keep head (chars)',
    descZh: '折叠替身保留原文开头的字符数',
    descEn: 'Characters of the original kept at the start of the stub',
  },
  {
    name: 'tailChars',
    group: 'basic',
    type: 'integer',
    min: 0,
    zh: '保留结尾（字符）',
    en: 'Keep tail (chars)',
    descZh: '折叠替身保留原文结尾的字符数',
    descEn: 'Characters of the original kept at the end of the stub',
  },
  {
    name: 'retainTurns',
    group: 'basic',
    type: 'integer',
    min: 0,
    zh: '保护最近轮数',
    en: 'Protect recent turns',
    descZh: '最近 N 轮里的工具结果不折叠',
    descEn: 'Tool results from the most recent N turns stay untouched',
  },
  {
    name: 'minCandidates',
    group: 'basic',
    type: 'integer',
    min: 1,
    zh: '候选累积触发',
    en: 'Candidate batch trigger',
    descZh: '未达压力阈值时，累计多少条候选才触发一次折叠',
    descEn: 'Fold once this many candidates have accumulated below the pressure threshold',
  },
  {
    name: 'foldAtTokens',
    group: 'advanced',
    type: 'integer',
    min: 1,
    zh: '触发压力（token）',
    en: 'Trigger pressure (tokens)',
    descZh: '解析不出模型窗口时使用的绝对阈值',
    descEn: 'Absolute threshold used when the model window cannot be resolved',
  },
  {
    name: 'maxPerPass',
    group: 'advanced',
    type: 'integer',
    min: 1,
    zh: '单次上限',
    en: 'Per-pass cap',
    descZh: '一次折叠最多处理多少条结果',
    descEn: 'Maximum results folded in one pass',
  },
  {
    name: 'command',
    group: 'advanced',
    type: 'boolean',
    zh: '/fold 等命令',
    en: '/fold commands',
    descZh: '注册 /fold、/folds、/unfold 手动命令',
    descEn: 'Register the /fold, /folds and /unfold commands',
  },
  {
    name: 'recallTool',
    group: 'advanced',
    type: 'boolean',
    zh: '取回工具',
    en: 'Recall tool',
    descZh: '给模型注册 session_fold_recall，按 #序号或关键词取回折叠原文',
    descEn: 'Register session_fold_recall so the model can read or search folded originals',
  },
  {
    name: 'prune',
    group: 'advanced',
    type: 'boolean',
    zh: '/spill-prune 命令',
    en: '/spill-prune command',
    descZh: '注册 /spill-prune，手动清理 spill 目录（默认只预览）',
    descEn: 'Register /spill-prune to clean stale spill directories (preview by default)',
  },
  {
    name: 'pruneRoot',
    group: 'advanced',
    type: 'string',
    formHidden: true,
    zh: 'spill 根路径',
    en: 'Spill root',
    descZh: '留空则使用后端 spillStore.root；不在配置页暴露，只能改配置文件',
    descEn: 'Empty means the backend spillStore.root; file-only, deliberately not on the config page',
  },
]

/**
 * 判断是否宿主的 volatile 配置引用（`{ get(), [write] }`）。
 * 标了 `.volatile()` 的字段在运行时就是这个形状，必须 `.get()` 才拿得到值。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && typeof (/** @type {any} */ (value).get) === 'function'
}

/**
 * 读一个字段的当前值：volatile 引用取 `.get()`，普通值原样返回，缺省回落默认。
 * @param {Record<string, unknown>} raw 宿主传入的配置（可能含 volatile 引用）
 * @param {keyof typeof CONFIG_DEFAULTS} name
 * @returns {unknown}
 */
export function readConfigValue(raw, name) {
  const raw_ = raw?.[name]
  if (isVolatileRef(raw_)) return /** @type {any} */ (raw_).get()
  if (raw_ === undefined) return CONFIG_DEFAULTS[name]
  return raw_
}

/**
 * 把宿主配置读成一份生效值快照，再校验。每次调用都重新读取，
 * 因此 volatile 字段被就地更新后立即生效，无需重载插件。
 *
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>} 生效值
 */
export function resolveConfig(raw) {
  const values = {}
  for (const field of CONFIG_FIELDS) values[field.name] = readConfigValue(raw, field.name)
  return validateConfig(values)
}

/**
 * 校验补全后的配置。自相矛盾的预算在加载时就拒绝，而不是等到折叠时才发现。
 *
 * @param {Record<string, unknown>} resolved 已经过 schema 补全的配置
 * @returns {Record<string, unknown>} 同一个对象
 */
export function validateConfig(resolved) {
  if (resolved.retainTurns < 0) throw new TypeError('session-fold: retainTurns 不能为负')
  if (resolved.maxPerPass < 1) throw new TypeError('session-fold: maxPerPass 至少为 1')
  if (resolved.minCandidates < 1) throw new TypeError('session-fold: minCandidates 至少为 1')
  if (resolved.foldAtRatio <= 0 || resolved.foldAtRatio > 1) {
    throw new TypeError('session-fold: foldAtRatio 必须在 (0, 1] 之间')
  }
  if (resolved.foldAtTokens <= 0) throw new TypeError('session-fold: foldAtTokens 必须为正')
  // 折叠后必须严格变小，所以头尾预算加元信息必须小于阈值本身。
  const stubBudget = resolved.headChars + resolved.tailChars + 160
  if (resolved.foldThresholdChars <= stubBudget) {
    throw new TypeError(
      `session-fold: foldThresholdChars（${resolved.foldThresholdChars}）必须大于 ` +
        `headChars + tailChars + 元信息预算（${stubBudget}），否则折叠结果不会变小`,
    )
  }
  return resolved
}

/**
 * 把生效值渲染成多行文本，供 `/fold-config` 展示。
 *
 * volatile 字段的引用对象里读不出「用户是否显式写过」，所以来源标注
 * 只区分「与默认值不同」，不声称来自配置文件。
 *
 * @param {Record<string, unknown>} values 生效值
 * @returns {string}
 */
export function describeConfig(values) {
  const lines = []
  for (const [groupId, group] of Object.entries(CONFIG_GROUPS)) {
    const fields = CONFIG_FIELDS.filter((field) => field.group === groupId)
    if (fields.length === 0) continue
    lines.push(`${group.zh}：`)
    for (const field of fields) {
      const value = values[field.name]
      const shown = field.type === 'boolean' ? (value ? '开' : '关') : value === '' ? '（空）' : String(value)
      const changed = value !== CONFIG_DEFAULTS[field.name]
      lines.push(`  ${field.zh}（${field.name}）= ${shown}${changed ? '  ← 与默认值不同' : ''}`)
    }
  }
  return lines.join('\n')
}
