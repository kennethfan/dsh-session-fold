# dsh-session-fold — 会话折叠压缩

把长会话里**较早的超长工具输出**折叠成「保留头尾 + 元信息 + 原文路径」的短替身，
原文通过宿主 `ctx.spillStore` 落盘（session 作用域），需要细节时模型直接 `read` / `grep`
那个文件。**零 LLM 调用**，只在 step 边界动手。

English: this plugin deterministically folds older oversized tool results into
spill files and keeps a short head/tail stub with the recovery path. No extra
model call; it complements `dsh-compaction-basic` instead of replacing it.

## 为什么需要它

| 现有机制 | 何时生效 | 留白 |
|---|---|---|
| `dsh-spill-policy` | 单条结果 > 12500 估算 token，工具返回时 | 1–12k token 的中等输出全部原样留在历史里 |
| `dsh-compaction-tool-result-pruner` | 压缩被触发时，裁 8k 字符以上的结果 | 压力没到阈值就永远不跑 |
| `dsh-compaction-basic` | 上下文约 80% 窗口 | 要花一次模型调用写摘要，且摘要会丢命令细节 |

会话里「命令 + 输出」成串累积时，上面的机制都慢一步。本插件补的是这段空档：
在**每次 step 开始前**，按压力或候选数量触发一次确定性折叠，一路把老输出替换成
一条可回捞的短文本，让上下文提前瘦下来，`compaction-basic` 的 LLM 摘要因此很少被触发。

## 折叠后模型看到什么

```
<原文开头 200 字符>

…[输出已折叠] bash command=go test ./... 
原输出 812 行 / 61234 字符 / 58.7 KB
完整原文：/Users/kenneth/.dsh/.../spill/bash-2-....txt
回捞：read 或 grep 这个文件：/Users/kenneth/.dsh/.../spill/bash-2-....txt…

<原文结尾 80 字符>
```

## 机制

```mermaid
flowchart TD
  A["agent/pre-step 或 /fold"] --> B{"有压缩事务进行中?"}
  B -- 是 --> Z["让路，不动 surface"]
  B -- 否 --> C["选候选：surface 上的 tool/result<br/>非错误 / 非富内容 / 未折过 / 超阈值 / 不在保留窗口"]
  C --> D{"压力达标 或 候选 ≥ minCandidates?"}
  D -- 否 --> Z
  D -- 是 --> E["阶段一：逐条 ctx.spillStore.saveText 落盘（异步）"]
  E --> F["阶段二：同步 append compaction/prune + tool/result replace"]
  F --> G["模型继续跑，需要细节时按路径回捞"]
```

关键不变量（都是宿主契约，不能违背）：

1. **日志是唯一真相**：折叠必须落成真正的 surface 替换事件
   `session.append('tool/result', …, { surfaceOp: { op: 'replace', startSeq, endSeq } })`，
   而不是只改内存消息；`sourceEventSeqs` 完整覆盖被遮蔽节点，回放/分叉可确定性重建。
2. **影子计价必须紧邻**：`compaction/prune` 事件必须在它的 replace 事件**之前同步**追加，
   中间不能有 `await`。所以「先异步落盘、再同步替换」分两阶段。没挂压缩体系时该事件
   未注册，插件会省略它并在日志里 debug 一次，替换本身仍然合法。
3. **不抢写**：日志里存在未闭合的 `compaction/start` 时整轮跳过，避免和 compaction 抢 surface。

## 配置

全部有默认值。在 profile 的 `cordis.patch.yml` 用 `- id: session-fold` 覆盖（config 是整条替换，
需要写全要保留的字段）。

| 字段 | 默认 | 含义 |
|---|---|---|
| `auto` | `true` | 是否在 step 边界自动折叠 |
| `foldAtRatio` | `0.25` | 上下文估算达到模型窗口的该比例时折叠 |
| `foldAtTokens` | `32768` | 解析不出模型窗口时使用的绝对阈值（估算 token） |
| `foldThresholdChars` | `800` | 单条结果纯文本超过该字符数才折 |
| `headChars` | `200` | 保留原文开头的字符数 |
| `tailChars` | `80` | 保留原文结尾的字符数 |
| `retainTurns` | `3` | **自动**折叠时最近 N 轮不折（第 7 轮时保护 turn 5/6/7）；手动 `/fold` 不受它约束 |
| `minCandidates` | `5` | 未达压力时累计多少条候选才触发 |
| `maxPerPass` | `20` | 单次折叠上限 |
| `command` | `true` | 是否注册 `/fold`、`/folds`、`/unfold` |
| `recallTool` | `true` | 是否给模型注册 `session_fold_recall` 工具 |
| `prune` | `true` | 是否注册 `/spill-prune` 命令 |
| `pruneRoot` | `''` | spill 根；留空则用后端 `ctx.spillStore.root` |

自相矛盾配置在加载时直接拒绝：`foldThresholdChars` 必须大于
`headChars + tailChars + 160`（否则折叠不会变小）。

## 使用

