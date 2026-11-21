# @misakacloud/opencode-model-prompts

OpenCode V2 插件：按模型、代理与工具条件，将多个 Markdown 提示词文件按顺序注入系统上下文。只读取文件路径，不支持内联提示词。

## 安装

在 OpenCode 的 `opencode.jsonc` 中添加：

```jsonc
{
  "plugins": ["@misakacloud/opencode-model-prompts@latest"]
}
```

插件入口 `src/index.ts`，同时导出默认值与 `ModelPromptsPlugin`。

## 配置与文件

全局配置放在 `~/.config/opencode/model-prompts.jsonc`（也支持 `.json`）；项目配置放在 `.opencode/model-prompts.jsonc` 或项目根目录。同目录 `.jsonc` 优先；即便损坏也不会回退到同目录 `.json`。全局、项目、内联 options 按此顺序叠加；`replace: true` 清空前层规则。

默认提示词目录是**各配置文件所在目录下**的 `model-prompts/`；内联 options 默认使用项目 `.opencode/model-prompts/`。例如全局配置：

```text
~/.config/opencode/
├── model-prompts.jsonc
└── model-prompts/
    ├── 1-delegation.md
    └── gemini/guard.md
```

```jsonc
{
  // models 的键按书写顺序处理；其后依次处理 rules。
  "models": {
    "*/gemini-*": ["1-delegation.md", "gemini/guard.md"],
    "openai/gpt-*@fast": {
      "prompts": ["1-delegation.md"],
      "agents": ["orchestrator"],
      "requireTools": ["search"]
    }
  },
  "rules": [
    {
      "models": ["openai/gpt-*", "anthropic/claude-*"],
      "prompts": ["common.md"],
      "excludeAgents": ["reviewer"]
    }
  ]
}
```

`agents` 不设置时匹配所有代理；设置时支持代理 ID、名称及 `*`、`?` 通配。`excludeAgents` 排除命中代理，`requireTools` 要求列出的工具全部存在。模型通配支持跨 `/` 匹配，包含 `@` 的模式与 variant 一同匹配。规则可以共享文件；最终按解析后的路径去重，第一次出现的位置优先。

`promptsDir` 可设置为绝对路径、`~/...` 或相对配置目录的路径。普通文件名或子路径相对于该目录；若项目目录中不存在，会回退到全局 `model-prompts/`。以 `./`、`../` 开头的路径相对于配置文件目录（内联则相对于项目根目录），绝对路径或 `~/` 直接解析。文件须为 UTF-8；空文件跳过，内容去 BOM、去首尾空白。多行字符串不是合法路径。

内联插件 options 支持 `configPath`（指定单文件；`false` 禁用文件读取）、`promptsDir`、`agents`、`excludeAgents`、`requireTools`、`replace`、`debug`、`models` 和 `rules`。修改配置或提示词文件后，下一次 context hook 会根据文件 stat 自动刷新，无需监视定时器。

## 开发

```bash
bun run typecheck
bun run test
```

唯一运行时依赖是 `@opencode/plugin`；OpenCode 直接加载 TypeScript 源码。
