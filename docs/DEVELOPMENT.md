# 开发

面向本仓库的维护者：目录结构、构建与测试、插件配置、模块契约与硬性约束。
使用方式见 [README](../README.md)，安装与自检见 [INSTALL.md](INSTALL.md)，模块级契约见
[ARCHITECTURE.md](ARCHITECTURE.md)。

## 目录结构

```
dsh-token-diet/
├─ packages/token-diet/       可发布的插件包（npm 包名 dsh-token-diet）
│  ├─ package.json            dsh 插件清单（dsh.bundle.patch、dsh.client、exports）
│  ├─ cordis.patch.yml        向 dsh bundle 插入插件行
│  ├─ lib/index.js            Host 入口（唯一直接接触 dsh API 的适配层）
│  ├─ lib/host/               用量索引、价格、汇率、预算与 RPC（纯 node:* 实现）
│  │  ├─ index-store.js       会话日志 → 用量索引（扫描 + 实时折叠）
│  │  ├─ store.js             JSON 缓存的原子读写
│  │  ├─ pricing.js           models.dev 价格、自定义价格、模糊匹配与模型名映射
│  │  ├─ rates.js             USD→CNY 汇率
│  │  ├─ budget.js            会话预算持久化
│  │  └─ rpc.js               RPC 方法表与两种传输载体
│  ├─ lib/shared/billing.js   计费与聚合纯函数（Host 与客户端共用）
│  ├─ lib/client.js           由 scripts/build-client.mjs 生成的浏览器包（勿手改）
│  ├─ src/client/*.js         客户端源码：01-util / 02-page / 03-composer / 04-main
│  ├─ locale/{en,zh}.json     插件在插件页的标题与说明
│  ├─ LICENSE                 MIT 许可证副本
│  └─ icon.svg
├─ scripts/build-client.mjs   拼接 src/client/*.js → lib/client.js
├─ test/                      node:test，见「测试分层」
├─ docs/                      本目录；docs/media/ 放 README 演示素材（GIF 与统计页截图）
├─ .github/workflows/         CI（ci.yml）与 npm 发布（publish.yml）
├─ CONTRIBUTING.md            贡献指南
└─ RELEASING.md               发布流程
```

## 命令

在仓库根目录执行（Node 版本见 `package.json` 的 `engines`）：

```bash
npm run build                          # 重新生成 lib/client.js
npm test                               # 57 个测试：计费、价格映射、Host 集成、客户端渲染、真实数据
npm run check                          # Host 入口与客户端包的语法检查
node --test test/real-data.test.mjs    # 只用本机真实会话缓存渲染整页（无缓存时跳过）
```

改动客户端源码后**必须**跑一次 `build-client.mjs`：`lib/client.js` 是生成物，dsh 只加载它。

## 配置

写在 profile 的 bundle patch 中该插件行的 `config` 下，全部可选：

```yaml
- id: token-diet
  name: dsh-token-diet
  config:
    displayCurrency: CNY          # CNY（默认）| USD
    modelAliases:                 # 模型名 → 标准模型，优先级仅次于自定义价格
      deepseek-v4.1-flash-sg: deepseek/deepseek-flash
    providerAliases:              # 供应商 → models.dev 供应商
      my-relay: deepseek
    rateOverride: 7.2             # 固定汇率，跳过联网更新
    priceRefreshHours: 24
    budgetHoldSeconds: 300        # 超预算时挂起当前步等待「提高预算」的时长
```

其余可用键：`home`、`rateRefreshHours`、`scanBatch`。默认值见 `lib/index.js` 的
`normalizeConfig` / `DEFAULT_*` 常量。

匹配顺序（价格）：自定义价格 → **模型名映射** → provider+model 精确 → 供应商别名表 →
同名模型 → 归一化模糊匹配。详见 [ARCHITECTURE.md](ARCHITECTURE.md) 的 `pricing.js` 一节。

## 测试分层

