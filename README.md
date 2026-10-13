# opencode-skill-filter

OpenCode V2 的 **Skill 治理核心引擎**：对加载的 skill 做双层治理，既能把多余或相互冲突的 skill **软隐藏**（`autoinvoke: false`），也能把它们**彻底掩埋**（从运行时注册表移除），从而节省 token、避免指令冲突，同时保留 `@skill-name` 手动调用能力。

同时提供一个只读工具 `skills_list`，方便在会话中随时查看当前加载的 skill 及其 **active / hidden / removed** 状态。

> 仅支持 OpenCode V2（`@opencode/plugin` 2.x）。

## 解决的问题

很多 skill 集合里同时存在：

- 功能重叠的 skill（例如多个 "spec" 流程）
- 只在特定场景才需要的 skill（例如某些一次性工具）
- 会互相干扰、抢注意力的 skill

它们全部塞进 `available_skills` 会持续占用上下文并可能让模型选错流程。本插件让你按名称或通配符对它们分级治理。

## 双层治理动作

| 动作 | 字段 | 效果 | 可逆性 |
| --- | --- | --- | --- |
| **硬剔除** | `remove` | 调用 `editor.remove(id)`，从 OpenCode 运行时注册表彻底拔除，在模型 Prompt、补全、API 中完全消失 | 随时改回配置即可无损复原 |
| **软隐藏** | `hide` | 保留注册，仅设 `skill.autoinvoke = false`，从模型 `available_skills` 摘除，仍支持 `@name` 手动调用 | 随时改回配置即可复原 |
| **显式激活** | `enable` | 保证不被 remove / hide，且设 `skill.autoinvoke = true` | — |
| 保持原样 | — | 未命中任何规则 | — |

**动作优先级（由高到低）：**

```
enable  >  exclude  >  include(范围门槛)  >  remove  >  hide  >  保持原样
```

> `unhide` 是 `enable` 的**旧版别名**，会等价映射到 `enable`；旧的 `hide` / `unhide` 配置可原样继续使用（向前兼容）。`restoreUnhidden` 保留仅为兼容，已无实际作用。

## 安装

在 `opencode.jsonc` 中声明插件（建议锁定版本）：

```jsonc
{
	"plugins": ["@misakacloud/opencode-skill-filter@latest"]
}
```

## 配置

支持多层来源，**后层按字段覆盖前层**（数组整体替换，不做并集）：

1. **全局配置** —— `~/.config/opencode/skill-filter.json`（遵循 `XDG_CONFIG_HOME`）
2. **全局配置内的 `overrides`** —— 键为目录 glob，命中当前项目目录时合并进当前规则
3. **项目级配置** —— `<项目>/.opencode/skill-filter.json` → `<项目>/skill-filter.json`（优先级高于全局规则）
4. **内联 options** —— 直接写在 `opencode.jsonc` 的插件声明处（最高优先级）

当前目录取自 `ctx.location.directory`，缺失时回退 `process.cwd()`。

### 配置格式

```json
{
	"remove": ["paseo*"],
	"hide": ["ask-matt", "to-*", "grill*"],
	"enable": ["to-spec"],
	"overrides": {
		"*/my-paseo-project/*": {
			"remove": ["paseo*"],
			"enable": ["paseo-keep"]
		}
	},
	"patterns": {
		"include": [],
		"exclude": []
	}
}
```

### 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `remove` | `string[]` | 硬剔除：命中后 `editor.remove(id)`，从注册表彻底移除 |
| `hide` | `string[]` | 软隐藏：命中后 `autoinvoke = false` |
| `enable` | `string[]` | 显式激活：命中后保证不被移除/隐藏，且 `autoinvoke = true`（**最高优先级**） |
| `unhide` | `string[]` | `enable` 的旧版别名（向后兼容，等价映射为 `enable`） |
| `overrides` | `Record<string, Config>` | 目录级 override，键为目录 glob / 绝对路径 / 仓库名 |
| `patterns.include` | `string[]` | 非空时收窄作用范围：只有命中它的 skill 才会被处理 |
| `patterns.exclude` | `string[]` | 永不处理这些 skill（优先级仅次于 `enable`） |
| `restoreUnhidden` | `boolean` | **已废弃**，保留仅为兼容旧配置，无实际作用 |
| `debug` | `boolean` | 默认 `true`，通过 `console.debug` 输出命中的规则与修改记录 |
| `exposeTool` | `boolean` | 默认 `true`，是否注册 `skills_list` 工具 |
| `configPath` | `string \| false` | 显式指定配置文件路径；`false` 表示完全跳过文件加载，仅用内联 options |

### 内联传参示例

```jsonc
{
	"plugins": [
		[
			"@misakacloud/opencode-skill-filter@latest",
			{
				"remove": ["paseo*"],
				"enable": ["to-spec"]
			}
		]
	]
}
```

内联 options 逐字段覆盖文件中的同名字段（数组整体替换，不做并集）。

## 典型用法

### 彻底掩埋 paseo

**全局**（对所有项目生效）：

```json
// ~/.config/opencode/skill-filter.json
{
	"remove": ["paseo*"]
}
```

**仅在某个项目**（用目录级 override）：

```json
// ~/.config/opencode/skill-filter.json
{
	"hide": ["grill*"],
	"overrides": {
		"*/my-paseo-project/*": {
			"remove": ["paseo*"],
			"enable": ["paseo-keep"]
		}
	}
}
```

