# opencode-auto-model-config 设计文档（OpenCode V2）

> 本文档描述当前实现所采用的 **OpenCode V2 插件契约**。
> 历史 V1 设计（`@opencode-ai/plugin`、`config` hook、`plugin`/`provider` 单数配置键）已废弃，
> 不再作为本项目的实现依据。

## 1. 动机

用户在 OpenCode 中配置自定义 provider（如 NewAPI 转发站、自建网关、OpenAI 兼容服务等）时，需要手动为每个模型填写 `name`、`limit`、`capabilities`、`cost` 等元数据。这些数据在 [models.dev](https://models.dev) 中已经完整收录。

本插件让用户只需在配置中声明模型 ID 到 models.dev 条目的映射，即可自动填充模型元数据。

## 2. 数据来源

- **API**: `https://models.dev/api.json`（按 provider ID 索引，每百万 token 美元定价）
- **缓存**: 首次下载后写入本地文件缓存，默认 TTL 24 小时
- **缓存位置**: 遵循 XDG，默认 `<配置目录>/models-dev.json`
  - 优先 `XDG_CONFIG_HOME/opencode/models-dev.json`
  - 回退 `~/.config/opencode/models-dev.json`
  - 可通过 `cacheTTL` / `cachePath` 覆盖
- 下载失败时降级使用过期缓存；无任何缓存且下载失败则跳过本次增强

## 3. 插件架构（V2）

### 3.1 插件入口

OpenCode V2 通过 `@opencode/plugin` 2.x 的 `Plugin.define` 加载插件：

```typescript
// src/index.ts
import { AutoModelConfigPlugin } from "./plugin"

export { AutoModelConfigPlugin }
export default AutoModelConfigPlugin

// src/plugin/index.ts
import { Plugin } from "@opencode/plugin"

export const AutoModelConfigPlugin = Plugin.define({
  id: "opencode-auto-model-config",
  async setup(ctx) {
    // 异步读取映射与 models.dev 缓存，并注册同步 transform
    await ctx.model.transform((editor) => {
      // 同步增强 editor 中已存在的模型元数据
    })
  },
})
```

要点：

- 插件对象是 `{ id, setup }`，`id` 固定为 `opencode-auto-model-config`
- `setup(ctx)` 为**异步**：在插件启动阶段完成文件 I/O（读取 `oc-auto-model-config.json`、`models-dev.json`）与映射解析
- `ctx.model.transform(editor => ...)` 注册的回调是**同步**的：只在内存 editor 上补全字段，不做任何 I/O
- 绝不在 setup 之外持有异步状态；transform 回调依赖 setup 阶段解析好的数据

### 3.2 工作流

```
setup(ctx):
  1. 读取 oc-auto-model-config.json
     ├── ctx.location.directory/oc-auto-model-config.json（项目优先）
     └── XDG 全局配置目录/oc-auto-model-config.json（回退）
  2. 读取 models-dev.json（TTL 24h；缺失/过期则下载，失败降级过期缓存）
  3. 按 mapping 解析每个 provider 的目标模型元数据
  4. ctx.model.transform(editor => ...) 注册同步增强回调

transform(editor):
  对每个已解析的 provider/model：
    ├── editor.provider.get(providerID) 不存在 → 跳过
    ├── editor.get(providerID, modelID) 不存在 → 标记 skipped
    └── editor.update(providerID, modelID, m => ...)
          仅补全仍等于 Model.Info.default 初始值的字段
          保留用户显式覆盖值
```

### 3.3 模块划分

```
src/
├── index.ts                  # 入口：默认导出 AutoModelConfigPlugin
├── plugin/
│   └── index.ts              # Plugin.define({ id, setup }) 与 transform 逻辑
├── mapping/
│   ├── parser.ts             # 读取 oc-auto-model-config.json（项目优先，XDG 回退）
│   └── resolver.ts           # 根据映射查 models.dev 数据，产出 ResolvedModel
├── cache/
│   └── models-dev-cache.ts   # models-dev.json 文件缓存（下载、TTL、失效降级）
├── debug/
│   └── config-dumper.ts      # 调试模式：dump 增强后的模型元数据差异/结果
├── utils/
│   ├── fields-mapper.ts      # models.dev 字段 → OpenCode V2 原生模型字段
│   └── paths.ts              # 统一路径解析（XDG_CONFIG_HOME / HOME 隔离）
└── types/
    └── index.ts              # 共享类型
```

## 4. 配置格式

### 4.1 opencode.json（V2 原生）

插件不修改 `opencode.json`。用户只需声明 provider 与模型 ID：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@misakacloud/opencode-auto-model-config@0.3.0"],
  "providers": {
    "my-openai": {
      "name": "My OpenAI",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://example.com/v1" },
      "models": {
        "gpt-4o": {},
        "gpt-4o-mini": {}
      }
    }
  }
}
```

### 4.2 oc-auto-model-config.json（插件独立配置）

映射写在独立文件中，搜索顺序：当前项目根目录（`ctx.location.directory`）→ XDG / 全局配置目录。

```jsonc
{
  "cacheTTL": 86400,
  "cachePath": null,
  "mapping": {
    "my-openai": {
      "gpt-4o": "openai/gpt-4o",
      "gpt-4o-mini": "openai/gpt-4o-mini"
    }
  },
  "debug": {
    "enabled": true,
    "dumpPath": "./opencode-expanded.json",
    "diffOnly": true
  }
}
```

### 4.3 映射格式

```
"<用户 provider 名>": {
  "<用户 model ID>": "<models.dev provider>/<models.dev model ID>"
}
```

- `"gpt-4o": "openai/gpt-4o"` → 从 `models.dev[openai].models[gpt-4o]` 取元数据
- 支持模型 ID 内再含 `/`（如 `"openai/gpt-4o": "openrouter/openai/gpt-4o"`）
- 先精确匹配，再大小写不敏感匹配（同时检查字典 key 与条目的 `id` 字段）
- 目标为 `provider/model` 形式；缺 `/`、provider 不存在、model 不存在都会产出 warning

## 5. 字段映射（models.dev → V2 原生模型字段）

| models.dev | → | OpenCode V2 模型字段 | 说明 |
|------------|---|----------------------|------|
| `name` | → | `name` | 模型显示名 |
| `family` | → | `family` | 仅当源数据存在时填充 |
| `tool_call` + `modalities` | → | `capabilities` | `{ tools, input[], output[] }` |
| `limit.context` / `limit.output` / `limit.input` | → | `limit` | `input` 仅在存在且与 context 不同时填充 |
| `cost`（含 `context_over_200k`） | → | `cost` | V2 原生数组：基础项 + `tier: { type: "context", size: 200000 }` |

不再产生 V1 专有的扁平字段（`attachment`、`modalities`、`tool_call`、`reasoning`、`knowledge`、`structured_output` 等）。

## 6. 覆盖策略（关键）

- **绝不覆盖用户显式配置的字段**
- OpenCode V2 会用 `Model.Info.default(providerID, modelID)` 为模型预填初始默认值
  （例如 `name = modelID`、`limit = { context: 200000, output: 32000 }`、`capabilities = Capabilities.default()`、`cost = []`）
- 插件在 transform 时动态获取实际的 `Model.Info.default(providerID, modelID)`，并用深度比较判断字段是否仍为初始默认值：
  - 仍是 `undefined` 或等于实际默认值 → 视为未显式配置，可自动填充
  - 与默认值不同 → 视为用户显式覆盖，跳过
- 若用户显式设置的值恰好等于默认值（例如把 `name` 写成与 modelID 相同），则无法与默认值区分，会被视为可自动填充——这是可接受的折衷
- 用户的 `options`、`variants` 等字段完全保留

### 6.1 对象字段的按叶子合并

`limit`、`capabilities` 等对象型默认字段按**叶子**比较合并：只填充仍等于默认值或 `undefined` 的叶子，绝不覆盖用户显式设置的叶子。这样当宿主把用户的部分覆盖（例如只写了 `limit.output`）合并到默认对象上时，`limit.context` 等其它默认叶子仍会被补齐。`cost` 等数组型字段保持**整对象**语义，只在当前数组仍等于默认值时整体替换，避免破坏用户自建数组。

### 6.2 宿主契约假设（当前无法端到端验证）

填充决策依赖一个**尚无法在本仓库端到端验证**的宿主假设：

> 宿主对用户未显式配置的字段所暴露的当前值，应等于 `Model.Info.default(providerID, modelID)` 的返回值。

如果宿主持有别的基底并据此预填字段（即当前值与 `Model.Info.default()` 不一致），可能出现字段**静默不填充**——因为插件会把这些字段误判为用户显式覆盖。需要通过 debug dump 观察实际暴露的字段值来确认。

`test/v2-adapter-integration.test.ts` 等测试使用内存 mock `ModelEditor` 驱动 transform，只验证插件自身的适配逻辑，**不代表已端到端验证宿主行为**。真实 CLI smoke（`test/smoke/opencode-cli.smoke.ts`）默认门控关闭，迄今未在可用环境中通过。

## 7. 调试模式

### 7.1 配置

```jsonc
{
  "mapping": { ... },
  "debug": { "enabled": true, "dumpPath": "./opencode-expanded.json", "diffOnly": true }
}
```

### 7.2 dump 输出

`diffOnly: true` 时仅输出被自动填充的字段 + 元数据；`diffOnly: false` 时输出完整模型字段。

```jsonc
{
  "_meta": {
    "plugin": "@misakacloud/opencode-auto-model-config",
    "timestamp": "2026-04-29T01:20:00Z",
    "modelsDevCacheAge": 3600,
    "summary": {
      "providersProcessed": 1,
      "modelsFilled": 2,
      "modelsNotFound": 0,
      "modelsSkipped": 0,
      "mappingsUsed": { "my-openai/gpt-4o": "openai/gpt-4o" }
    }
  },
  "provider": {
    "my-openai": {
      "models": {
        "gpt-4o": {
          "_source": "openai/gpt-4o",
          "_filled": ["name", "capabilities", "limit", "cost"],
          "name": "GPT-4o",
          "limit": { "context": 128000, "output": 16384 }
        }
      }
    }
  }
}
```

## 8. 依赖

```json
{
  "dependencies": {
    "@opencode/plugin": "2.0.16"
  }
}
```

- 唯一运行时依赖即 OpenCode V2 插件 API
- 不再依赖 V1 的 `@opencode-ai/plugin`
- ESM only；OpenCode 直接加载 `src/index.ts`，无构建步骤

## 9. 与现有生态的关系

| 项目 | 关系 |
|------|------|
| `models.dev` | 数据源：通过 `api.json` 获取模型元数据 |
| OpenCode | 宿主：通过 `Plugin.define` + `ctx.model.transform(editor => ...)` 注入增强字段 |
| `@opencode/plugin` | 唯一插件运行时 API（2.x） |
| `@ai-sdk/openai-compatible` | 不直接依赖，是用户 provider 常用的 npm 包 |

## 10. 测试与验证策略

- 单元/集成测试全面隔离 HOME 与 XDG，使用临时 fixture，禁止读写真实 `~/.config/opencode/`
- adapter/contract 集成测试用内存 mock `ModelEditor` 驱动 transform（`test/v2-adapter-integration.test.ts`）——**不是端到端验证**，无法证明宿主真实契约
- 真实 CLI smoke 为环境变量门控的独立脚本（`test/smoke/opencode-cli.smoke.ts`），不纳入普通 `bunx vitest run`；截至目前尚未在可用环境中通过，宿主契约假设仍属**未验证**
