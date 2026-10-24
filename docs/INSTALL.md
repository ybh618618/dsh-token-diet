# 安装 / 更新 dsh-token-diet

插件目录：`packages/token-diet`（包名 `dsh-token-diet`）。

文档：[README](../README.md) · [架构与模块契约](ARCHITECTURE.md) · [安装与自检](INSTALL.md) · [开发](DEVELOPMENT.md)

## 首次安装

从 npm 安装：

```bash
dsh plugin add dsh-token-diet
```

从仓库目录安装（在仓库根目录执行；也可以指定 profile）：

```bash
dsh plugin add ./packages/token-diet
dsh plugin --profile desktop add ./packages/token-diet
```

或在 Desktop 的「插件 → 已安装」里用「从目录安装」选择 `packages/token-diet`。安装后侧边栏
「自动化任务」下方出现「Token 统计」，输入框模型名右侧出现预算输入框。

## 更新（改动 Host 端代码后必须做）

Host 端（`lib/index.js`、`lib/host/*.js`）由 dsh 进程在启动时载入并缓存在模块表里，**改完之后必须重启
dsh** 才会生效；只改客户端（`src/client/*.js` + 重新构建 `lib/client.js`）可以靠页面刷新 + HMR 生效。

```bash
# 1. 重新生成浏览器包（改了 src/client/*.js 才需要）
node scripts/build-client.mjs

# 2. 让 dsh 重新读取 Host 模块：重启 dsh（Desktop 退出再启动，或重启 dsh web 进程）
```

如果卸载重装：

```bash
dsh plugin remove dsh-token-diet
node scripts/build-client.mjs
dsh plugin add ./packages/token-diet
```

## 自检

```bash
# 语法 + 单元/集成测试（60 个）
node --test "test/*.test.mjs"

# 用真实会话缓存渲染整页（需要 dsh 至少跑过一次以生成 <DSH_HOME>/token-diet/*.json；缓存不存在时自动跳过）
node --test test/real-data.test.mjs
```

Host 起来后 `<DSH_HOME>/token-diet/` 下会出现：

| 文件 | 期望 |
| --- | --- |
| `index.v1.json` | 有 `sessions`，数量接近本机会话数 |
| `prices.v1.json` | `providers` 有 200+ 个供应商 |
| `rate.v1.json` | `automatic.cnyPerUsd` 在 5–10 之间，`source` 是 `open.er-api.com` 或 `frankfurter` |

RPC 通道自检（未登录会返回 401，说明通道已注册；返回 405 说明 Host 还是旧模块，需要重启）：

```bash
# 把 65243 换成 dsh web 实际监听的端口
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:65243/token-diet/indexStatus \
  -H "content-type: application/json" \
  --data '{"type":"client-request","rpcId":"t1","method":"indexStatus","payload":{}}'
```

- `401` → 通道已注册且鉴权在工作（正常）
- `405` → Host 仍是旧模块代，重启 dsh