| 入口 | 作用 |
|---|---|
| 自动 | 长会话里什么都不用做 |
| `/fold` | 立即折一轮，跳过压力与候选数量门槛。保留策略按会话状态决定：轮次进行中只保护**当前这一轮**，已经空闲则全折（否则短会话里手动命令永远无事可做）。返回折了多少条、约省多少 token、落盘多少字节 |
| `/folds` | 列出当前会话表面上的所有折叠项：`#序号 · 工具与命令 · 原大小 · 原文路径` |
| `/unfold <序号>` | 把该条替身换回原文（日志 append-only，仍然可回放） |
| `/unfold all` | 恢复当前表面上全部折叠项 |
| `/spill-prune` | 手动清理 spill 目录，见下面的「手动清理」一节 |
| `session_fold_recall` 工具 | 模型按 `seq` 取回整条原文，或按 `pattern` 在所有折叠原文里逐行搜索；不传参则列清单 |

替身里带稳定 `#序号`（等于**原始事件 seq**）：

```
…[输出已折叠] #3 bash command=go test ./...
原输出 812 行 / 61234 字符 / 58.7 KB
完整原文：/Users/kenneth/.dsh/spill/session-xxxx/...-bash-3.txt
…
```

## 恢复

三层语义，别混：

1. **内容恢复** —— 永远可行。`/unfold` 与 `session_fold_recall` 直接从**会话日志**里的原始事件取原文
   （折叠只是新增遮蔽事件，原事件没被删），所以**即使 spill 文件被清理也能恢复**；spill 路径只是方便
   `read`/`grep` 的快捷方式。
2. **上下文恢复** —— `/unfold` 会把替身节点换回原文，下一轮模型请求就能重新看到那段内容。
   恢复本身也是一条 `surfaceOp: replace` 事件（同样带影子计价），会话依旧可回放、可分叉。
3. **整段历史回滚** —— 不支持。日志 append-only，没有「删掉折叠事件」的操作；要回到折叠前只能
   另开会话或从备份恢复。

## 安装

```sh
# 在 DSH 会话里用插件管理器安装本地目录
# plugin_manager: action=install_bundle, target=/Users/kenneth/agent/deepseek/dsh-session-fold
```

安装后会往 profile 的 `dsh.profile.bundles` 追加 `dsh-session-fold`，其
`cordis.patch.yml` 自动插入 `session-fold` 一行。改完 `index.js` 需要重启 DSH
（Host 半身没有 HMR）。

## 测试

```sh
cd dsh-session-fold && node --test
```

两套测试：

1. `test/fold.test.mjs` —— 最小 fake Session 复现宿主的 surface 语义（replace 移除区间、
   新节点入尾、日志事件不带 surfaceOp），覆盖保留窗口、错误结果、富内容、幂等、
   prune 紧邻、压缩进行中让路、手动保留策略、落盘与 token 记账。
2. `test/live-session.test.mjs` —— 直接 import 宿主随附的 `@deepseek-ai/dsh-session`，
   在真实 `Session.append` 校验下跑折叠，确认 replace 事件、`sourceEventSeqs` 覆盖、
   `compaction/prune` 影子计价都被真实契约接受（找不到 DSH 安装时自动跳过）。

## 手动清理 spill

`/spill-prune` 默认只预览，`--apply` 才真删：

| 参数 | 含义 |
|---|---|
| 无 | 预览：列出「对不上任何现存会话」的目录 |
| `--apply` | 执行删除 |
| `--older-than N` | 额外把 mtime 超过 N 天的目录纳入（不论是否孤儿） |
| `--all` | 纳入全部目录（含存活会话的） |

判定依据：目录名 `session-<sha256(sessionId)[:12]>` 是否落在 `ctx.sessionQuery.listSessions()` 的 id 集合里。
**归档会话算存活**（归档只是 UI 分组，可 unarchive），因此归档会话的 spill 不会被清。

护栏（都在代码里）：只碰根的直接子目录且名字必须匹配 `^session-[0-9a-f]{12}$`；软链接跳过；根太浅或等于 `~`、`~/.dsh`、`~/.dsh/sessions` 时拒绝执行；会话索引取到 0 条时拒绝执行；当前会话的目录永不删。

## 已知边界

- 只折 `tool/result` 的**纯文本**内容；含图片/文件块的结果一律不折（交给官方 image-offload / pruner）。
- 不折 `isError: true` 的结果（错误线索通常短且关键）。
- 不折 user/assistant 消息；不会把「命令记录」本身合并成一行（保留工具调用结构）。
- 折叠会让 provider 的 prompt cache 从第一个被改动的消息起失效；触发是「压力达标才批量折一次」，
  而不是每步都折，就是这个原因。
- spill 文件的保留期限由 `dsh-spill-local` 决定；本 profile 已把它改到固定目录
  `/Users/kenneth/.dsh/spill` 且 `cleanupPeriodDays: 0`（不清理）。即使将来被清理，
  `/unfold` 与 recall 工具走日志，不受影响。
- 单条仍巨大且不可分的结果（例如一次 200k 字符的输出）折后依旧占位：本插件按头尾预算折叠，
  能压到约 400 字符 + 元信息。
