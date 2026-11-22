# npm Trusted Publisher 配置说明

本仓库通过 GitHub Actions 的 OIDC 向 npm 做可信发布（trusted publishing），不使用任何静态 npm token。发布流程、tag 约定与版本规则见 [RELEASING.md](./RELEASING.md)；本文只讲 npmjs.com 侧需要手工配置什么。

## Workflow

- GitHub 仓库：`chisaato/opencode-plugins`
- workflow 文件名：`publish.yml`（`.github/workflows/publish.yml`）
- GitHub Environment：`npm-publish`（workflow 已声明；在 npm 侧属于可选字段）

发布入口有两种，最终都走 `publish.yml`：

1. 推送形如 `<目录名>@<semver>` 的 tag（例如 `auto-retry@0.1.1`，目录名是 `packages/` 下的文件夹名，不是 npm 包名，也不要加 `v` 前缀）。
2. 在 GitHub Actions 手动运行 `publish.yml`，填 `package`（目录名）与 `version`（semver）。

## 在 npmjs.com 上需要配置的字段

每个要发布的包，在 `https://www.npmjs.com/package/<包名>/settings`（Settings → Trusted Publisher）添加一次，字段如下：

| 字段 | 填写值 |
| --- | --- |
| Repository owner | `chisaato` |
| Repository name | `opencode-plugins` |
| Workflow filename | `publish.yml` |
| Environment（可选） | `npm-publish`（若填写，必须与 workflow 中声明的完全一致；留空则不按 environment 限制） |

workflow 文件名**必须**是 `publish.yml`。npm 按这四个字段校验 OIDC 声明，任意一项不符发布会直接被 npm 拒绝；也不要另建其他发布 workflow，否则同一 tag 会触发两条管线互相竞争。

同时在同页的 **Package access → Publishing access** 中，选择 **Require two-factor authentication and disallow bypass 2fa tokens (recommended)**，禁止使用可绕过 2FA 的 granular access token。

已经配置过可信发布的包不需要重复配置。

## 待发布包清单

按下表逐一在 npmjs.com 配置（`目录名` 即 tag 里 `@` 前面的部分）：

| 目录名（tag 用） | npm 包名 |
| --- | --- |
| `auto-model-config` | `@misakacloud/opencode-auto-model-config` |
| `skill-filter` | `@misakacloud/opencode-skill-filter` |
| `auto-retry` | `@misakacloud/opencode-auto-retry` |
| `model-prompts` | `@misakacloud/opencode-model-prompts` |
| `compact-enhance` | `@misakacloud/opencode-compact-enhance` |
| `mux-core` | `@misakacloud/opencode-mux-core` |
| `mux` | `@misakacloud/opencode-mux` |
| `openchamber-mux` | `@misakacloud/openchamber-mux` |

注意 `openchamber-mux` 的包名没有 `opencode-` 前缀，其余均为 `@misakacloud/opencode-<目录名>`。

## 版本选择

仓库里各包 `package.json` 的 `version` 只是开发占位，发布版本只由 tag（或手动填写的 version）决定。

- `compact-enhance`、`mux-core`、`mux` 与 `openchamber-mux` 已人工发布过 `0.1.0`，后续走 CI 时从 **`0.1.1`** 开始（例如 tag `mux-core@0.1.1`），避免与已发布的 `0.1.0` 冲突。
- `auto-model-config` 曾从别的仓库发布过，npm 上可能已有历史版本；首次用 CI 发布前先 `npm view @misakacloud/opencode-auto-model-config versions` 确认，选一个未占用的版本。
- 若未来新增包，首次发布从 `0.1.0` 起即可；同一版本号一经发布不能复用，npm 会拒绝重复版本。
- 预发布号（如 `0.2.0-beta.1`）会以 `--tag next` 发布，不占用 `latest`，详见 RELEASING.md 的 tag 约定。

## 首次发布检查单

1. 在 npmjs.com 为目标包按上表配置 trusted publisher。
2. 确认目标提交已在 `origin/main` 历史上。
3. 打 tag 并推送，例如：`git tag auto-retry@0.1.1 && git push origin auto-retry@0.1.1`。
4. 若想先验证而不发布，可在 Actions 手动运行 `publish.yml`，勾选 `dry_run`：只会改写本次 checkout 里的版本并执行 `npm pack --dry-run`，不真正发布。
5. 可选：在 GitHub Settings → Environments → `npm-publish` 添加 Required reviewers，发布前先等人批准。
