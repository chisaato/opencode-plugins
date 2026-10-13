# opencode-skill-filter

OpenCode V2 插件：按规则把多余/冲突的 skill 设为 `autoinvoke: false`，使它们不出现在模型的 `available_skills` 列表中，但仍可通过 `@name` 主动调用。

## 项目定位

这是一个 **OpenCode V2 插件**，不是一个独立应用。入口：`src/index.ts` → 默认导出 `SkillFilterPlugin`。OpenCode 启动时加载插件并执行 `setup(ctx)`，插件在 setup 中读取并合并配置，然后注册 `ctx.skill.transform(editor => applyFilter(editor, rules))`，在宿主组装 `available_skills` 之前同步改写 `autoinvoke`。

## 开发命令

```bash
bun run typecheck    # tsc --noEmit（无 build 步骤，OpenCode 直接加载 TS）
bunx vitest run      # 运行全部测试
bunx vitest          # watch 模式
```

无需 `bun run build` —— OpenCode 通过 `"main": "./src/index.ts"` 直接加载 TypeScript。

## 架构

```
src/
├── index.ts              # 入口：export default SkillFilterPlugin
├── plugin/index.ts       # Plugin 定义：Plugin.define({ id, setup })
├── config/
│   ├── schema.ts         # 校验 + 归一化 + 合并（inline 覆盖 file）+ 转规则
│   └── loader.ts         # 文件搜索/读取（项目 .opencode 优先，回退全局）
├── matching/
│   ├── glob.ts           # 轻量 glob（* / ?）、转义、规则归一化
│   └── rules.ts          # decideAction：unhide > exclude > include > hide
├── filter/
│   └── apply.ts          # SkillEditor 适配 + collectSkills + applyFilter
├── utils/
│   ├── paths.ts          # 全局/项目配置路径解析（XDG / HOME 隔离）
│   └── logger.ts         # 统一前缀日志（默认 console.debug）
└── types/index.ts        # 共享类型
```

### 关键设计决策

- **配置文件独立于 opencode.json**：使用 `skill-filter.json`，搜索顺序为 项目 `.opencode/` → 项目根 → 全局 `~/.config/opencode/`。同时支持 `opencode.jsonc` 的 plugin options 内联传参，内联字段优先。
- **OpenCode V2 原生契约**：使用 `@opencode/plugin` 2.x 的 `ctx.skill.transform`，回调内同步改写 `SkillEditor`。
- **真实 API 是 `editor.list()/update()`，不是 `editor.skills`**：`collectSkills` 优先用 `list()`，并回退兼容 `skills` 记录/数组形态；写入优先 `update(id, cb)`，不可用时回退就地修改。
- **优雅改写**：已是目标值的 skill 跳过，不产生冗余写入；修改统一走 `console.debug` 日志。
- **无第三方运行时依赖**：glob 匹配自实现，唯一依赖是 `@opencode/plugin`。

## 配置示例

`skill-filter.json`：

```jsonc
{
	"hide": ["ask-matt", "to-*", "grill*", "paseo*"],
	"unhide": ["to-spec"]
}
```

## 测试须知

- 测试全面隔离 HOME / XDG，严格禁止读取或污染宿主真实 `~/.config/opencode/`
- 使用 `OPENCODE_TEST_HOME` 环境变量与临时 fixture 目录进行单元与集成测试
- editor 以 mock 形式注入（`list()` + `update()` 写回真实对象），不依赖真实宿主

## 约束

- ESM only（`"type": "module"`），使用 `import` / `export`，同时提供 `default` 与具名导出
- `tsconfig` 开启 `strict: true`
- 唯一运行时依赖：`@opencode/plugin`
- 不要引入新的 npm 依赖，除非经过讨论
