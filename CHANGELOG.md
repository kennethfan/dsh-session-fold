# Changelog

## 0.1.0

首发版本：会话折叠压缩 + 图形配置页。此前从未打 tag、也从未发布 Release，因此
0.1.0 包含全部功能。

### 折叠

- 自动折叠：`agent/pre-step` 检查上下文压力（模型窗口 25%，解析不到窗口退化 32768 token）或候选积满 5 条即批量折叠，单次最多 20 条。
- 手动 `/fold`：跳过压力与数量门槛；轮次进行中只保护当前这一轮，空闲时全折。
- 确定性替身：原文头 200 + 尾 80 字符 + 元信息（`#序号`、工具名、命令摘要、行数/字符/大小、原文路径、回捞提示），替身必须严格小于原文。
- 保护规则：最近 3 轮不折、`isError` 永不折、富内容（图片/文件块）让路、已折过的不重复折、有未闭合压缩事务时整轮让路。

### 恢复

- `/folds`：列出当前表面上的折叠项。
- `/unfold <序号>` / `/unfold all`：把替身换回原文；原文取自会话日志，**不依赖 spill 文件**，因此 spill 被清也能恢复。
- `session_fold_recall` 工具：按 `seq` 取整条原文、按 `pattern` 逐行搜索、无参列清单。
- 恢复本身也是一条 `surfaceOp: replace` 事件（带影子计价），会话仍可回放、可分叉。

### 手动清理

- `/spill-prune`：默认预览，`--apply` 才删；`--all` 含存活目录，`--older-than N` 按 mtime 叠加。
- 孤儿判定基于 `ctx.sessionQuery.listSessions()`，归档会话算存活。

### 配置页

- 新增浏览器半身（`client.js`，手写 ModuleLoader bundle，无构建步骤）：在侧栏 **插件 → 本插件那一行** 提供图形配置页，注册进 `plugins.row.config` 槽位（key `dsh-session-fold#session-fold`）。
- 草稿式编辑：控件只改本地草稿，行上标「未保存」；**必须点「保存」才写入**，另有「放弃修改」与「恢复全部默认值」。
- 保存前本地校验（类型、范围、跨字段预算），不合法时禁用保存并提示具体原因；Host 侧 `validateConfig` 仍是最终裁判。
- 提交给宿主的 `set` op 必须是类型化值：数字给 `number`、比例给 0..1 小数。给输入框原文会被 Config schema（`z.number()` / `z.percent()`）拒绝，页面只会看到「保存被拒绝」。
- 「已自定义」标签改为只在取值真的偏离默认值时显示（宿主写回会钉住整张表单，否则一次保存后满页标签）。
- 新增 `test/client-logic.test.mjs`：12 条纯逻辑测试覆盖类型转换、范围校验、跨字段预算、ops 组装与命名空间解析。
- 12 个字段分「常用参数」7 项与「高级参数」5 项（默认收起），已保存的覆盖项标「已自定义」。
- 写入走宿主 settings 表单（`settings.mutate`，带 revision），持久化到 profile 的 Cordis patch，与手改配置文件是同一处；`SETTINGS_CONFLICT` 与更高层覆盖拒绝会显示在页面上。
- 新增 `/fold-config` 命令，只读打印生效值并标注与默认值不同的项。
- 配置页只暴露 12 个字段；`pruneRoot`（spill 根路径）故意不在页面上，只能在 `cordis.patch.yml` 里改 —— 把 `/spill-prune` 指错目录代价太大。
- 页面同时注册进 `settings.section`（设置侧栏「会话折叠压缩」）与 `plugins.row.config`（插件页该行），两个入口共享同一份组件。

### 配置语义

- 13 个字段全部标 `.volatile()`：配置改动**就地生效**，不再重启插件；相应地把 `auto` / `command` / `recallTool` / `prune` 的判定放到运行期（关掉后命令与工具仍注册，调用时返回「已在插件配置里关闭」）。
- volatile 字段在运行时是 `{ get() }` 引用对象，Host 侧统一经 `lib/config.js` 的 `resolveConfig` 读取，每次调用重新取值。
- 配置暂时不自洽时（例如先调大头尾再调阈值），沿用上一次可用值并只告警一次，不打断回合。

### 契约

- 每次替换都是真实 surface 事件：`surfaceOp: replace` + `sourceEventSeqs` 覆盖被遮蔽节点，且紧邻 `compaction/prune` 影子计价，保证 token 统计不虚高。
- 与官方 `dsh-spill-policy`（单条 12500 token）、`dsh-compaction-basic`（80% 窗口 LLM 摘要）、工具结果裁剪器共存，不替换、不关闭任何组件。
