# @misakacloud/opencode-skill-filter

OpenCode V2 的 Skill 治理插件：按规则对 skill 做**双管齐下**的治理——运行时 `hide` 软隐藏（设 `autoinvoke: false`，从模型 `available_skills` 摘除，仍可 `@name` 手动调用）、`remove` 硬剔除（`editor.remove(id)`，从运行时注册表彻底拔除）、`enable` 显式激活；同时把 `remove` 规则自动同步为**内核级 Policy**（写入 `experimental.policies`），让内核末端的 `ConfigPolicyPlugin` 在下一次启动时、于**所有插件之后**把命中的技能物理拔除。

## 项目定位

这是一个 **OpenCode V2 插件**，不是一个独立应用。入口：`src/index.ts` → 默认导出 `SkillFilterPlugin`。OpenCode 启动时加载插件并执行 `setup(ctx)`，插件在 setup 中读取并合并多层配置，然后：

- `syncPolicies(...)` —— 把 `remove` 规则写入 OpenCode 主配置的 `experimental.policies`（内核级加固，默认开启）。
- `ctx.skill.transform(editor => applyFilter(editor, rules))` —— 在宿主组装 `available_skills` 之前同步改写 `autoinvoke` 或 `editor.remove`（运行时动态防护）。
- `ctx.tool.transform(editor => editor.add(skills_list))` —— 只读查询工具（默认开启）。

## 内核执行顺序（重要发现）

阅读 OpenCode 官方源码确认（`supervisor.ts`）：

1. 内核插件管道顺序为 `[...pre, ...packages, ...post]`；第三方外部插件（含本插件）属于 `packages`。
2. `post` 中依次为 `ConfigCompatibilityPlugin`（读取 `~/.agents/skills` 与 `~/.claude/skills` 并注入技能）→ `ConfigSkillPlugin` → `ConfigPolicyPlugin`（末端）。
3. 末端的 `ConfigPolicyPlugin` 执行 `ctx.skill.transform`，依据 `experimental.policies` 里 `action:"integration.use"` 的 deny policy（resource 形如 `skill:paseo*`，**支持通配符**）调用 `skills.remove(...)`。

结论：由于它在**所有插件之后**运行，写进 `experimental.policies` 的 deny policy 可以绝对物理拔除兼容层注入的技能；而 `packages` 阶段的运行时 `editor.remove` 负责当前进程内的即时剔除。二者互补，即为“双管齐下”。

> 兼容层若在重载时再次注入，运行时 `applyFilter` 会被再次触发（transform 回调节点幂等）而再次剔除；引擎级则由内核 policy 兜底。

## 开发命令

```bash
bun run typecheck    # tsc --noEmit（无 build 步骤，OpenCode 直接加载 TS）
bun run test         # 运行全部测试（vitest run）
bunx vitest          # watch 模式
```

无需 `bun run build` —— OpenCode 通过 `"main": "./src/index.ts"` 直接加载 TypeScript。

## 架构

