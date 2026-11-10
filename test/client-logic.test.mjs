/**
 * 浏览器半身的纯逻辑测试（不渲染 React）。
 *
 * `client.js` 在 Node 下（无 window）把纯函数挂到
 * `globalThis.__sessionFoldClientInternals`，这里直接取来测。
 *
 * 重点回归：保存被宿主拒绝那次事故——数字草稿被当成字符串提交，
 * 宿主按 Config schema 校验（`z.number()`）直接拒掉。
 *
 * 运行：node --test test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import '../client.js'

const internals = globalThis.__sessionFoldClientInternals
const { DEFAULTS, FIELDS, toRaw, validateDraft, toOps, pickNamespace } = internals

/** 生效值：默认值即可。 */
const values = { ...DEFAULTS }

/** 取字段元数据。 */
const spec = (name) => FIELDS.find((field) => field.name === name)

test('client.js 在 Node 下暴露纯函数且不在无 window 时注册 loader', () => {
  assert.ok(internals !== undefined)
  assert.equal(internals.FIELDS.length, 12)
  assert.equal(internals.ROW_KEY, 'dsh-session-fold#session-fold')
  assert.equal(typeof globalThis.window, 'undefined')
})

test('数字草稿转换后是 number，不是字符串（保存被拒的回归）', () => {
  const edits = { foldThresholdChars: { kind: 'set', raw: '1200' } }
  const check = validateDraft(values, edits)
  assert.equal(check.ok, true)
  assert.equal(check.values.foldThresholdChars, 1200)
  assert.equal(typeof check.values.foldThresholdChars, 'number')

  const ops = toOps(edits, check.values)
  assert.deepEqual(ops, [{ op: 'set', path: ['foldThresholdChars'], value: 1200 }])
  assert.equal(typeof ops[0].value, 'number', 'op 的 value 必须是 number')
})

test('比例字段按百分数编辑，提交的是 0..1 的小数', () => {
  const edits = { foldAtRatio: { kind: 'set', raw: '25' } }
  const check = validateDraft(values, edits)
  assert.equal(check.ok, true)
  assert.equal(check.values.foldAtRatio, 0.25)
  assert.deepEqual(toOps(edits, check.values), [{ op: 'set', path: ['foldAtRatio'], value: 0.25 }])
})

test('布尔草稿保持布尔', () => {
  const edits = { auto: { kind: 'set', raw: false } }
  const check = validateDraft(values, edits)
  assert.equal(check.ok, true)
  assert.equal(check.values.auto, false)
  assert.deepEqual(toOps(edits, check.values), [{ op: 'set', path: ['auto'], value: false }])
})

test('恢复默认排成 unset op，且不带 value', () => {
  const edits = { headChars: { kind: 'unset' } }
  assert.deepEqual(toOps(edits, values), [{ op: 'unset', path: ['headChars'] }])
})

test('非数字草稿被拦在本地，保存按钮不会放行', () => {
  for (const raw of ['', ' abc', '1,200', '12x']) {
    const check = validateDraft(values, { foldThresholdChars: { kind: 'set', raw } })
    assert.equal(check.ok, false, `raw=${JSON.stringify(raw)} 应该被拒绝`)
    assert.equal(check.field, 'foldThresholdChars')
    assert.match(check.message, /需要一个数字/)
  }
})

test('整数与下限校验', () => {
  const decimal = validateDraft(values, { retainTurns: { kind: 'set', raw: '2.5' } })
  assert.equal(decimal.ok, false)
  assert.match(decimal.message, /需要整数/)

  const negative = validateDraft(values, { headChars: { kind: 'set', raw: '-1' } })
  assert.equal(negative.ok, false)
  assert.match(negative.message, /不能小于 0/)

  const zero = validateDraft(values, { minCandidates: { kind: 'set', raw: '0' } })
  assert.equal(zero.ok, false)
  assert.match(zero.message, /不能小于 1/)
})

test('窗口比例超出 1..100 百分数范围时报错', () => {
  for (const raw of ['0', '-5', '101']) {
    const check = validateDraft(values, { foldAtRatio: { kind: 'set', raw } })
    assert.equal(check.ok, false, `raw=${raw} 应该被拒绝`)
    assert.match(check.message, /1 到 100/)
  }
})

test('跨字段预算：折叠阈值必须大于 头 + 尾 + 160', () => {
  const check = validateDraft(values, { foldThresholdChars: { kind: 'set', raw: '440' } })
  assert.equal(check.ok, false)
  assert.equal(check.field, 'foldThresholdChars')
  assert.match(check.message, /不会变小/)

  const ok = validateDraft(values, { foldThresholdChars: { kind: 'set', raw: '441' } })
  assert.equal(ok.ok, true)
})

test('多字段草稿一次转换成有序 ops', () => {
  const edits = {
    auto: { kind: 'set', raw: false },
    foldAtRatio: { kind: 'set', raw: '50' },
    headChars: { kind: 'unset' },
  }
  const check = validateDraft(values, edits)
  assert.equal(check.ok, true)
  assert.deepEqual(toOps(edits, check.values), [
    { op: 'set', path: ['auto'], value: false },
    { op: 'set', path: ['foldAtRatio'], value: 0.5 },
    { op: 'unset', path: ['headChars'] },
  ])
})

test('toRaw 把生效值还原成控件显示值', () => {
  assert.equal(toRaw(spec('foldAtRatio'), 0.25), '25')
  assert.equal(toRaw(spec('foldThresholdChars'), 800), '800')
  assert.equal(toRaw(spec('auto'), true), true)
})

test('pickNamespace 优先精确候选，其次后缀兜底', () => {
  const snapshot = (names) => ({ view: { namespaces: names.map((ns) => ({ ns })) } })
  assert.equal(pickNamespace(snapshot(['foo', 'session-fold'])), 'session-fold')
  assert.equal(pickNamespace(snapshot(['foo', 'include:session-fold'])), 'include:session-fold')
  assert.equal(pickNamespace(snapshot(['foo', 'my-session-fold'])), 'my-session-fold')
  assert.equal(pickNamespace(snapshot(['foo', 'bar'])), undefined)
  assert.equal(pickNamespace(undefined), undefined)
})
