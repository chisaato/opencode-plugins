# Issue tracker：本地 Markdown

本仓库的需求规格与任务存放在 `.scratch/`，不自动创建远程 issue。

## 文件约定

- 每个特性独立目录：`.scratch/<feature-slug>/`。
- 需求规格：`.scratch/<feature-slug>/spec.md`。
- 实现任务：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号，每个任务一个文件，不合并成单一 tickets 文件。
- 分诊状态写在任务顶部的 `Status:` 行，取值见 [标签映射](triage-labels.md)。
- 讨论记录追加到文件底部的 `## Comments` 下。

## Skill 操作对应关系

- “发布到 issue tracker”：按上述约定创建对应文件，按需创建目录。
- “获取相关 ticket”：读取引用路径的文件；用户通常提供路径或任务编号。

## Wayfinding 操作

`/wayfinder` 使用一份地图及每个任务对应的独立子文件。

- **地图**：`.scratch/<effort>/map.md`，包含 Notes / Decisions-so-far / Fog。
- **子任务**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文记录待解问题；`Type:` 为 `research`、`prototype`、`grilling` 或 `task`。
- **生命周期**：wayfinder 的 `Status:` 使用 `claimed` / `resolved`，与普通任务的五种分诊标签不是同一组状态。
- **依赖**：顶部用 `Blocked by: NN, NN` 记录依赖；所有被引用任务均为 `resolved` 时解除阻塞。
- **下一任务**：扫描 issues 目录，选择尚未解决、无阻塞且未被领取的任务，编号最小者优先。
- **领取**：开始工作前设置 `Status: claimed` 并保存。
- **解决**：在 `## Answer` 下追加答案，设置 `Status: resolved`，并在地图的 Decisions-so-far 中追加摘要及文件链接。