```
src/
├── index.ts              # 入口：export default SkillFilterPlugin + 全部公共辅助函数
├── plugin/index.ts       # Plugin 定义：Plugin.define({ id, setup }) + policy 同步编排
├── config/
│   ├── schema.ts         # 校验 + 归一化 + 合并（多层，后层覆盖前层）+ 转规则
│   ├── loader.ts         # 多层文件搜索/读取（全局 → overrides → 项目）+ 合并内联
│   ├── jsonc.ts          # JSONC 读写：注释掩码、尾逗号容忍、外科手术式写回
│   └── overrides.ts      # 目录级 override：键按目录 glob / 仓库名匹配
├── policy/
│   └── sync.ts           # 生成/合并 deny policy 并写回 experimental.policies
├── matching/
│   ├── glob.ts           # 轻量 glob（* / ?）、转义、规则归一化
│   └── rules.ts          # decideAction：enable > exclude > include > remove > hide
├── filter/
│   └── apply.ts          # SkillEditor 适配 + collectSkills + applyFilter（含 remove）
├── tool/
│   └── skills-list.ts    # skills_list 工具：ctx.skill.list() + removed 集合 → 状态统计
├── utils/
│   ├── paths.ts          # 全局/项目/opencode 主配置路径解析（XDG / HOME 隔离）
│   └── logger.ts         # 统一前缀日志（默认 console.debug）
└── types/index.ts        # 共享类型（SkillFilterConfig / NormalizedRules / PolicyRule）
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
- **内核 policy 同步（`syncPolicy`，默认开）**：`policy/sync.ts` 由 `remove` 规则生成 `{action:"integration.use", resource:"skill:<pattern>", effect:"deny"}`；`extractPolicies` 读 `experimental.policies`，`mergePolicies` **保留非受管项**（非 `integration.use`+`deny`+`skill:` 前缀者，例如用户手写的 `allow`），只替换受管集合；`structurallyEqual` 判断是否已一致以避免冗余写入。目标文件解析：显式 `syncPolicyPath`（支持 `~`，可创建）→ 否则全局 `opencode.jsonc` → `opencode.json`（都不存在则跳过，**不主动创建**用户主配置）。无 `remove` 规则时不同步。
- **JSONC 外科手术式写入（`config/jsonc.ts`）**：`maskJsonComments` 把注释替换为**等长空白**（保持下标对齐，字符串内 `//`、`/*` 不受影响），`stripTrailingCommas` 容忍尾逗号；定位靠 `findRootObject` / `findPropertyInObject`（仅匹配目标对象第一层深度，避免同名嵌套键误判），替换只改动 `experimental.policies` 的字节区间，**文件其余部分与注释逐字节保留**（数组内部注释不保留，会被重排）。禁止引入 `jsonc-parser` 等依赖。
- **动态防护**：`ctx.skill.transform` 回调会被宿主在每次组装注册表时调用，可能多次触发；`applyFilter` 每次都基于当前 `list()` 重新判定，天然幂等——兼容层重载后注入的技能会被再次剔除，`removedSkills` 以 `id ?? name` 为键去重，避免重复计数。**不再依赖 `console.log` 调试输出。**
- **`skills_list` 工具**：setup 中通过 `ctx.tool.transform` 注册，默认开启（`exposeTool: false` 可关闭）；入参用纯 JSON Schema，避免引入 effect 依赖。被 remove 的 skill 从 `ctx.skill.list()` 消失，插件在 `applyFilter` 的 `onRemove` 回调中记录到一个 Map，工具据此报告 `total/active/hidden/removed`（removed 与存活列表按 id/name 去重），并在有 remove 规则时附上 `policies` 摘要（`patterns/synced/written/path/reason`）。
- **无第三方运行时依赖**：glob 匹配自实现，唯一依赖是 `@opencode/plugin`。

## 配置示例

`skill-filter.json`（全局或项目级）：

```jsonc
{
	"remove": ["paseo*"],
	"hide": ["ask-matt", "to-*", "grill*"],
	"enable": ["to-spec"],
	"syncPolicy": true,
	"overrides": {
		"*/my-paseo-project": {
			"remove": ["paseo*"],
			"enable": ["paseo-keep"]
		}
	}
}
```

`syncPolicy` 默认 `true`。写入的目标默认按序查找全局 `~/.config/opencode/opencode.jsonc` → `opencode.json`；两者都不存在则跳过。可用 `syncPolicyPath` 显式指定（支持 `~`，不存在时会创建）。

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
- policy 测试用 `homeDirectory` 选项或 `OPENCODE_TEST_HOME` 指向临时目录写入；`test/jsonc.test.ts` 覆盖注释掩码与外科手术式写回，`test/policy.test.ts` 覆盖生成/合并/同步（含幂等与显式路径）

## 约束

- ESM only（`"type": "module"`），使用 `import` / `export`，同时提供 `default` 与具名导出
- `tsconfig` 开启 `strict: true`
- 唯一运行时依赖：`@opencode/plugin`
- 不要引入新的 npm 依赖，除非经过讨论
- JSDoc 注释中不要出现 `*/` 序列（会被当作注释结束符），描述 glob 时改用文字表述
