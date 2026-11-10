/**
 * dsh-session-fold — 浏览器半身。
 *
 * 手写 ModuleLoader bundle：无构建步骤，只依赖 shell 已提供的 react。
 * 向插件页的 `plugins.row.config` 槽位与设置侧栏的 `settings.section`
 * 注册同一份配置页，让用户不必手改 cordis.patch.yml。
 *
 * 交互契约：**改一下不落盘**。所有控件只写本地草稿，「保存」才把整批改动
 * 一次性交给宿主（`settings.mutate` 有序 ops，原子、带 revision）；「放弃修改」
 * 清空草稿；「恢复全部默认值」把有覆盖的字段排成 unset 草稿。
 *
 * 两条硬约束，都踩过坑：
 * 1. 交给宿主的 `set` op **必须是 schema 类型**——数字字段要给 number。给
 *    `"1200"` 这种字符串会被宿主按 Config schema 拒掉，页面只看到「保存被拒绝」。
 *    所以 ops 一律取本地校验转换后的值，而不是输入框原文。
 * 2. 校验/换算写成文件顶层的纯函数，Node 下（无 window）走
 *    `globalThis.__sessionFoldClientInternals` 暴露，供 `test/client-logic.test.mjs`
 *    回归测试；浏览器下才走 `window.__ModuleLoader__.load` 注册组件。
 *
 * 颜色全部取自主题变量，明暗主题切换无需额外处理。
 */

/** 本插件行的 key（`<包名>#<行 id>`）。 */
const ROW_KEY = 'dsh-session-fold#session-fold'
/** 表单命名空间候选：Loader 行 id 与 include 组内的 entry id 都可能出现。 */
const NS_CANDIDATES = ['session-fold', 'include:session-fold']

/** 折叠替身的元信息预算（与 lib/config.js 的校验保持一致）。 */
const STUB_OVERHEAD = 160

/**
 * 字段清单（与 lib/config.js 保持一致的顺序与语义；这里多带控件提示）。
 * 浏览器包里不能 import './lib/config.js'——bundle 是自包含的。
 * pruneRoot 故意不在清单里：把 /spill-prune 指错目录有风险，只允许改配置文件。
 */
