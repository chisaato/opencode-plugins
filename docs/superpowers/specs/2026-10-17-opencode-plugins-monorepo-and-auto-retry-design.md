# opencode-plugins monorepo 与 opencode-auto-retry 设计

日期:2026-10-17 · 目标平台:OpenCode v2

## 1. 意图与背景

用户用 Gemini 系模型时,偶发 "Provider blocked the response"(Gemini 外审抽风)。OpenCode 不会为此重试,会话就此停住,常常是 tool call 跑到一半。需要一个插件在这种情况下自动向会话发一句"继续"。

同时,用户已有两个自研 OpenCode 插件(各自独立仓库),现再增加第三个。为降低维护成本(多仓库、多套 CI、多处配置 npm 可信发布),把三个插件合并到一个 monorepo,每个包独立版本、独立发布。

## 2. 目标 / 非目标 / 反目标

目标:
- 新插件 `@misakacloud/opencode-auto-retry`:命中规则时自动向会话发送续写提示词。
- 新仓库 `opencode-plugins`(`/data/SourceCode/opencode-plugins`,GitHub `chisaato/opencode-plugins`),包含三个包,Bun workspace,`packages/*`。
- 每个包独立版本,通过带包名的 tag 触发发布;npm 可信发布(OIDC + provenance),不使用 `NPM_TOKEN`。
- 不设共享包:路径解析、JSONC 解析、日志等少量公共代码,每个包各自带一份(见第 7 节)。

非目标:
- **不做"重发上一条 user 消息"的重试模式。** 重发会丢失已发生的 tool call(Gemini 习惯先连续调用很多 tool 再回复),已明确否决。
- 不处理 dsh(deepseek harness)的移植,与本次无关。
- 不支持 OpenCode v1。
- 不引入 changesets / release-please。

反目标(即使技术上能跑也算失败):
- 没有配置或没有命中规则时仍然响应(必须完全不响应)。
- 在被持续拦截时无限循环地发"继续"。
- 用户手动中断(ESC)后仍自动续写。
- 同一次失败发出多条"继续"。

## 3. opencode-auto-retry 行为

### 3.1 触发
- 订阅会话失败事件(OpenCode v2 的 `session.step.failed`,以调研为准:`error.type === "provider.content-filter"`,`message` 为 "Provider blocked the response";另有 `session.execution.failed`)。
- 因为该错误是模型返回的 finishReason(content-filter),不属于 `isRetryable` 判断范围,**不能使用 `session.hook("retry")`**,必须自行订阅事件。
- 事件只带 `sessionID`。主会话与子会话(task 工具创建,有 `parentID`)都处理;如需区分,再查会话信息。
- 失败发生时会话已经是空闲、可直接接收消息;动作就是向该会话发送规则的 `prompt`(`ctx.session.prompt({ sessionID, text })`)。插件侧**没有“待发”状态**:模型运行中不发,只有失败停下后才由插件或用户发。
- 用户中断(abort / interrupted)是独立事件,不是失败,自然不触发。
- 发送前做一次廉价复查:若失败之后会话里已出现新的用户消息(用户抢先发了),则跳过,避免多发。`delayMs` 仅作为发送前的极短等待,用于合并连发的失败事件并给这次复查留出窗口,可设为 0。

### 3.2 规则与配置
独立配置文件,**JSONC**,不放进 `opencode.json`(避免干扰其 schema)。

位置(项目文件的 `rules` 整体覆盖全局,不逐条合并):
- 全局 `~/.config/opencode/auto-retry.jsonc`
- 项目 `.opencode/auto-retry.jsonc`

```jsonc
{
  "enabled": true,
  // 从上到下匹配,第一条命中的生效;都不命中则不处理
  "rules": [
    {
      // 必填:provider/model 通配符
      "models": ["google/*"],
      // 必填:错误文案子串;models 与 errors 都命中才算命中
      "errors": ["Provider blocked the response"],
      // 以下可省略,省略则使用 defaults
      "prompt": "继续",
      "maxRetries": 3,
      "delayMs": 2000,
      // 失败之间取得多少推进才把计数清零(满足任一即可)
      "resetAfterToolCalls": 10,
      "resetAfterMs": 120000
    }
  ],
  "defaults": { "prompt": "继续", "maxRetries": 3, "delayMs": 2000, "resetAfterToolCalls": 10, "resetAfterMs": 120000 }
}
```

规则：
- 文件缺失、`rules` 为空、`enabled: false` → 插件完全不响应。**不存在内置默认触发规则。**
- `models`、`errors` 任一缺失,这条规则无效并给出提示,不会因漏写而匹配所有模型。
- 支持按模型覆盖:不同规则可使用不同 `prompt` / `maxRetries` / `delayMs`。

### 3.3 熔断与防重
- 计数的是**未取得足够推进的连续失败**,按 "sessionID + 规则" 分别记录。每次失败发生时,先结算"上一次失败/续写之后"这段时间的推进量:
  - 工具调用数 ≥ `resetAfterToolCalls`(默认 10),或持续运行时间 ≥ `resetAfterMs`(默认 120000)→ 计数先清零,再把这次失败记为第 1 次;
  - 否则计数继续累加(例如上限 5,模型每次只走三步就失败,则逐次累计直到熔断)。
  - 模型正常结束(`finish: "stop"`)视为完整清零。
  - 工具调用数优先读取真实的工具事件;如果事件类型里没有可用的工具调用事件,则以 `finish: "tool-calls"` 结束的 step 数近似(会少算并行调用,偏保守)。`finish: "content-filter"` / `"error"` 的 step 不计入推进量。
  - 两个阈值是我的猜测默认值,规则内可覆盖。
