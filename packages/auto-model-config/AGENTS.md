# opencode-auto-model-config

OpenCode 插件：根据 [models.dev](https://models.dev) 数据为自定义 provider 自动填充模型元数据。

## 项目定位

这是一个 **OpenCode V2 插件**，不是一个独立应用。入口：`src/index.ts` → 默认导出 `AutoModelConfigPlugin`。OpenCode 启动时加载插件并执行 `setup(ctx)`，插件在 setup 中异步读取缓存与映射，并通过 `ctx.model.transform(editor => ...)` 同步增强模型元数据。

## 开发命令

```bash
bun run typecheck    # tsc --noEmit（无 build 步骤，OpenCode 直接加载 TS）
bunx vitest run      # 运行全部测试
bunx vitest          # watch 模式
```

无需 `bun run build` — OpenCode 通过 `"main": "./src/index.ts"` 直接加载 TypeScript。

## 架构

```
src/
├── index.ts              # 入口：export default AutoModelConfigPlugin
├── plugin/
│   └── index.ts          # Plugin 定义：Plugin.define({ id, setup })
├── mapping/
│   ├── parser.ts         # 读 oc-auto-model-config.json（项目目录优先，回退 XDG/全局配置）
│   └── resolver.ts       # 根据映射查 models.dev 数据
├── cache/
│   └── models-dev-cache.ts # 文件缓存：models-dev.json（TTL 24h，自动下载，动态支持 XDG 隔离）
├── debug/
│   └── config-dumper.ts  # 调试模式：dump 增强后的模型元数据差异/结果到文件
├── utils/
│   ├── fields-mapper.ts  # models.dev 字段 → OpenCode V2 原生模型字段映射
│   └── paths.ts          # 统一配置路径与 XDG_CONFIG_HOME / HOME 隔离解析
└── types/
    └── index.ts          # 共享类型
```

### 关键设计决策

- **插件有自己的配置文件，不占用 opencode.json。** 映射写在 `oc-auto-model-config.json`，搜索顺序：当前项目根目录（`ctx.location.directory`） → XDG / 全局目录
- **OpenCode V2 原生契约**：使用 `@opencode/plugin` 2.x 的 `ctx.model.transform`，在 setup 中异步完成文件读取与映射解析，注册同步 editor 增强回调
- **绝不覆盖用户已填写的显式字段** — 区分 `Model.Info.default` 的初始占位值与用户显式覆盖，只补全未显式配置的字段
- models.dev API 数据缓存在 XDG / 全局配置目录下的 `models-dev.json`，TTL 24h，下载失败时降级使用过期缓存

## 用户配置示例

`opencode.json` 采用 V2 原生 `plugins` 和 `providers`：

```jsonc
{
	"plugins": ["@misakacloud/opencode-auto-model-config@latest"],
	"providers": { "newapi": { "models": { "gpt-5.4": {} } } },
}
```

`oc-auto-model-config.json` 放映射（可在项目根目录或全局配置目录）：

```jsonc
{
	"mapping": { "newapi": { "gpt-5.4": "opencode-go/gpt-5.4" } },
	"debug": { "enabled": true },
}
```

## 测试须知

- 测试全面隔离 HOME / XDG，严格禁止读取或污染宿主真实 `~/.config/opencode/`
- 使用临时 fixture 与动态注入路径进行单元与集成测试

## 约束

- ESM only（`"type": "module"`），使用 `import` / `export`，同时提供 `default` 与具名导出
- `tsconfig` 开启 `strict: true`
- 唯一运行时依赖：`@opencode/plugin`
- 不要引入新的 npm 依赖，除非经过讨论