只要身处包含 `my-paseo-project` 的目录，`paseo*` 被硬剔除，而 `paseo-keep` 仍被显式激活；离开该目录后规则自动失效。

### 按目录 override 的匹配规则

override 键会同时与**规范化后的完整目录路径**和**目录 basename（仓库名）**做 glob 匹配：

- `*/my-paseo-project/*` —— 路径片段命中
- `/home/me/work/paseo` —— 绝对路径精确命中
- `paseo-tools` —— 仓库名（basename）命中

多个 override 同时命中时，按书写顺序合并，后者覆盖前者。

## 匹配规则

- 支持**精准匹配**：`ask-matt` 只命中名为 `ask-matt` 的 skill
- 支持**通配符 glob**：
  - `*` 匹配任意长度字符（含空串，可跨越 `/`），例如 `to-*`、`paseo*`、`grill*`
  - `?` 匹配单个字符
- 匹配为**整串锚定**：`to-*` 不会误伤 `atto`
- 区分大小写
- 判定时同时检查 skill 的 **name 与 id**，任一命中即视为命中（便于匹配 `vendor/grill` 这类带命名空间的 id）

### 优先级

```
enable  >  exclude  >  include(范围门槛)  >  remove  >  hide  >  保持原样
```

例如 `remove: ["to-*"]` + `enable: ["to-spec"]`：除 `to-spec` 外的所有 `to-` 前缀 skill 被彻底移除，`to-spec` 反而被显式激活。

## 工作原理

```
opencode 启动
  └─ plugin setup(ctx)
       ├─ 读取并合并多层配置（全局 → overrides → 项目 → 内联）
       ├─ ctx.tool.transform(editor => editor.add(skills_list))   # 默认开启
       └─ ctx.skill.transform(editor => applyFilter(editor, rules))
            ├─ 命中 remove → editor.remove(id)（并记录到 removed 集合）
            ├─ 命中 hide   → editor.update(id, s => s.autoinvoke = false)
            └─ 命中 enable → editor.update(id, s => s.autoinvoke = true)
```

核心是 V2 的原生契约 `ctx.skill.transform`，回调拿到 `SkillEditor`（`list()` / `update(id, cb)` / `remove(id)` 等）。已经被设成目标值的 skill 会被优雅跳过，不产生冗余写入；修改过程通过 `console.debug` 记录。

若宿主未提供 `editor.update`，插件会回退为直接修改 `editor.skills` 中的对象；若未提供 `editor.remove`，`remove` 动作会退化为软隐藏（`autoinvoke = false`）并给出警告，避免直接丢规则。

## `skills_list` 工具

插件在 setup 时通过 `ctx.tool.transform` 注册一个只读工具 `skills_list`：

> 列出当前 OpenCode 加载的所有 Skills 以及它们的过滤/隐藏/移除状态 (autoinvoke)

它读取 `ctx.skill.list()`（存活 skill）与插件记录的 `removed` 集合，并同时返回人可读文本与结构化 `metadata`：

- `total`：**原始发现总数** = 当前存活数量 + 被移除数量
- `active`：`autoinvoke !== false`（会出现在 `available_skills` 中）
- `hidden`：`autoinvoke === false`（被软隐藏，仅能通过 `@name` 手动调用）
- `removed`：被 `editor.remove` 硬剔除的数量
- `skills`：按 `status` 过滤后的条目（含 `name` / `id` / `description` / `state` / `autoinvoke` / `hidden` / `removed`）

### 入参

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `"all" \| "active" \| "hidden" \| "removed"` | 可选，默认 `"all"`。非法值回退为 `"all"` |

`total` / `active` / `hidden` / `removed` 始终基于全部 skill 统计，只有 `skills` 明细受 `status` 过滤。

### 关闭工具

若只想保留治理能力、不希望向模型暴露查询工具，将 `exposeTool` 设为 `false` 即可：

```jsonc
{
	"plugins": [
		["@misakacloud/opencode-skill-filter@latest", { "exposeTool": false }]
	]
}
```

## 开发

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # 运行全部测试（vitest）
```

### 目录结构

```
src/
├── index.ts              # 导出 default / SkillFilterPlugin
├── plugin/index.ts       # Plugin.define({ id, setup })
├── config/
│   ├── schema.ts         # 校验 + 归一化 + 合并 + 转运行时规则
│   ├── loader.ts         # 多层配置加载、合并、与内联 options 合并
│   └── overrides.ts      # 目录级 override 匹配与合并
├── matching/
│   ├── glob.ts           # 轻量 glob → RegExp、规则归一化
│   └── rules.ts          # 优先级决策（enable/remove/hide/include/exclude）
├── filter/
│   └── apply.ts          # SkillEditor 适配 + 应用过滤（含 remove）
├── tool/
│   └── skills-list.ts    # skills_list 工具定义 + 状态统计/格式化
├── utils/
│   ├── paths.ts          # 全局/项目配置路径解析（XDG / HOME 隔离）
│   └── logger.ts         # 统一前缀日志
└── types/index.ts        # 共享类型
```

## 测试

测试全面隔离 `HOME` / `XDG_CONFIG_HOME`（通过 `OPENCODE_TEST_HOME` 与临时目录），不会读取或污染宿主真实的 `~/.config/opencode/`。

## License

MIT
