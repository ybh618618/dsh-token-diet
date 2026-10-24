# 发布流程

本文面向维护者，描述如何把 `packages/token-diet` 发布到 npm、如何用 GitHub Release 触发发布，
以及把演示素材挂到 Release。日常开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 发布机制（一次配置，之后只用发 Release）

- **触发**：在 GitHub 上 **Publish release**（不是推 tag）。workflow 会校验 release 的 tag 与
  `packages/token-diet/package.json` 的 `version` 一致，不一致直接失败。
- **认证**：npm **OIDC 可信发布**（trusted publishing），仓库里不存任何 npm token。
  runner 用 `id-token: write` 把自己的 OIDC token 交给 npm，换一次性的发布凭据，
  并自动附上 `--provenance` 证明。
- **工作流**：[`.github/workflows/publish.yml`](.github/workflows/publish.yml)（文件名必须与 npm 上
  登记的完全一致：`publish.yml`）。

### npm 侧只需配置一次

在 <https://www.npmjs.com/package/dsh-token-diet/access> → **Trusted publishing** 添加：

| 字段 | 值 |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `ybh618618` |
| Repository | `dsh-token-diet` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

> 首次发布（包还不存在时）用一次性 token 手动发一次，之后才能在包设置里添加 trusted publisher。

## 第一次发布（包尚不存在时）

```bash
# 一次性 token，只在创建包时用；发完立刻在 npm 后台吊销
NPM_TOKEN=<temporary token>
cd packages/token-diet
npm publish --access public --provenance=false      # 没有 npm 时：pnpm publish --access public
```

发布后到 `https://www.npmjs.com/package/dsh-token-diet/access` 添加上面的 trusted publisher，
并吊销那把临时 token。此后所有版本都走 Release。

## 发一个新版本

```bash
# 1. 改版本号（两处必须一致）
#    package.json 与 packages/token-diet/package.json 的 version
# 2. 跑门禁
pnpm install --frozen-lockfile && npm run build && npm run check && npm test
# 3. 提交并打 tag
git add -A && git commit -m "chore: release v0.1.1"
git tag v0.1.1 && git push origin main --tags
# 4. 创建 release —— 这一步才真正发布
gh release create v0.1.1 --title "dsh-token-diet v0.1.1" --generate-notes
```

`gh release create` 触发 workflow：安装 → 构建 → 语法检查 → 57 个测试 → `npm pack --dry-run` →
版本号与 tag 校验 → `npm publish --provenance --access public`。

想先演练一次而不发布：Actions 页面手动运行 **Publish to npm**，`mode` 选 `verify`。

## 发布门禁

在干净的工作区按顺序跑完整套：

```bash
pnpm install --frozen-lockfile
npm run build
npm run check
npm test
```

必须全部通过（当前 57 个测试）。`lib/client.js` 是生成物，发布前必须由 `npm run build` 重新生成，
不要手改。

## 打包检查

`files` 只发布运行时需要的文件。发布前检查 tarball，确认没有测试、脚本或 `src/` 混进去：

```bash
npm pack --dry-run --workspace packages/token-diet
```

期望的运行时文件（共 15 个，约 84 KB）：

- `lib/index.js`、`lib/client.js`
- `lib/host/*.js`（`budget`、`index-store`、`pricing`、`rates`、`rpc`、`store`）
- `lib/shared/billing.js`
- `locale/zh.json`、`locale/en.json`
- `icon.svg`、`cordis.patch.yml`
- `package.json`、`LICENSE`

本机没有 npm 时，用 `pnpm pack --pack-destination dist packages/token-diet` 生成 tarball 后解压核对。

## 发布后验证

- npm 包页面：<https://www.npmjs.com/package/dsh-token-diet>
- 检查版本、README、LICENSE、keywords 与 provenance 徽章；
- 在干净的 dsh 环境执行 `dsh plugin add dsh-token-diet`，确认侧边栏入口与预算框出现；
- 若要撤回版本，npm 只允许在 72 小时内 `npm unpublish`，优先发一个修复版本。

## 把演示视频 / GIF 挂到 GitHub Release

`docs/media/` 的 GIF 与总览图随仓库提交；完整宣传片视频随 Release 上传（视频工程是私有内容，
不在本仓库）：

```bash
gh release upload v0.1.1 \
  token-diet-promo-1080p.mp4 \
  token-diet-promo-45s.mp4
```

素材要求见 [docs/media/README.md](docs/media/README.md)。

## 维护者清单

- 许可证持有人：`LICENSE` 与 `packages/token-diet/LICENSE` 目前是
  `Copyright (c) 2026 dsh-token-diet contributors`；要写个人或公司名时两处一起改。
- npm 包名：不带 scope 的 `dsh-token-diet`（已确认可用）；若改用 scope，需要同步
  `packages/token-diet/package.json` 的 `name` 与 README/INSTALL 的安装命令，并重新配置 trusted publisher。
- 仓库地址已指向 `https://github.com/ybh618618/dsh-token-diet`。