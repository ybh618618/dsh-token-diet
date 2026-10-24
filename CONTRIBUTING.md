# 贡献指南

感谢参与 `dsh-token-diet`。这是一个 DeepSeek Harness（dsh）插件，包含 Host 端（Node）和 Web 端
（浏览器里的单文件 JS bundle）两半。提 PR 前请先读 [架构与模块契约](docs/ARCHITECTURE.md) 与
[开发](docs/DEVELOPMENT.md)。

## 开发环境

- Node.js ≥ 22（CI 使用 Node 24）。
- pnpm：工作区由 `pnpm-workspace.yaml` 定义，直接 `pnpm install --frozen-lockfile`；没有 pnpm 时用
  `corepack enable` 或 `npm install -g pnpm`。插件本体没有运行时依赖，装完只为跑脚本和测试。
- 不需要安装 dsh 即可跑构建与测试；要在真实界面里验收才需要本地 dsh。

```bash
pnpm install --frozen-lockfile
npm run build     # 重新生成 packages/token-diet/lib/client.js
npm run check     # 语法检查
npm test          # 60 个测试
```

首次接触代码建议按这个顺序读：`packages/token-diet/lib/index.js`（Host 装配与预算守卫）→
`lib/host/rpc.js`（RPC 方法表）→ `src/client/04-main.js`（槽位注册）→ 其余客户端源码。

## 硬性规则

- **Host 端改动需要重启 dsh**：`lib/index.js`、`lib/host/*.js` 在 dsh 启动时进入模块缓存，改完
  必须退出并重启 dsh（Desktop 退出再启动，或重启 `dsh web` 进程）才会生效。
- **客户端改动需要构建 + 刷新页面**：改 `packages/token-diet/src/client/*.js` 后必须运行
  `npm run build` 重新生成 `lib/client.js`，再刷新页面；不要手改 `lib/client.js`（生成物）。
- **不要新增会话事件类型**：dsh 的 `KNOWN_SESSION_EVENT_TYPES` 是封闭集合，预算等状态写在
  `<DSH_HOME>/token-diet/` 的 JSON 里。
- **Host 端只依赖 `node:*` 与相对导入**，客户端只 `require('react')`，不要引入 `@deepseek-ai/*`
  运行时包。
- **样式只用 dsh 主题令牌**（`--dsw-alias-*` / `--dsw-specific-*`），不写死颜色。
- **改 bug 要带回归测试**：在对应的 `test/*.test.mjs` 加一条在旧代码上会失败的断言。
- 宣传片的回放基建与渲染流水线是作者私有内容，不在本仓库，也不属于本仓库的构建或发布。

## 提交前检查

```bash
npm run build
npm run check
npm test
npm pack --dry-run --workspace packages/token-diet   # 确认发布内容没有多余文件
```

PR 描述里请写清楚：改了什么、为什么、如何验证（命令或界面截图）。涉及界面文案时，中文与英文
`locale/{zh,en}.json`、`TD.dicts` 要同步更新，且不要改动已有文案的措辞（文案是产品的一部分）。

## 许可证

贡献的代码默认按仓库的 [MIT License](LICENSE) 授权。