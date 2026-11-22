# @misakacloud/opencode-auto-model-config

独立的 OpenCode 插件，单独安装、配置和发布。[仓库总览](../../README.md) · [@misakacloud/opencode-auto-retry](../auto-retry/README.md) · [@misakacloud/opencode-skill-filter](../skill-filter/README.md)

OpenCode 插件：根据 [models.dev](https://models.dev) 数据为自定义 provider 自动填充模型元数据。

## 介绍

当你在 OpenCode 中配置自定义 provider（如 OpenAI 兼容 API、第三方模型服务）时，需要手动填写模型的详细信息（上下文窗口、能力、费用等）。这个插件可以自动从 models.dev 获取这些元数据，并填充到你的 OpenCode 配置中。

主要功能：

- 自动从 models.dev 获取模型元数据
- 支持自定义 provider 和模型 ID 映射
- 配置保存后自动刷新模型列表，无需重启 OpenCode
- 本地缓存（24 小时），避免频繁请求
- 不覆盖用户已填写的字段
- 支持调试模式，可查看配置变更

## 使用

### 在 OpenCode 中启用

> 仅支持 OpenCode V2（`@opencode/plugin` 2.x）。
> 强烈建议通过版本号锁定，否则 OpenCode 是否会更新插件是薛定谔的。

在 `opencode.json` 中配置原生 `plugins` 和 `providers`：

```json
{
	"plugins": ["@misakacloud/opencode-auto-model-config@latest"],
	"providers": {
		"my-openai": {
			"models": {
				"gpt-4o": {}
			}
		}
	}
}
```

### 本地路径安装

OpenCode V2 加载目录型插件时解析包目录根部的 `index.ts`（转发到 `src/index.ts`），不读取 `package.json` 的 `main` 作为目录入口。将示例绝对路径换成本机实际路径，任选一种形式，不要与发布包重复安装：

```jsonc
{
  "plugins": ["/data/SourceCode/opencode-plugins/packages/auto-model-config"]
}
```

也可写 `{ package, options }`；本插件**不支持内联 options（不读取 `ctx.options`），仅从配置文件读取**，因此 `options` 只能为空，映射须写在 `oc-auto-model-config.jsonc` 或 `.json`：

```jsonc
{
  "plugins": [
    {
      "package": "/data/SourceCode/opencode-plugins/packages/auto-model-config",
      "options": {}
    }
  ]
}
```

### 插件顺序约束：依赖模型元数据的插件必须排在本插件之后

> **TL;DR：任何会读取模型元数据（`limit` / `cost` / `capabilities` 等）的插件，在 `plugins` 数组里必须排在本插件之后。**

宿主按 `plugins` 数组顺序串行执行各插件的 `setup`，并按 **transform 注册顺序**重放模型变换。本插件通过 `ctx.model.transform` 向模型填充元数据，因此：

- 排在本插件**之后**的插件：每轮重放时先看到本插件填充好的值，读到真实的 `limit` 等元数据。
- 排在本插件**之前**的插件：每轮重放都先于本插件执行，只能读到 `Model.Info.default` 的默认值（例如 `limit.context = 200000` / `limit.output = 32000`）。本插件随后填充的真实值对它们不可见，而且 **`ctx.model.reload()` 也无法纠正**——reload 重建的是干净基底并按同一顺序重放，先读后填的相对顺序不会改变。

典型受害者是像 [opencode-dcp](https://github.com/tarquinen/opencode-dcp) 这类在初始化时缓存 `model.limit.context` 的插件：它若排在本插件之前，会一直拿着默认的 200000 作为模型上下文窗口，导致上下文用量百分比与阈值判断严重失真。

正确示例：

```json
{
	"plugins": [
		"@misakacloud/opencode-auto-model-config@latest",
		"@tarquinen/opencode-dcp@3.2.1"
	]
}
```

本插件自身也会在初始填充完成后主动触发一次 `ctx.model.reload()`，让填充后的基底立即完整重放一轮，尽力缩短后续插件读到默认值的时间窗；但这只是对非常规加载时序的加固，**不能替代数组顺序约束**。

## 配置

插件支持 `oc-auto-model-config.jsonc` 与 `oc-auto-model-config.json`。同一目录里只要有 `.jsonc` 就用它，不再读同目录的 `.json`。查找顺序：

1. 当前项目根目录的 `oc-auto-model-config.jsonc`
2. 当前项目根目录的 `oc-auto-model-config.json`
3. 全局目录的 `oc-auto-model-config.jsonc`
4. 全局目录的 `oc-auto-model-config.json`

全局目录是 `XDG_CONFIG_HOME/opencode`，未设置时为 `~/.config/opencode/`。`.jsonc` 可以写 `//`、`/* */` 注释和尾逗号，也接受文件开头的 UTF-8 BOM。字符串里的 `//`、`/*`、`,`、`}` 按原样保留。文件语法错误时会警告，并跳过同目录的另一种扩展名，再继续下一目录。内容能解析、但没有可用的 `mapping` / `costMapping` 时，仍不启用，也不会改去读别的文件。

插件会监听上述项目与全局配置文件的创建、修改和删除，重新按相同优先级读取配置，再通过 V2 `ctx.model.reload()` 刷新模型列表。启动时没有配置也可稍后创建；移除映射后，下次刷新不再应用该映射。模型数据仍遵循 `cacheTTL` 缓存策略，不会因每次保存都强制下载 models.dev。

### 配置文件格式

```json
{
	"mapping": {
		"your-provider-name": {
			"model-id": "modelsdev-provider/modelsdev-model-id"
		}
	}
}
```

目标既能写 `provider/model`（如 `openai/gpt-4o`），也能写 models.dev 的 `canonical_model_id`（如 `tencent/hy4-flash`）。后者用于官方 provider 未出现在 models.dev provider 表里的情况：插件会遍历所有 provider，找 `canonical_model_id` 相同的条目作为数据来源。多个候选时依次按「模型 key 等于 canonical 最后一段」→「provider id 等于 canonical 第一段」→ provider id 字母序选取，结果确定。命中 canonical 时，debug dump 的 `_source` 仍显示你配置的 canonical id，`_resolvedSource` 显示实际命中的 `provider/model`。

右侧也可以写成对象，进入**精确条件模式**：对象的每个字段都是匹配条件（AND），按 models.dev 条目的同名字段做大小写不敏感的字符串比较；`provider` 是特殊字段，用来限定 provider id。条件字段在 models.dev 条目中必须存在且为字符串才会命中（如 `limit`、`cost`、`modalities` 这类非字符串字段不能作为条件）。

```jsonc
{
	"mapping": {
		"your-provider-name": {
			"hy4-flash": {
				"name": "Hy4 flash",
				"canonical_model_id": "tencent/hy4-flash"
			}
		}
	}
}
```

对象模式的候选排序、无匹配 warning、`_resolvedSource` 行为与字符串模式一致；debug dump 的 `_source` 会显示整个条件对象的 JSON。`costMapping` 也支持同样的两种写法。

### 示例

假设你的 OpenCode V2 配置中有：

```json
{
	"providers": {
		"my-openai": {
			"models": {
				"gpt-4o": {}
			}
		}
	}
}
```

在 `oc-auto-model-config.jsonc`（或 `.json`）中添加映射：

```json
{
	"mapping": {
		"my-openai": {
			"gpt-4o": "openai/gpt-4o"
		}
	}
}
```

启动 OpenCode 后，`gpt-4o` 模型会自动通过 V2 `ctx.model.transform` 填充以下原生字段：

> 此时数据来源 Provider 为 `openai`

- `name`: 模型显示名称
- `family`: 模型家族标识（若源数据包含）
- `capabilities`: 包含 `tools`（布尔）及输入输出模态 `input`/`output`
- `limit`: 上下文窗口 `context` 和输出限制 `output`（以及不同的 `input`）
- `cost`: 原生阶梯费用数组，包含基础费用与 `context_over_200k` 等 tier

同样的，如果你使用的 Provider 采用了 `provider/model` 命名格式，这里也是支持的：

```json
{
	"providers": {
		"my-openai": {
			"models": {
				"openai/gpt-4o": {}
			}
		}
	}
}
```

你可以在映射的时候使用：

```json
{
	"mapping": {
		"my-openai": {
			"openai/gpt-4o": "openai/gpt-4o"
		}
	}
}
```

那么此时还是用 OpenAI 的 `gpt-4o` 模型，数据来源为 `openai`。

### 配置选项

```json
{
	"mapping": {},
	"cacheTTL": 86400,
	"cachePath": "./models-dev.json",
	"debug": {
		"enabled": false,
		"dumpPath": "./expanded-config.json",
		"diffOnly": true
	},
	"override": {
		"cost": false
	}
}
```

**路径警示：**`cachePath` 与 `debug.dumpPath` 仅支持相对路径（OpenCode 在项目根运行时相对项目根）或绝对路径，不支持 `~`；代码把相对路径直接交给文件系统，实际基准是 OpenCode 进程工作目录，而非自动解析成项目根。这里使用 `./` 示范相对路径；若进程工作目录不确定，请改用绝对路径。省略时分别使用全局配置目录下的 `models-dev.json`、`expanded-config.json`。

- `mapping`: 完整元数据映射。与 `costMapping` 至少要有一组非空；只有空 `mapping`、或只写 `override.cost` 时插件不启用
- `costMapping`: 手填的仅价格映射，结构与 `mapping` 相同。只处理列出来的模型，且只覆盖 `cost`
- `cacheTTL`: 缓存有效期，单位秒（默认 86400 = 24 小时）
- `cachePath`: 自定义缓存文件路径
- `debug.enabled`: 启用调试输出。未匹配或源没有价格时，原因写在 dump 里，不会逐条刷屏
- `debug.dumpPath`: 调试输出文件路径
- `debug.diffOnly`: 仅输出变更的字段（默认 true）
- `override.cost`: 只作用于 `mapping`。为 true 时，即使用户显式配置了 `cost`，也会用该 mapping 源的价格覆盖。它不启用、也不阻止 `costMapping`

### 仅价格映射 `costMapping`

订阅或套餐 provider 的 models.dev 条目经常是 0 价，或者模型 ID 与按量 API 不一样。插件**不会**扫描全部模型，也**没有**内置 provider 名单或模型别名。需要估价时，自己写成 `costMapping`：

```json
{
	"costMapping": {
		"claude-code": {
			"claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
			"claude-sonnet-4-6[1m]": "anthropic/claude-sonnet-4-6"
		},
		"kimi-code-plan-cn": {
			"k3": "moonshotai-cn/kimi-k3"
		},
		"alibaba-coding-plan-cn": {
			"qwen3-max-2026-01-23": "alibaba-cn/qwen3-max"
		}
	}
}
```

上面的 ID 只是写法示例，必须和你当前 models.dev 里的真实条目一致。`[1m]` 这类后缀不会自动剥掉，套餐 ID 也不会自动改写成 API ID。

规则：

- 可以只写 `costMapping`，不必再写 `mapping`
- 只改 `cost`，`name` / `limit` / `capabilities` 等字段保持原样
- 与 `mapping` 指向同一模型时，先做完整元数据填充，再由 `costMapping` 覆盖价格
- `costMapping` 是显式覆盖，不看 `override.cost`
- 源 provider/模型不存在，或源条目没有数字 `cost` 时，保留原来的 `cost`，并在 debug dump 里写 `_costWarning`
- 填进去的是 models.dev 的估价，不是服务商账单。OpenRouter、kilo、newapi、Copilot、OpenCode Go 等聚合或跨厂商订阅不会被自动处理；要估价就自己写一条映射

## 卸载与禁用

从 `opencode.json` / `opencode.jsonc` 的 `plugins` 数组移除包名或本地路径条目，重启 OpenCode 即卸载。临时禁用填充可移走所选配置文件，或移除其中所有有效的 `mapping` / `costMapping`（插件在没有可用映射时不启用填充；仍会监听文件变化）。映射配置可能位于项目根目录 `oc-auto-model-config.jsonc` / `.json` 或全局 `~/.config/opencode/oc-auto-model-config.jsonc` / `.json`（遵循 `XDG_CONFIG_HOME`），不会自动删除。

models.dev 缓存默认是 `~/.config/opencode/models-dev.json`（设置 `XDG_CONFIG_HOME` 时为 `$XDG_CONFIG_HOME/opencode/models-dev.json`）；启用调试后 dump 默认是同目录的 `expanded-config.json`。卸载不要求清理缓存或 dump；若不再需要这些数据可手动删除对应文件。指定过 `cachePath` / `debug.dumpPath` 时，应检查自己指定的实际路径。
