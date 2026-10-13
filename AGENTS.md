# opencode-skill-filter

OpenCode V2 的 Skill 治理插件：按规则对 skill 做**双层治理**——`hide` 软隐藏（设 `autoinvoke: false`，从模型 `available_skills` 摘除，仍可 `@name` 手动调用），`remove` 硬剔除（`editor.remove(id)`，从运行时注册表彻底拔除，可随时无损复原），`enable` 显式激活（保证不被 remove / hide 且 `autoinvoke: true`）。

## 项目定位

这是一个 **OpenCode V2 插件**，不是一个独立应用。入口：`src/index.ts` → 默认导出 `SkillFilterPlugin`。OpenCode 启动时加载插件并执行 `setup(ctx)`，插件在 setup 中读取并合并多层配置，然后注册：

- `ctx.skill.transform(editor => applyFilter(editor, rules))` —— 在宿主组装 `available_skills` 之前同步改写 `autoinvoke` 或 `editor.remove`。
- `ctx.tool.transform(editor => editor.add(skills_list))` —— 只读查询工具（默认开启）。

## 开发命令

```bash
bun run typecheck    # tsc --noEmit（无 build 步骤，OpenCode 直接加载 TS）
bun test             # 运行全部测试（vitest）
bunx vitest          # watch 模式
```

无需 `bun run build` —— OpenCode 通过 `"main": "./src/index.ts"` 直接加载 TypeScript。

## 架构

```
src/
├── index.ts              # 入口：export default SkillFilterPlugin
├── plugin/index.ts       # Plugin 定义：Plugin.define({ id, setup })
├── config/
│   ├── schema.ts         # 校验 + 归一化 + 合并（多层，后层覆盖前层）+ 转规则
│   ├── loader.ts         # 多层文件搜索/读取（全局 → overrides → 项目）+ 合并内联
│   └── overrides.ts      # 目录级 override：键按目录 glob / 仓库名匹配
├── matching/
│   ├── glob.ts           # 轻量 glob（* / ?）、转义、规则归一化
│   └── rules.ts          # decideAction：enable > exclude > include > remove > hide
├── filter/
│   └── apply.ts          # SkillEditor 适配 + collectSkills + applyFilter（含 remove）
├── tool/
│   └── skills-list.ts    # skills_list 工具：ctx.skill.list() + removed 集合 → 状态统计
├── utils/
│   ├── paths.ts          # 全局/项目配置路径解析（XDG / HOME 隔离）
│   └── logger.ts         # 统一前缀日志（默认 console.debug）
└── types/index.ts        # 共享类型（SkillFilterConfig / NormalizedRules）
```

### 关键设计决策

- **双层治理动作**：`remove` 走 `editor.remove(id)`（运行时注册表硬剔除）；`hide` 走 `autoinvoke = false`（软隐藏）；`enable` 走 `autoinvoke = true` 且压过 remove / hide。优先级 `enable > remove > hide > 保持`。
- **动作优先级**：`decideAction` 顺序为 `enable`（show）→ `exclude`（leave）→ `include` 门槛 → `remove` → `hide` → `leave`。判定同时考察 name 与 id。
- **向前兼容**：旧版 `unhide` 在 `normalizeConfig` 中折叠为 `enable`；旧 `hide` 不变。`restoreUnhidden` 保留仅为兼容旧配置，无实际作用。
- **多层配置合并**（后层按字段覆盖前层，数组整体替换）：
  1. 全局 `~/.config/opencode/skill-filter.json`
  2. 全局配置内的 `overrides`（键为目录 glob / 仓库名，命中当前目录时合并）
  3. 项目级 `.opencode/skill-filter.json` → 项目根 `skill-filter.json`
  4. 内联 plugin options（最高）
- **当前目录**：插件 setup 时用 `ctx.location?.directory ?? process.cwd()`，传给 `loadConfig`（`projectDirectory`）。
- **Override 匹配**：`matchesDirectory` 同时对规范化完整路径与 basename 做 glob 匹配；`resolveOverrides` 按书写顺序合并所有命中的 override。
- **真实 API 是 `editor.list()/update()/remove()`，不是 `editor.skills`**：`collectSkills` 优先用 `list()`，回退兼容 `skills` 记录/数组；写入优先 `update(id, cb)`，移除优先 `remove(id)`，不可用时优雅降级（update 缺失→就地改对象；remove 缺失→退化为软隐藏并 warn）。
- **`skills_list` 工具**：setup 中通过 `ctx.tool.transform` 注册，默认开启（`exposeTool: false` 可关闭）；入参用纯 JSON Schema，避免引入 effect 依赖。被 remove 的 skill 从 `ctx.skill.list()` 消失，插件在 `applyFilter` 的 `onRemove` 回调中记录到一个 Map，工具据此报告 `total/active/hidden/removed`。
- **无第三方运行时依赖**：glob 匹配自实现，唯一依赖是 `@opencode/plugin`。

## 配置示例

`skill-filter.json`（全局或项目级）：

```jsonc
{
	"remove": ["paseo*"],
	"hide": ["ask-matt", "to-*", "grill*"],
	"enable": ["to-spec"],
	"overrides": {
		"*/my-paseo-project": {
			"remove": ["paseo*"],
			"enable": ["paseo-keep"]
		}
	}
}
```

旧版配置继续可用（`unhide` 等价 `enable`）：

```jsonc
{
	"hide": ["ask-matt", "to-*", "grill*", "paseo*"],
	"unhide": ["to-spec"]
}
```

## 测试须知

- 测试全面隔离 HOME / XDG，严格禁止读取或污染宿主真实 `~/.config/opencode/`
- 使用 `OPENCODE_TEST_HOME` 环境变量与临时 fixture 目录进行单元与集成测试
- editor 以 mock 形式注入（`list()` + `update()` + `remove()` 写回真实 store），不依赖真实宿主

## 约束

- ESM only（`"type": "module"`），使用 `import` / `export`，同时提供 `default` 与具名导出
- `tsconfig` 开启 `strict: true`
- 唯一运行时依赖：`@opencode/plugin`
- 不要引入新的 npm 依赖，除非经过讨论
- JSDoc 注释中不要出现 `*/` 序列（会被当作注释结束符），描述 glob 时改用文字表述
