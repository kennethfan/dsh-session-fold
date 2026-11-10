# Changelog

## 0.1.0

首个版本。

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

### 契约

- 每次替换都是真实 surface 事件：`surfaceOp: replace` + `sourceEventSeqs` 覆盖被遮蔽节点，且紧邻 `compaction/prune` 影子计价，保证 token 统计不虚高。
- 与官方 `dsh-spill-policy`（单条 12500 token）、`dsh-compaction-basic`（80% 窗口 LLM 摘要）、工具结果裁剪器共存，不替换、不关闭任何组件。
