# @misakacloud/opencode-model-prompts

OpenCode V2 插件：按模型、代理与工具条件，将多个 Markdown 提示词文件按顺序注入系统上下文。只读取文件路径，不支持内联提示词。

最低要求：OpenCode V2，`@opencode/plugin ^2.0.31`。

## 安装

在 OpenCode 的 `opencode.jsonc` 中添加：

```jsonc
{
  "plugins": ["@misakacloud/opencode-model-prompts@latest"]
}
```

插件入口 `src/index.ts`，同时导出默认值与 `ModelPromptsPlugin`。

### 本地路径安装

OpenCode V2 加载目录型插件时查找包目录根部的 `index.ts`（转发到 `src/index.ts`），不会从 `package.json` 的 `main` 查找目录入口。将绝对路径改成你本机的包目录；任选一种形式，不要同时加载本地和发布版：

```jsonc
{
  "plugins": ["/data/SourceCode/opencode-plugins/packages/model-prompts"]
}
```

需要内联 options 时可用 `{ package, options }`；下面示例从项目根目录下的 `.opencode/model-prompts.jsonc` 读取配置，并增加一条内联规则：

```jsonc
{
  "plugins": [
    {
      "package": "/data/SourceCode/opencode-plugins/packages/model-prompts",
      "options": {
        "configPath": ".opencode/model-prompts.jsonc",
        "models": {
          "openai/gpt-*": ["./.opencode/model-prompts/extra.md"]
        }
      }
    }
  ]
}
```

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
  // 顶层默认值：同一配置层中，models 条目和 rules 条目未设置时继承。
  "agents": ["orchestrator"],
  "excludeAgents": ["reviewer"],
  "requireTools": ["search"],
  "replace": false,
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

配置文件**顶层**可设置 `agents`、`excludeAgents`、`requireTools` 作为该配置层所有规则的默认值；规则内同名字段会覆盖顶层值。顶层 `replace: true` 则在叠加本层规则前清空前面配置层的规则。`agents` 不设置时匹配所有代理；设置时支持代理 ID、名称及 `*`、`?` 通配。`excludeAgents` 排除命中代理，`requireTools` 要求列出的工具全部存在。模型通配支持跨 `/` 匹配，包含 `@` 的模式与 variant 一同匹配。规则可以共享文件；最终按解析后的路径去重，第一次出现的位置优先。

`promptsDir` 可设置为绝对路径、`~/...` 或相对配置目录的路径。普通文件名或子路径相对于该目录；若项目目录中不存在，会回退到全局 `model-prompts/`。以 `./`、`../` 开头的路径相对于配置文件目录（内联则相对于项目根目录），绝对路径或 `~/` 直接解析。文件须为 UTF-8；空文件跳过，内容去 BOM、去首尾空白。多行字符串不是合法路径。

内联插件 options 支持 `configPath`（指定单文件；`false` 禁用文件读取）、`promptsDir`、`agents`、`excludeAgents`、`requireTools`、`replace`、`debug`、`models` 和 `rules`。`configPath` 支持 `~/` 展开（以用户 HOME 为基准），相对路径以**项目根目录**为基准；绝对路径直接使用。`debug` **目前仅内联 `debug: true` 生效**：插件在 setup 时根据内联选项创建日志器，配置文件中的 `debug` 不会开启调试日志。修改配置或提示词文件后，下一次 context hook 会根据文件 stat 自动刷新，无需监视定时器。

## 卸载与禁用

从 `opencode.jsonc` / `opencode.json` 的 `plugins` 数组移除发布包或本地目录路径条目，重启 OpenCode 即卸载。临时禁用文件规则可用内联 `"configPath": false` 并去掉内联 `models` / `rules`（只设 `configPath:false` **不会禁用已有内联规则**）；也可删去配置中的规则。插件不会创建持久缓存；全局 `~/.config/opencode/model-prompts.jsonc` / `.json`、项目 `.opencode/model-prompts.jsonc` / `.json` 或项目根同名文件及对应 `model-prompts/` 下的 Markdown 均为用户文件，卸载不自动删除；不再使用可按需手动清理。

## 开发

```bash
bun run typecheck
bun run test
```

唯一运行时依赖是 `@opencode/plugin`；OpenCode 直接加载 TypeScript 源码。