- 超过 `maxRetries`:停止重试,保留原始错误,弹一条提示说明已放弃。
- 同一失败的重复事件(`session.step.failed`、`session.execution.failed` 可能连发)只处理一次:按会话加锁/防抖。

### 3.4 子会话
与主会话同样续写。已知风险:父任务可能已把子任务判为失败,续写造成状态不一致。接受该风险。

## 4. Monorepo 与发布

### 4.1 结构(调用方可微调)
```
opencode-plugins/
  package.json            # Bun workspaces: packages/*
  packages/
    auto-model-config/    # @misakacloud/opencode-auto-model-config
    skill-filter/         # @misakacloud/opencode-skill-filter
    auto-retry/           # @misakacloud/opencode-auto-retry
  .github/workflows/      # ci.yml、publish.yml
  docs/superpowers/specs/
```
- 不设共享包。路径解析、JSONC 解析、日志这几个很小的文件各包自带一份(开发期若想去重,可保持目录分离、发布时由构建脚本拷入包内;是否采用由实现者定,默认自带副本)。
- 每个可发布包保留现有的双入口(根目录 `index.ts` + `src/index.ts`)与源码直接分发的方式,沿用 Bun + TypeScript + vitest。
- 现有两个包迁入时尽量保留 git 历史(如 `git subtree` / filter-repo,由实现者选择);原仓库在迁移完成并发布成功后归档。

### 4.2 发布
- 触发:推送形如 `<package>@<version>` 的 tag(例如 `auto-retry@0.1.0`),同一个 `publish.yml` 解析 tag,只构建并发布对应的包;`workflow_dispatch` 支持 dry run。
- 权限 `id-token: write` + `contents: read`;`npm install -g npm@latest`;包内 `publishConfig` 为 `{ access: "public", provenance: true }`;不使用 `NPM_TOKEN`。参考现有 `opencode-auto-model-config/.github/workflows/npm-publish.yml`。
- tag 中的版本必须与对应包 `package.json` 的 `version` 一致,不一致则失败。
- npm 可信发布按包绑定"仓库 + workflow 文件名":三个包各需在 npmjs.com 配置一次,都指向 `chisaato/opencode-plugins` 的 `publish.yml`。这一步只能由用户手动完成。
- 已发布的 `@misakacloud/opencode-auto-model-config` 的可信发布绑定需要改指向新仓库。
- CI(`ci.yml`):push / PR 时对全部包做 typecheck + test。

## 5. 约束
- 注释规则:多用行内注释,少用行后注释。
- 所有面向用户的提示文案使用简体中文。
- 所有包仅支持 OpenCode v2(`@opencode/plugin` ≥ 2.0.x,以现有两个包的依赖为准)。

## 6. 已确认事实(来自源码调研)
- 文案产生:`packages/core/src/session/runner/publish-llm-event.ts:589`(OpenCode 源码)。
- 错误类型:`provider.content-filter`;内置 `isRetryable` 对 `ContentPolicy` 返回 false。
- 插件 API:`Plugin.define({ id, setup(ctx) })`,`ctx.event.subscribe()`,`ctx.session.prompt({sessionID,text})`。
- 以上包名与 API 形态来自一次调研,实现时需对照真实源码与现有两个插件的用法再核一遍。

## 7. 我的决定(非用户明确指定,请检查)
- 新包名与 scope 用 `@misakacloud/`(与现有已发布包一致);skill-filter 同步改为 `@misakacloud/opencode-skill-filter`(它尚未发布)。
- 仓库名 `opencode-plugins`,Bun workspace。
- 全局/项目配置:项目文件整体覆盖全局。
- 默认值:`maxRetries` 3,`delayMs` 2000,`prompt` "继续"(仅作为规则缺省值,不构成默认触发)。
- 超限提示用 UI 弹出提示(具体通道由实现者选)。
- 不做 changesets,采用 tag 命名区分包。

### 构建者检查与用户复核后的决定
- **不设共享包**(用户指出公共代码很简单):各包自带副本。第 4.1 节结构以此为准。
- **发送动作**:`ctx.session.prompt({ sessionID, text })`,`delivery` 默认。失败时会话已空闲,不需要等待空闲;仍需用真实 OpenCode 验证。
- **模型匹配**(用户确认):OpenCode 在一轮运行期间不会因为会话模型被改动而换模型,失败正是由该轮正在使用的模型产生的。因此匹配和续写都使用产生失败的那个模型;匹配时取失败消息(`assistantMessageID`)所属请求的模型,取不到才回退 `session.get().model`,都取不到则视为不命中。若 `prompt` 接口无法指定模型,则接受使用会话当前模型,这一点由实现者核实后写进文档。
- **计数**:见 3.3,按推进量(工具调用数或运行时间)判断是否清零,不再是“任意一步成功就清零”。
- **中断**:见 3.1,无待发状态,无需取消逻辑。
- **消息形态**:续写是普通可见的用户消息(`prompt`),不走 synthetic,让用户能看到并介入。
- **测试**:全仓统一用 vitest,skill-filter 的 `bun:test` 用例随迁移改写;CI 只跑 typecheck 和单元测试,真实 OpenCode 的 smoke 用例不进 CI,只保留为本地手动脚本。

## 8. 留给实现者
- 事件的确切名称与 payload,以及判断"一步成功结束"的事件。
- 子会话区分与加锁的具体实现。
- 历史迁移的具体工具。
- 提示通道与日志格式。
