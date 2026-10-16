# opencode-auto-model-config

OpenCode 插件：根据 [models.dev](https://models.dev) 数据为自定义 provider 自动填充模型元数据。

>  寻找适用于 Pi Coder 的版本? 

## 介绍

当你在 OpenCode 中配置自定义 provider（如 OpenAI 兼容 API、第三方模型服务）时，需要手动填写模型的详细信息（上下文窗口、能力、费用等）。这个插件可以自动从 models.dev 获取这些元数据，并填充到你的 OpenCode 配置中。

主要功能：

- 自动从 models.dev 获取模型元数据
- 支持自定义 provider 和模型 ID 映射
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
	"plugins": ["@misakacloud/opencode-auto-model-config@0.3.0"],
	"providers": {
		"my-openai": {
			"models": {
				"gpt-4o": {}
			}
		}
	}
}
```

## 配置

插件支持通过 `oc-auto-model-config.json` 进行配置，优先级为：当前项目根目录 > `~/.config/opencode/`。

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

在 `oc-auto-model-config.json` 中添加映射：

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
	"cachePath": "~/.config/opencode/models-dev.json",
	"debug": {
		"enabled": false,
		"dumpPath": "~/.config/opencode/expanded-config.json",
		"diffOnly": true
	},
	"override": {
		"cost": false
	}
}
```

- `mapping`: 模型映射关系（必填）
- `cacheTTL`: 缓存有效期，单位秒（默认 86400 = 24 小时）
- `cachePath`: 自定义缓存文件路径
- `debug.enabled`: 启用调试输出
- `debug.dumpPath`: 调试输出文件路径
- `debug.diffOnly`: 仅输出变更的字段（默认 true）
- `override.cost`: 是否强制覆盖模型价格（默认 false）。开启后，即使用户显式配置了 `cost`，也会使用 models.dev 的价格覆盖，适用于订阅制模型查看准确用量场景
