# opencode-plugins monorepo 与 opencode-auto-retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Bun workspace 的 `opencode-plugins` monorepo,迁入两个现有插件,新增 `@misakacloud/opencode-auto-retry`(命中规则时向会话发送续写提示词),并配置按包 tag 触发的 npm 可信发布 CI。

**Architecture:** 三个包各自独立(无共享包),源码直接分发,沿用双入口(根 `index.ts` + `src/index.ts`)。auto-retry 订阅 OpenCode v2 失败事件,经"规则匹配 → 连续失败计数 → 复查 → `ctx.session.prompt`"发送续写。发布由单个 `publish.yml` 解析 `<package>@<version>` tag,OIDC + provenance。

**Tech Stack:** Bun workspaces、TypeScript(ES2022 / ESNext / bundler / strict)、vitest、`@opencode/plugin` v2(版本以现有两个包为准)、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-17-opencode-plugins-monorepo-and-auto-retry-design.md`

## Global Constraints
- 仅支持 OpenCode v2;插件写法 `Plugin.define({ id, setup(ctx) })`,包名与 API 先对照现有两个插件及 `node_modules/@opencode/{plugin,client,schema}` 的真实类型,不得凭印象。
- 包名:`@misakacloud/opencode-auto-model-config`、`@misakacloud/opencode-skill-filter`、`@misakacloud/opencode-auto-retry`;不设共享包。
- 配置为独立 **JSONC**:全局 `~/.config/opencode/auto-retry.jsonc`,项目 `.opencode/auto-retry.jsonc`,项目的 `rules` 整体覆盖全局。
- 没有配置/无规则命中/`enabled:false` → 完全不响应;无内置默认触发规则。
- 规则默认值:`prompt` "继续"、`maxRetries` 3、`delayMs` 2000(可为 0)。
- 注释规则:多用行内注释,少用行后注释;面向用户的文案使用简体中文。
- 全仓测试用 vitest;CI 只跑 typecheck + 单元测试。
- 不引入 changesets / release-please;不实现"重发 user 消息"的重试模式。
- 不要自动 commit,除非整个计划完成后(用户未要求分阶段提交);新仓库的 `git init` 可以做。

## Review Focus
- 同一失败连发 `session.step.failed` 与 `session.execution.failed` → 只发一条"继续"。
- 持续被拦截(续写后立刻又失败)→ 达到 `maxRetries` 后停止并弹提示,不再发送。
- 失败之间有正常完成的 step → 计数清零(`finish: "content-filter"` 的 step 不算正常完成)。
- 用户在失败后抢先发了消息 → 插件跳过发送。
- 配置文件缺失 / JSONC 含注释与尾逗号 / 规则缺 `models` 或 `errors` → 缺失则不响应,非法规则被忽略并提示,不崩溃。
- 用户中断(`session.execution.interrupted`)→ 不触发续写。

---

### Task 1: 仓库骨架与迁移现有两个包

**Files:**
- Create: `/data/SourceCode/opencode-plugins/package.json`(`private: true`,`workspaces: ["packages/*"]`,根脚本 `typecheck`/`test` 对全部包执行)、`tsconfig.base.json`、`vitest.workspace.ts`(或各包 vitest 配置)、`.gitignore`、`README.md`
- Create: `packages/auto-model-config/`、`packages/skill-filter/`(从 `/data/SourceCode/opencode-auto-model-config`、`/data/SourceCode/opencode-skill-filter` 迁入)
- Modify: 两包的 `package.json` 的 `name`(skill-filter 改为 `@misakacloud/opencode-skill-filter`)、`repository`、`publishConfig`(`{access:"public",provenance:true}`);skill-filter 的 `bun:test` 用例改写为 vitest

**Interfaces:**
- Produces: `bun install` 后根目录 `bun run typecheck` / `bun run test` 能运行全部包;`packages/auto-retry/` 的目录由 Task 2 创建。

- [ ] **Step 1:** `git init` 新仓库;建立根 `package.json`、`tsconfig.base.json`(`target ES2022, module ESNext, moduleResolution bundler, strict true`,各包 tsconfig extends 它)。
- [ ] **Step 2:** 用 `git subtree add`(或 filter-repo 后合并)把两个旧仓库迁入 `packages/*` 并保留历史;迁完两者原有测试在新位置仍能通过。
- [ ] **Step 3:** 修改两包 `package.json`(name、repository 指向 `https://github.com/chisaato/opencode-plugins.git`、`repository.directory`、`publishConfig`);skill-filter 的 `bun:test` 用例改写为 vitest,`bun test` 脚本改为 `vitest run`。
- [ ] **Step 4:** 运行 `bun install && bun run typecheck && bun run test`,预期全部通过(两包的 smoke 用例保留为本地手动脚本,不进根 test)。

### Task 2: opencode-auto-retry 包

**Files:**
- Create: `packages/auto-retry/package.json`、`tsconfig.json`、`index.ts`(`export { default } from "./src/index"`)
- Create: `packages/auto-retry/src/index.ts`(`Plugin.define({ id: "opencode-auto-retry", setup(ctx) })`)
- Create: `src/config/jsonc.ts`(参考 skill-filter 的 `src/config/jsonc.ts`,支持注释与尾逗号)、`src/config/loader.ts`、`src/config/schema.ts`
- Create: `src/match.ts`、`src/state.ts`、`src/handler.ts`、`src/utils/paths.ts`、`src/utils/logger.ts`(路径与日志参考现有包的 `src/utils/`)
- Test: `packages/auto-retry/test/*.test.ts`(vitest)

**Interfaces:**
- `loadConfig(opts: { projectDir: string; homeDir?: string }): Promise<ResolvedConfig>` — 缺文件/`enabled:false`/空 `rules` 返回 `rules: []`;项目文件的 `rules` 整体覆盖全局;非法规则(缺 `models` 或 `errors`)被剔除并通过 logger 提示;`defaults` 合并进每条规则。
- `type Rule = { models: string[]; errors: string[]; prompt: string; maxRetries: number; delayMs: number }`
- `matchRule(rules: Rule[], input: { model: string; errorMessage: string }): Rule | undefined` — `model` 为 `provider/model`,`models` 支持 `*` 通配,`errors` 为子串;从上到下第一条同时命中的规则。
- `createState()`:提供 `recordFailure(sessionID, ruleIndex): number`(返回当前连续失败数)、`recordProgress(sessionID): void`(清零)、`shouldHandle(sessionID, failureKey): boolean`(同一失败的重复事件只处理一次)。
- `createHandler(deps)`:订阅 `ctx.event.subscribe()` 的事件流,依据事件类型分派;`deps` 注入 `session.prompt`、`session.get`/消息读取、`notify`、`config`、`logger`,便于单测。

- [ ] **Step 1: 写失败测试(配置)** — `loader.test.ts`:无文件 → `rules` 为空;JSONC 含注释/尾逗号可解析;项目覆盖全局;规则缺 `models` 被剔除;`enabled:false` → 空。
- [ ] **Step 2: 写失败测试(匹配与状态)** — `match.test.ts`:`google/*` 命中 `google/gemini-3-pro`、不命中 `anthropic/claude`;`errors` 子串;第一条命中的生效。`state.test.ts`:连续失败递增、`recordProgress` 清零、同一 failureKey 只处理一次。
- [ ] **Step 3: 写失败测试(处理器,用假事件流和假 `session.prompt`)** — 覆盖 Review Focus 的全部六条:连发两个事件只发一次;连续失败 `maxRetries` 次后不再发并调用 `notify` 一次;失败之间的正常 step 使计数清零,而 `finish:"content-filter"` 的 step 不清零;失败后出现新的用户消息 → 跳过;中断事件 → 不发;无规则命中 → 不发且不访问 `session.prompt`。
- [ ] **Step 4:** 运行 `bunx vitest run packages/auto-retry`,预期失败(模块未定义)。
- [ ] **Step 5:** 实现以上模块。触发依据:事件的 `error.type === "provider.content-filter"` 且命中规则的 `errors`/`models`;模型取失败消息(`assistantMessageID`)所属请求的模型,取不到回退 `session.get().model`,都取不到视为不命中;发送前等待 `delayMs`,再复查失败之后是否出现新的用户消息;发送 `ctx.session.prompt({ sessionID, text: rule.prompt })`。子会话与主会话同样处理。**先对照真实类型确认事件名与 payload(`session.step.failed` / `session.execution.failed` / `session.step.ended` / `session.execution.interrupted`)和 `prompt` 能否指定模型**,差异记在 `packages/auto-retry/README.md` 的"已知限制"。
- [ ] **Step 6:** 运行 `bunx vitest run packages/auto-retry` 与 `bun run typecheck`,预期通过。
- [ ] **Step 7:** 写 `packages/auto-retry/README.md`:配置示例(jsonc)、行为说明、已知限制、安装方式(`opencode.json` 的 `plugin` 写法以现有两个包 README 为准)。

### Task 3: CI 与可信发布

**Files:**
- Create: `.github/workflows/ci.yml`、`.github/workflows/publish.yml`
- Reference: `/data/SourceCode/opencode-auto-model-config/.github/workflows/npm-publish.yml`(迁入后可能在 `packages/auto-model-config` 下,以实际为准)

**Interfaces:**
- `ci.yml`:`push`(main)与 `pull_request` 时 `bun install --frozen-lockfile && bun run typecheck && bun run test`。
- `publish.yml`:触发 `push.tags: ["*@*"]` 与 `workflow_dispatch`(入参 `dry_run: boolean`、`package: string`);`permissions: { id-token: write, contents: read }`;步骤:checkout → setup-node(registry-url npmjs)→ `npm install -g npm@latest` → setup-bun → 安装 → typecheck/test → 解析 tag(`<dir>@<version>`,`dir` 是 `packages/` 下目录名)→ 校验该包 `package.json` 的 `version` 与 tag 一致,不一致失败 → 在该包目录执行 `npm publish --access public`(dry run 时用 `bun pm pack --dry-run`)→ 把包名与版本写进 `$GITHUB_STEP_SUMMARY`。不使用 `NPM_TOKEN`。

- [ ] **Step 1:** 编写两个 workflow;tag 解析与版本校验写成独立可测的脚本 `scripts/resolve-publish-target.ts`,给出 `resolvePublishTarget(tag: string): { dir: string; version: string }`,并加 vitest 用例(合法 tag、缺版本、未知目录)。
- [ ] **Step 2:** 用 `actionlint`(若可用)检查 workflow;运行 `bunx vitest run scripts`,预期通过。
- [ ] **Step 3:** 在 README 写"发布步骤":先改包 `package.json` 版本 → 打 tag `auto-retry@0.1.0` → 推送;并列出需要用户手动完成的事(npmjs.com 上给每个包配置可信发布,指向 `chisaato/opencode-plugins` 的 `publish.yml`;把已发布的 auto-model-config 的绑定改指向新仓库;创建 GitHub 仓库并推送;归档旧仓库)。

### Task 4: 汇总验证与收尾

- [ ] **Step 1:** 在新仓库根目录运行 `bun install --frozen-lockfile && bun run typecheck && bun run test`,预期全部通过。
- [ ] **Step 2:** 用真实 OpenCode(v2)做一次手动验证并记录:写一份指向 `google/*` 的 `auto-retry.jsonc`,构造/等待一次 "Provider blocked the response",确认只发出一条"继续"且可见;验证 `prompt` 的发送时机与模型问题;结果写进 auto-retry README 的"已验证"小节。无法构造时如实标注"未实测"。
- [ ] **Step 3:** 全部任务完成后一次性提交(若用户同意),并向用户列出手动待办。

## 并行方案
Task 1 的 Step 1(骨架)先完成,之后 Task 1 的迁移(Step 2-4)、Task 2、Task 3 三条线的写入目录互不重叠(`packages/auto-model-config`+`packages/skill-filter`、`packages/auto-retry`、`.github`+`scripts`),可并行;Task 2 的 Step 5 需要骨架的根配置和 vitest 配置先就位。Task 4 在三条线汇合后做。