const DEFAULTS = {
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

const FIELDS = [
  { name: 'auto', group: 'basic', type: 'boolean', zh: '自动折叠', desc: '每次 step 开始前按压力或候选数量自动折叠一次' },
  { name: 'foldAtRatio', group: 'basic', type: 'ratio', zh: '触发压力（窗口比例）', desc: '上下文估算量达到模型窗口的这个比例时折叠；解析不出窗口时改用绝对 token 阈值' },
  { name: 'foldThresholdChars', group: 'basic', type: 'integer', min: 1, zh: '折叠阈值（字符）', desc: '单条工具结果的纯文本超过该字符数才有资格折叠' },
  { name: 'headChars', group: 'basic', type: 'integer', min: 0, zh: '保留开头（字符）', desc: '折叠替身保留原文开头的字符数' },
  { name: 'tailChars', group: 'basic', type: 'integer', min: 0, zh: '保留结尾（字符）', desc: '折叠替身保留原文结尾的字符数' },
  { name: 'retainTurns', group: 'basic', type: 'integer', min: 0, zh: '保护最近轮数', desc: '最近 N 轮里的工具结果不折叠' },
  { name: 'minCandidates', group: 'basic', type: 'integer', min: 1, zh: '候选累积触发', desc: '未达压力阈值时，累计多少条候选才触发一次折叠' },
  { name: 'foldAtTokens', group: 'advanced', type: 'integer', min: 1, zh: '触发压力（token）', desc: '解析不出模型窗口时使用的绝对阈值' },
  { name: 'maxPerPass', group: 'advanced', type: 'integer', min: 1, zh: '单次上限', desc: '一次折叠最多处理多少条结果' },
  { name: 'command', group: 'advanced', type: 'boolean', zh: '/fold 等命令', desc: '注册 /fold、/folds、/unfold 手动命令' },
  { name: 'recallTool', group: 'advanced', type: 'boolean', zh: '取回工具', desc: '给模型注册 session_fold_recall，按 #序号或关键词取回折叠原文' },
  { name: 'prune', group: 'advanced', type: 'boolean', zh: '/spill-prune 命令', desc: '注册 /spill-prune，手动清理 spill 目录（默认只预览）' },
]

const CSS = `
.sf-wrap { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 8px; }
.sf-note { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #999); }
.sf-bad { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.sf-ok { color: var(--dsw-alias-state-success-primary, #3fb950); }
.sf-group { display: flex; flex-direction: column; gap: 2px; }
.sf-ghead { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 0; background: none; border: none; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; font-weight: 600; text-align: left; cursor: pointer; }
.sf-ghead-static { cursor: default; }
.sf-caret { width: 10px; font-size: 10px; color: var(--dsw-alias-label-tertiary, #777); }
.sf-row { display: flex; align-items: flex-start; gap: 12px; padding: 8px 10px; border-radius: 8px; }
.sf-row:hover { background: var(--dsw-alias-bg-layer-2, #26272c); }
.sf-row-dirty { box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary, #4f8cff); }
.sf-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sf-label { font-size: 12.5px; color: var(--dsw-alias-label-primary, #e6e6e6); }
.sf-desc { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #777); }
.sf-ctl { flex: none; display: flex; align-items: center; gap: 6px; padding-top: 1px; }
.sf-input { width: 96px; box-sizing: border-box; background: var(--dsw-alias-bg-base, #16171b); color: inherit; border: 1px solid var(--dsw-alias-border-l1, #33343a); border-radius: 6px; padding: 4px 7px; font-size: 12px; outline: none; font-variant-numeric: tabular-nums; }
.sf-input:focus { border-color: var(--dsw-alias-brand-primary, #4f8cff); }
.sf-input-invalid { border-color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.sf-check { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary, #4f8cff); cursor: pointer; }
.sf-unit { font-size: 11px; color: var(--dsw-alias-label-tertiary, #777); }
.sf-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; color: var(--dsw-alias-label-secondary, #999); border: 1px solid var(--dsw-alias-border-l1, #33343a); }
.sf-tag-dirty { color: var(--dsw-alias-brand-primary, #4f8cff); border-color: var(--dsw-alias-brand-primary, #4f8cff); }
.sf-footer { position: sticky; bottom: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 0 4px; background: var(--dsw-alias-bg-base, #16171b); }
.sf-primary { background: var(--dsw-alias-brand-primary, #4f8cff); color: #fff; border: 1px solid transparent; border-radius: 7px; cursor: pointer; font-size: 12.5px; font-weight: 600; padding: 6px 16px; }
.sf-primary:disabled { opacity: 0.5; cursor: default; }
.sf-btn { background: var(--dsw-alias-bg-layer-2, #26272c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #33343a); border-radius: 7px; cursor: pointer; font-size: 12px; padding: 5px 11px; }
.sf-btn:disabled { opacity: 0.55; cursor: default; }
.sf-spacer { flex: 1; }
`

/** 从 describe 快照里找出本插件的表单命名空间。 */
function pickNamespace(snapshot) {
  const namespaces = snapshot?.view?.namespaces ?? []
  for (const candidate of NS_CANDIDATES) {
    if (namespaces.some((entry) => entry.ns === candidate)) return candidate
  }
  return namespaces.find((entry) => entry.ns.endsWith('session-fold'))?.ns
}

/** 把字段当前值转成草稿里的原始文本/布尔值（ratio 按百分数显示）。 */
function toRaw(spec, value) {
  if (spec.type === 'boolean') return Boolean(value)
  if (spec.type === 'ratio') return String(Math.round(Number(value) * 100))
  if (spec.type === 'integer') return String(Number(value))
  return String(value ?? '')
}

/**
 * 校验草稿：先转换类型与范围，再检查跨字段预算。
 * 与 Host 侧 `validateConfig` 同口径，但更早一步给出人话提示。
 *
 * @param {Record<string, any>} values 当前生效值
 * @param {Record<string, any>} edits 草稿 { [name]: { kind: 'set', raw } | { kind: 'unset' } }
 * @returns {{ ok: true, values: object } | { ok: false, field?: string, message: string }}
 */
function validateDraft(values, edits) {
  const candidate = { ...values }
  for (const spec of FIELDS) {
    const edit = edits[spec.name]
    if (edit === undefined) continue
    const raw = edit.kind === 'unset' ? toRaw(spec, DEFAULTS[spec.name]) : edit.raw

    if (spec.type === 'boolean') {
      candidate[spec.name] = Boolean(raw)
      continue
    }
    if (spec.type === 'string') {
      candidate[spec.name] = String(raw)
      continue
    }
    const text = String(raw).trim()
    if (text === '' || !/^-?\d+(\.\d+)?$/.test(text)) {
      return { ok: false, field: spec.name, message: `${spec.zh} 需要一个数字` }
    }
    const parsed = Number(text)
    if (spec.type === 'integer') {
      if (!Number.isInteger(parsed)) {
        return { ok: false, field: spec.name, message: `${spec.zh} 需要整数` }
      }
      if (spec.min !== undefined && parsed < spec.min) {
        return { ok: false, field: spec.name, message: `${spec.zh} 不能小于 ${spec.min}` }
      }
      candidate[spec.name] = parsed
      continue
    }
    if (parsed <= 0 || parsed > 100) {
      return { ok: false, field: spec.name, message: `${spec.zh} 需要在 1 到 100 之间` }
    }
    candidate[spec.name] = parsed / 100
  }

  const budget = candidate.headChars + candidate.tailChars + STUB_OVERHEAD
  if (candidate.foldThresholdChars <= budget) {
    return {
      ok: false,
      field: 'foldThresholdChars',
      message: `折叠阈值必须大于 保留开头 + 保留结尾 + ${STUB_OVERHEAD}（当前合计 ${budget}），否则折叠不会变小`,
    }
  }
  return { ok: true, values: candidate }
}

/**
 * 把草稿转换成宿主的 mutation ops。
 *
 * **值必须取转换后的类型**（`candidate[name]`）：数字字段传输入框原文
 * （`"1200"`）会被宿主按 Config schema 拒绝，页面只看到「保存被拒绝」。
 *
 * @param {Record<string, any>} edits 草稿
 * @param {Record<string, any>} candidate validateDraft 产出的类型化配置
 */
function toOps(edits, candidate) {
  return Object.entries(edits).map(([name, edit]) =>
    edit.kind === 'unset'
      ? { op: 'unset', path: [name] }
      : { op: 'set', path: [name], value: candidate[name] },
  )
}

/** Node 下列出纯函数供回归测试；浏览器下由 ModuleLoader 装载组件。 */
const internals = {
  ROW_KEY,
  NS_CANDIDATES,
  STUB_OVERHEAD,
  DEFAULTS,
  FIELDS,
  pickNamespace,
  toRaw,
  validateDraft,
  toOps,
}

if (typeof window === 'undefined' || typeof window.__ModuleLoader__?.load !== 'function') {
  globalThis.__sessionFoldClientInternals = internals
} else {
  window.__ModuleLoader__.load({
    id: 'dsh-session-fold',
    factory: require => {
      const module = { exports: {} }
      const exports = module.exports
      const React = require('react')
      const { createElement: h, useState, useEffect } = React

      // 只把 slots 作为硬依赖；configForms 用可选 inject 挂载，
      // 这样即使宿主没提供表单服务，配置页仍会注册并给出提示，而不是静默不激活。
      const inject = ['slots']

      function tag(text, dirty) {
        return h('span', { className: dirty ? 'sf-tag sf-tag-dirty' : 'sf-tag' }, text)
      }

      /** 数字输入：草稿存字符串，保存时才转换，因此允许输入中间态。 */
      function NumberInput({ raw, disabled, invalid, onStage }) {
        return h('input', {
          className: invalid ? 'sf-input sf-input-invalid' : 'sf-input',
          type: 'text',
          inputMode: 'numeric',
          value: raw,
          disabled,
          onChange: (event) => onStage(event.target.value),
        })
      }

      /** 文本输入（当前清单里没有 string 字段，保留扩展位）。 */
      function TextInput({ raw, disabled, onStage }) {
        return h('input', {
          className: 'sf-input',
          style: { width: '220px' },
          type: 'text',
          value: raw,
          disabled,
          onChange: (event) => onStage(event.target.value),
        })
      }

      /** 配置页主体：渲染时自己解析命名空间与表单控制器，不依赖外层时机。 */
      function ConfigPage({ ctx }) {
        const mirror = ctx.configForms.describe()
        const [mirrorSnapshot, setMirrorSnapshot] = useState(() => mirror.getSnapshot())
        useEffect(() => {
          mirror.ensure()
          const unsubscribe = mirror.subscribe(() => setMirrorSnapshot(mirror.getSnapshot()))
          setMirrorSnapshot(mirror.getSnapshot())
          return unsubscribe
        }, [mirror])

        const namespace = pickNamespace(mirrorSnapshot)
        const form = namespace === undefined ? undefined : ctx.configForms.get(namespace)
        const [snapshot, setSnapshot] = useState(() => (form === undefined ? undefined : form.getSnapshot()))
        /** 未保存的草稿：{ [name]: { kind: 'set', raw } | { kind: 'unset' } }。 */
        const [edits, setEdits] = useState({})
        const [note, setNote] = useState(undefined)
        const [busy, setBusy] = useState(false)
        const [showAdvanced, setShowAdvanced] = useState(false)

        useEffect(() => {
          if (form === undefined) {
            setSnapshot(undefined)
            return undefined
          }
          setSnapshot(form.getSnapshot())
          return form.subscribe(() => setSnapshot(form.getSnapshot()))
        }, [form])

        if (form === undefined || snapshot === undefined) {
          const served = (mirrorSnapshot?.view?.namespaces ?? []).map((entry) => entry.ns)
          return h(
            'div',
            { className: 'sf-wrap' },
            h('div', { className: 'sf-note sf-bad' },
              '没有找到 session-fold 的配置表单：插件未启用，或本 profile 不支持表单编辑。'),
            h('div', { className: 'sf-note' },
              served.length > 0 ? `当前可编辑的命名空间：${served.join('、')}` : '当前没有任何可编辑的命名空间。'),
          )
        }

        const values = { ...DEFAULTS, ...(snapshot.value ?? {}) }
        const overrides = snapshot.user ?? {}
        const disabled = busy || snapshot.writable === false
        const editCount = Object.keys(edits).length
        const validation = editCount === 0 ? { ok: true } : validateDraft(values, edits)

        const stage = (name, raw) => {
          setNote(undefined)
          const spec = FIELDS.find((field) => field.name === name)
          const base = toRaw(spec, values[name])
          setEdits((current) => {
            const next = { ...current }
            if (String(raw) === String(base)) delete next[name]
            else next[name] = { kind: 'set', raw }
            return next
          })
        }

        const discard = () => {
          setEdits({})
          setNote(undefined)
        }

        const resetAll = () => {
          setNote(undefined)
          const next = {}
          for (const spec of FIELDS) {
            if (overrides[spec.name] !== undefined) next[spec.name] = { kind: 'unset' }
          }
          setEdits(next)
          if (Object.keys(next).length === 0) {
            setNote({ tone: 'ok', text: '所有字段都已经是默认值，无需恢复。' })
          }
        }

        const save = async () => {
          const check = validateDraft(values, edits)
          if (check.ok !== true) {
            setNote({ tone: 'bad', text: `未保存：${check.message}` })
            return
          }
          const revisionBefore = snapshot.revision
          setBusy(true)
          const accepted = await form.mutate(toOps(edits, check.values))
          setBusy(false)
          if (accepted) {
            setEdits({})
            setNote({ tone: 'ok', text: `已保存 ${editCount} 项改动` })
            return
          }
          const revisionAfter = form.getSnapshot()?.revision
          setNote(
            revisionBefore !== revisionAfter
              ? { tone: 'bad', text: '保存被拒绝：配置在别处刚被改过（revision 冲突），请放弃草稿后重试。' }
              : { tone: 'bad', text: '保存被拒绝：宿主按 Config schema 校验未通过，请检查取值类型与范围。' },
          )
        }

        const renderField = (spec) => {
          const edit = edits[spec.name]
          const dirty = edit !== undefined
          const raw = edit === undefined
            ? toRaw(spec, values[spec.name])
            : (edit.kind === 'unset' ? toRaw(spec, DEFAULTS[spec.name]) : edit.raw)
          const invalid = dirty && validation.ok === false && validation.field === spec.name
          // 宿主写回会把整张 volatile 表单都钉进 patch，所以「是否写过」不代表「是否偏离默认」。
          // 只有真正与默认值不同才标「已自定义」，否则一保存就整页蓝标签。
          const pinned = overrides[spec.name] !== undefined
          const deviates = String(toRaw(spec, values[spec.name])) !== String(toRaw(spec, DEFAULTS[spec.name]))

          let control
          if (spec.type === 'boolean') {
            control = h('input', {
              type: 'checkbox',
              className: 'sf-check',
              checked: Boolean(raw),
              disabled,
              onChange: (event) => stage(spec.name, event.target.checked),
            })
          } else if (spec.type === 'string') {
            control = h(TextInput, { raw, disabled, onStage: (next) => stage(spec.name, next) })
          } else {
            control = [
              h(NumberInput, { raw, disabled, invalid, onStage: (next) => stage(spec.name, next) }),
              spec.type === 'ratio' ? h('span', { className: 'sf-unit' }, '%') : null,
            ]
          }

          return h(
            'div',
            { className: dirty ? 'sf-row sf-row-dirty' : 'sf-row', key: spec.name },
            h(
              'div',
              { className: 'sf-text' },
              h('span', { className: 'sf-label' },
                spec.zh,
                dirty ? tag('未保存', true) : (pinned && deviates ? tag('已自定义', false) : null)),
              h('span', { className: 'sf-desc' }, spec.desc),
            ),
            h('div', { className: 'sf-ctl' }, control),
          )
        }

        const basic = FIELDS.filter((spec) => spec.group === 'basic')
        const advanced = FIELDS.filter((spec) => spec.group === 'advanced')

        return h(
          'div',
          { className: 'sf-wrap' },
          h('div', { className: 'sf-note' },
            '改动先留在本地草稿，点「保存」才写入 profile 的 Cordis patch，保存成功后才影响运行中的插件。'),
          snapshot.status === 'loading'
            ? h('div', { className: 'sf-note' }, '正在读取配置…')
            : null,
          snapshot.status === 'unavailable'
            ? h('div', { className: 'sf-note sf-bad' },
                '宿主没有为 session-fold 提供配置表单：请确认插件已启用，且 profile 支持表单编辑。')
            : null,
          snapshot.writable === false
            ? h('div', { className: 'sf-note sf-bad' },
                '当前 profile 不接受表单写入（可能由 home patch 或命令行覆盖），只能改配置文件。')
            : null,
          h('div', { className: 'sf-group' },
            h('div', { className: 'sf-ghead sf-ghead-static' }, '常用参数'),
            ...basic.map(renderField)),
          h('div', { className: 'sf-group' },
            h('button', {
              className: 'sf-ghead',
              type: 'button',
              onClick: () => setShowAdvanced((current) => !current),
            },
              h('span', { className: 'sf-caret' }, showAdvanced ? '▾' : '▸'),
              '高级参数'),
            showAdvanced ? advanced.map(renderField) : null),
          h('div', { className: 'sf-footer' },
            h('button', {
              className: 'sf-primary',
              type: 'button',
              disabled: disabled || editCount === 0 || validation.ok === false,
              onClick: save,
            }, busy ? '保存中…' : editCount > 0 ? `保存（${editCount} 项）` : '保存'),
            h('button', {
              className: 'sf-btn',
              type: 'button',
              disabled: disabled || editCount === 0,
              onClick: discard,
            }, '放弃修改'),
            h('button', {
              className: 'sf-btn',
              type: 'button',
              disabled,
              onClick: resetAll,
            }, '恢复全部默认值'),
            h('div', { className: 'sf-spacer' }),
            note
              ? h('div', { className: `sf-note ${note.tone === 'bad' ? 'sf-bad' : 'sf-ok'}` }, note.text)
              : (validation.ok === false
                  ? h('div', { className: 'sf-note sf-bad' }, validation.message)
                  : h('div', { className: 'sf-note' }, editCount > 0 ? `${editCount} 项待保存` : '没有未保存的改动')),
          ),
        )
      }

      /** 插件入口：注册样式与配置页。 */
      function apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-session-fold')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'session-fold: styles')

        // 表单服务来自 ui-settings；用可选 inject，缺失时页面自己给出提示。
        ctx.inject(['configForms'], (formCtx) => {
          const page = (props) => (props?.view === 'summary' ? null : h(ConfigPage, { ctx: formCtx }))

          // 入口一：设置侧栏（最好找）。
          formCtx.effect(
            () => formCtx.slots.inject('settings.section', () =>
              formCtx.slots.register(
                { name: 'settings.section', id: 'session-fold', order: 40, label: '会话折叠压缩' },
                page,
              )),
            'session-fold: settings section',
          )

          // 入口二：插件页里本包那一行的配置页（行标题带 ›，点进它就到这里）。
          formCtx.effect(
            () => formCtx.slots.inject('plugins.row.config', () =>
              formCtx.slots.register(
                { name: 'plugins.row.config', key: ROW_KEY },
                page,
              )),
            'session-fold: config page',
          )
        })
      }

      exports.apply = apply
      exports.inject = inject
      exports.name = 'session-fold'
      return module.exports
    },
  })
}
