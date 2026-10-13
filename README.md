# opencode-skill-filter

OpenCode V2 插件：把多余或相互冲突的 skill **隐藏**（设置 `autoinvoke: false`），使它们不再出现在模型的 `available_skills` 列表中，从而节省 token 并避免指令冲突 —— 同时用户依然可以通过 `@skill-name` 主动调用。

同时提供一个只读工具 `skills_list`，方便在会话中随时查看当前加载的 skill 及其过滤/隐藏状态。

> 仅支持 OpenCode V2（`@opencode/plugin` 2.x）。

## 解决的问题

很多 skill 集合里同时存在：

- 功能重叠的 skill（例如多个 "spec" 流程）
- 只在特定场景才需要的 skill（例如某些一次性工具）
- 会互相干扰、抢注意力的 skill

它们全部塞进 `available_skills` 会持续占用上下文并可能让模型选错流程。本插件让你按名称或通配符把它们从自动可用列表中摘掉，同时保留手动调用能力。

## 安装

在 `opencode.jsonc` 中声明插件（建议锁定版本）：

```jsonc
{
	"plugins": ["@misakacloud/opencode-skill-filter@latest"]
}
```

## 配置

支持两种来源，二者可同时使用：

1. **内联 options** —— 直接写在 `opencode.jsonc` 的插件声明处（优先级更高，逐字段覆盖）
2. **配置文件** —— `skill-filter.json`

### 配置文件搜索顺序（先命中先用）

1. `<项目>/.opencode/skill-filter.json`
2. `<项目>/skill-filter.json`
3. `~/.config/opencode/skill-filter.json`（遵循 `XDG_CONFIG_HOME`）

### 配置格式

```json
{
	"hide": ["ask-matt", "to-*", "grill*", "paseo*"],
	"unhide": ["to-spec"],
	"patterns": {
		"include": [],
		"exclude": []
	}
}
```

### 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `hide` | `string[]` | 需要隐藏的 skill 名称 / glob。命中后 `autoinvoke = false` |
| `unhide` | `string[]` | 白名单，**优先级高于 `hide`**，命中的 skill 永不被隐藏 |
| `patterns.include` | `string[]` | 非空时收窄作用范围：只有命中它的 skill 才会被过滤 |
| `patterns.exclude` | `string[]` | 永不处理这些 skill（优先级：`unhide` > `exclude` > `hide`） |
| `restoreUnhidden` | `boolean` | 默认 `false`。开启后，命中 `unhide` 的 skill 会被主动设为 `autoinvoke: true` |
| `debug` | `boolean` | 默认 `true`。通过 `console.debug` 输出命中的规则与修改记录 |
| `exposeTool` | `boolean` | 默认 `true`。是否注册 `skills_list` 工具；设为 `false` 时插件只做过滤，不暴露查询工具 |
| `configPath` | `string \| false` | 显式指定配置文件路径；`false` 表示完全跳过文件加载，仅用内联 options |

### 内联传参示例

```jsonc
{
	"plugins": [
		[
			"@misakacloud/opencode-skill-filter@latest",
			{
				"hide": ["ask-matt", "to-*"],
				"unhide": ["to-spec"]
			}
		]
	]
}
```

内联 options 逐字段覆盖文件中的同名字段（数组整体替换，不做并集）。

## 匹配规则

- 支持**精准匹配**：`ask-matt` 只命中名为 `ask-matt` 的 skill
- 支持**通配符 glob**：
  - `*` 匹配任意长度字符（含空串），例如 `to-*`、`paseo*`、`grill*`
  - `?` 匹配单个字符
- 匹配为**整串锚定**：`to-*` 不会误伤 `atto`
- 区分大小写
- 判定时同时检查 skill 的 **name 与 id**，任一命中即视为命中（便于匹配 `vendor/grill` 这类带命名空间的 id）

### 优先级

```
unhide  >  exclude  >  include(范围门槛)  >  hide  >  保持原样
```

例如 `hide: ["to-*"]` + `unhide: ["to-spec"]`：除 `to-spec` 外的所有 `to-` 前缀 skill 被隐藏。

## 工作原理

```
opencode 启动
  └─ plugin setup(ctx)
       ├─ 读取并合并配置（内联 options + skill-filter.json）
       ├─ ctx.tool.transform(editor => editor.add(skills_list))   # 默认开启
       └─ ctx.skill.transform(editor => applyFilter(editor, rules))
            └─ 在 available_skills 组装前，把命中 hide 的 skill 设为 autoinvoke=false
```

核心就是 V2 的原生契约 `ctx.skill.transform`，回调拿到 `SkillEditor`（`list()` / `update(id, cb)` 等），插件对命中的 skill 执行：

```ts
editor.update(skillId, (skill) => {
	skill.autoinvoke = false
})
```

已经被设成目标值的 skill 会被优雅跳过，不产生冗余写入；修改过程通过 `console.debug` 记录，便于诊断。若宿主未提供 `editor.update`，插件会回退为直接修改 `editor.skills` 中的对象。

## `skills_list` 工具

插件在 setup 时通过 `ctx.tool.transform` 注册一个只读工具 `skills_list`：

> 列出当前 OpenCode 加载的所有 Skills 以及它们的过滤/隐藏状态 (autoinvoke)

它读取 `ctx.skill.list()`，统计每个 skill 的 `autoinvoke` 状态，并同时返回人可读文本与结构化 `metadata`：

- `total`：全部 skill 数量
- `active`：`autoinvoke !== false`（会出现在 `available_skills` 中）
- `hidden`：`autoinvoke === false`（被本插件隐藏，仅能通过 `@name` 手动调用）
- `skills`：按 `status` 过滤后的条目（含 `name` / `id` / `description` / `autoinvoke` / `hidden`）

### 入参

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `"all" \| "active" \| "hidden"` | 可选，默认 `"all"`。`active` 只看可自动调用的，`hidden` 只看已被隐藏的；非法值回退为 `"all"` |

`total` / `active` / `hidden` 始终基于全部 skill 统计，只有 `skills` 明细受 `status` 过滤。

### 关闭工具

若只想保留过滤能力、不希望向模型暴露查询工具，将 `exposeTool` 设为 `false` 即可：

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
bun test             # 运行全部测试
```

### 目录结构

```
src/
├── index.ts              # 导出 default / SkillFilterPlugin
├── plugin/index.ts       # Plugin.define({ id, setup })
├── config/
│   ├── schema.ts         # 校验 + 归一化 + 合并 + 转运行时规则
│   └── loader.ts         # 文件搜索、读取、与内联 options 合并
├── matching/
│   ├── glob.ts           # 轻量 glob → RegExp、规则归一化
│   └── rules.ts          # 优先级决策（hide/unhide/include/exclude）
├── filter/
│   └── apply.ts          # SkillEditor 适配 + 应用过滤
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