`node --test "test/*.test.mjs"`，共 60 个：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/billing.test.mjs` | 10 | 计费/聚合/日期窗口纯函数 |
| `test/pricing.test.mjs` | 15 | 精确/别名/同名/模糊匹配、模型名映射、自定义价格优先级、目标缺失时穿透 |
| `test/usage-accounting.test.mjs` | 7 | 重试步骤只计一次、未结算步骤回退、实时折叠推进 `eventCount`、重扫不双计、按 provider/model 归属 |
| `test/host.test.mjs` | 9 | 启动、扫描、RPC 全部端点、预算守卫四种结局、子智能体继承、两种传输载体与鉴权 |
| `test/client.test.mjs` | 12 | 打包格式、插槽注册、统计页/预算输入框/弹窗在多类状态下的渲染、无泄漏文案键、金额不做二次汇率换算 |
| `test/sections.test.mjs` | 3 | 统计页各区段都出现在渲染结果里、页面根节点自带滚动容器、按模型表格显示合计与缓存读取 |
| `test/real-data.test.mjs` | 1 | 用 Host 真实产出的 `index/prices/rate` 缓存渲染整页（缓存不存在时跳过） |
| `test/helpers/harness.mjs` | — | 假 `ctx`（含 `inject`/`__satisfy`/`webServer` 替身）、临时 DSH_HOME、渲染与轮询工具 |

回归测试的惯例：每修一个真实 bug，都要在对应分层加一条会**在旧代码上失败**的断言
（例如 `usage-accounting` 的重试去重、`client` 的汇率重复换算、`sections` 的滚动容器）。

宣传片的回放基建与出片流水线是作者私有内容，已随 `promo/`、`packages/token-diet-showcase`
和对应测试一起移出本仓库，不参与本仓库的构建与发布，也不进入 `packages/token-diet` 的 npm 包。
本文档只描述插件本体。

## 模块契约与硬性约束

这些约束是插件能在 dsh 升级后继续工作的前提，改动时不要破坏：

- **Host 端只用 `node:*` 与相对导入**，不引用任何 `@deepseek-ai/*` 运行时包。dsh 升级时只需改
  `lib/index.js` 与 `lib/host/rpc.js` 里的适配点。
- **客户端是单文件、无构建依赖的普通 JS**（`window.__ModuleLoader__.load({ id, factory })`，
  `id` 必须等于包名），只 `require('react')`。样式只用 `--dsw-alias-*` / `--dsw-specific-*` 主题令牌。
- **不能新增会话事件类型**。dsh 的 `KNOWN_SESSION_EVENT_TYPES` 是封闭集合，未知类型会让会话
  重新打开时被拒绝；会话日志只由 dsh 写，插件的状态放 `<DSH_HOME>/token-diet/`。
- **传输载体**：优先 `ctx.connection.rpc.handle('/token-diet')`（自带浏览器鉴权）；Connection 服务
  不在时回落到 `webServer` 前缀路由并自行校验来源。因此入口用 `ctx.inject(['connection'])`。
- **改动生效范围**：Host 端改动需要**重启 dsh**（模块缓存按解析后的 URL 记账）；客户端改动走
  HMR / 刷新页面。重启后 `POST /token-diet/indexStatus` 返回 `200` 即正常，`401` 表示已注册但未鉴权，
  `405` 表示回落到了 SPA 载体、Host 端是旧的。
- **用量口径**：`inputTokens` 是未命中缓存的输入，`cacheReadTokens`/`cacheWriteTokens`/`outputTokens`
  各自独立；总 token 由四者相加得出，不使用 provider 的 `totalTokens`。
  一个步骤重试时 `assistant/attempt` 与 `assistant/message` 都带 usage，按 `turn/step` 只计一次
  （结算消息优先，未结算的步骤回退到最新 attempt）。

完整的方法签名、槽位与数据形状见 [ARCHITECTURE.md](ARCHITECTURE.md)。