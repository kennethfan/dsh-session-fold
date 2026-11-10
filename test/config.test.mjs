/**
 * 配置模块测试：默认值、volatile 读取、校验规则、/fold-config 的输出形态。
 *
 * 只碰 lib/config.js，不 import index.js（后者依赖宿主的 schemastery / dsh-tools）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  describeConfig,
  isVolatileRef,
  readConfigValue,
  resolveConfig,
  validateConfig,
} from '../lib/config.js'

/** 以默认值为底，叠加覆盖项。 */
function withDefaults(overrides = {}) {
  return { ...CONFIG_DEFAULTS, ...overrides }
}

/** 模拟宿主的 volatile 引用：{ get(), [write] } 的冻结对象。 */
function volatileRef(value) {
  let current = value
  return Object.freeze({
    get: () => current,
    write(next) {
      current = next
    },
  })
}

test('字段元数据与默认值一一对应', () => {
  const names = CONFIG_FIELDS.map((field) => field.name)
  assert.equal(names.length, 13)
  assert.deepEqual([...names].sort(), [...Object.keys(CONFIG_DEFAULTS)].sort())
  for (const field of CONFIG_FIELDS) {
    assert.ok(Object.hasOwn(CONFIG_GROUPS, field.group), `${field.name} 的分组未知`)
    assert.ok(field.zh.length > 0)
    assert.ok(field.descZh.length > 0)
  }
  const basic = CONFIG_FIELDS.filter((field) => field.group === 'basic').length
  assert.equal(basic, 7)
  assert.equal(CONFIG_FIELDS.length - basic, 6)
})

test('只有 pruneRoot 不进配置页', () => {
  const hidden = CONFIG_FIELDS.filter((field) => field.formHidden === true)
  assert.deepEqual(hidden.map((field) => field.name), ['pruneRoot'])
  // 配置页可见字段：常用 7 + 高级 5
  const visible = CONFIG_FIELDS.filter((field) => field.formHidden !== true)
  assert.equal(visible.length, 12)
  assert.equal(visible.filter((field) => field.group === 'basic').length, 7)
  assert.equal(visible.filter((field) => field.group === 'advanced').length, 5)
})

test('resolveConfig：空配置回落默认值', () => {
  assert.deepEqual(resolveConfig({}), withDefaults())
})

test('resolveConfig：普通值与 volatile 引用都能读', () => {
  const plain = resolveConfig({ foldThresholdChars: 1200 })
  assert.equal(plain.foldThresholdChars, 1200)

  const refs = {
    auto: volatileRef(false),
    foldAtRatio: volatileRef(0.5),
    foldThresholdChars: volatileRef(1200),
    retainTurns: volatileRef(5),
  }
  const live = resolveConfig(refs)
  assert.equal(live.auto, false)
  assert.equal(live.foldAtRatio, 0.5)
  assert.equal(live.foldThresholdChars, 1200)
  assert.equal(live.retainTurns, 5)
  // 未出现在 raw 里的字段仍取默认值
  assert.equal(live.headChars, 200)
})

test('volatile 引用被就地更新后，下一次 resolveConfig 立刻读到新值', () => {
  const auto = volatileRef(true)
  const raw = { auto }
  assert.equal(resolveConfig(raw).auto, true)

  auto.write(false) // 宿主 updateVolatile 等价于 reference[write](newValue)
  assert.equal(resolveConfig(raw).auto, false)
})

test('isVolatileRef 只认带 get 的对象', () => {
  assert.equal(isVolatileRef(volatileRef(1)), true)
  assert.equal(isVolatileRef(1), false)
  assert.equal(isVolatileRef('x'), false)
  assert.equal(isVolatileRef(null), false)
  assert.equal(isVolatileRef({ get: 1 }), false)
})

test('readConfigValue：缺省字段回落默认，空字符串不被当成缺省', () => {
  assert.equal(readConfigValue({}, 'headChars'), 200)
  assert.equal(readConfigValue({ pruneRoot: '' }, 'pruneRoot'), '')
  assert.equal(readConfigValue({ headChars: volatileRef(50) }, 'headChars'), 50)
})

test('拒绝自相矛盾的预算', () => {
  assert.throws(
    () => validateConfig(withDefaults({ foldThresholdChars: 400, headChars: 200, tailChars: 80 })),
    /foldThresholdChars/,
  )
  // 恰好等于预算（200 + 80 + 160 = 440）也要拒绝：折叠结果不会变小
  assert.throws(() => validateConfig(withDefaults({ foldThresholdChars: 440 })), /foldThresholdChars/)
  assert.ok(validateConfig(withDefaults({ foldThresholdChars: 441 })))
})

test('拒绝越界参数', () => {
  assert.throws(() => validateConfig(withDefaults({ foldAtRatio: 0 })), /foldAtRatio/)
  assert.throws(() => validateConfig(withDefaults({ foldAtRatio: 1.5 })), /foldAtRatio/)
  assert.throws(() => validateConfig(withDefaults({ foldAtTokens: 0 })), /foldAtTokens/)
  assert.throws(() => validateConfig(withDefaults({ maxPerPass: 0 })), /maxPerPass/)
  assert.throws(() => validateConfig(withDefaults({ minCandidates: 0 })), /minCandidates/)
  assert.throws(() => validateConfig(withDefaults({ retainTurns: -1 })), /retainTurns/)
  // 边界值本身合法
  assert.equal(validateConfig(withDefaults({ foldAtRatio: 1 })).foldAtRatio, 1)
  assert.equal(validateConfig(withDefaults({ retainTurns: 0 })).retainTurns, 0)
})

test('describeConfig 按分组列出全部字段并标注偏离默认的项', () => {
  const values = withDefaults({ foldThresholdChars: 1200, auto: false })
  const text = describeConfig(values)
  const lines = text.split('\n')

  assert.equal(lines.length, 2 + CONFIG_FIELDS.length)
  assert.ok(text.includes('常用参数：'))
  assert.ok(text.includes('高级参数：'))
  assert.ok(text.includes('折叠阈值（字符）（foldThresholdChars）= 1200  ← 与默认值不同'))
  assert.ok(text.includes('自动折叠（auto）= 关  ← 与默认值不同'))
  // 默认值不标注
  assert.ok(text.includes('保护最近轮数（retainTurns）= 3\n'))
})

test('describeConfig 把空字符串与布尔值渲染成人话', () => {
  const text = describeConfig(withDefaults())
  assert.ok(text.includes('spill 根路径（pruneRoot）= （空）'))
  assert.ok(text.includes('取回工具（recallTool）= 开'))
  assert.ok(text.includes('单次上限（maxPerPass）= 20'))
})
