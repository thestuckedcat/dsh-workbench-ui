# 08 兼容矩阵与实施偏差

版本：2026-11-07；状态：首版（stage A）实现完成，并通过本地组件、真实 rc.5 Cordis、**隔离完整 profile loader 与真实 Chromium 渲染**自测；真实 05/07 能力接入（T5）与 OS 出口认证仍未验证。证据见[总体验证记录](../evidence/verification.json)、[完整测试摘要](../evidence/test-summary.json)、[真实 Host 运行证据](../evidence/host-rc5/host24.json)、[隔离 profile + 浏览器渲染证据](../evidence/isolated-profile/verification.json)（[截图](../evidence/isolated-profile/render.png)）与[rc.5 源清单](../evidence/host-rc5/source-manifest.json)。

## 1. Host 基线（精确白名单）

| 项 | 锁定值 | 实际核对 |
|---|---|---|
| Harness 版本 | `0.2.1-rc.5`（build `d4db512a969fccf0c5cc7ec8fe38e9c1d27af916`） | `tools/doctor.mjs --isolated` 放行 |
| Electron / 内嵌 Node | 44.7.0 / 24.21.0 | 真实 Host 测试与隔离 `dsh web` 启动均使用内嵌 Node 24.21.0 |
| `DeepSeek Harness.exe` SHA256 | `7ae939b5a82b220fbd8ad04dfbafaaedb5a49ab43dc884a5db6381f678dd0cc4` | 实测一致 |
| `resources/app.asar` SHA256 | `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915` | 实测一致 |
| 测试运行时 | 固定 `runtime/node.exe` v26.13.0，SHA256 `14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5` | 组件测试使用 |
| 渲染探针 | 本机 `C:\Users\admin\.dsh\electron\electron.exe`（43.3.0，通用 Electron/Chromium） | 仅测试工具，不随包分发、不构成运行时依赖 |
| 版本门禁 | 只承认 `host.version === '0.2.1-rc.5'` 且 `verified_versions` 含该版本且 `declared_range` 接受（离线固定 semver 7.8.6） | 未来 alpha/未知导出均 `needs_verification`/拒绝 |

## 2. 已核 rc.5 接缝（只读归档，SHA 全部复核）

| 归档内文件 | 复核 SHA256 | 绑定事实 |
|---|---|---|
| `dsh-client-modules/lib/client.js` | `426084f8…ffa44` | `window.__ModuleLoader__.load({id,factory})` 懒注册；factory(require) |
| `dsh-client-modules/lib/index.js` | `a2a33e32…7ec` | Host 半扫描 `dsh.client`、组装 `__DSH_BOOT__` graph、服务 client 组合脚本 |
| `dsh-client-ui-layout/lib/client.js` | `eb011a7b…587` | `ctx.layout.selectPanel(panelId|null)`；main 为 keyed/root；`hasMainPanel` 以 `entry.options.key` 判定 |
| `dsh-client-ui-renderer/lib/client.js` | `dbdb3f26…356` | `ctx.slots`（SlotRegistry）、`slots.register(options, component)` |
| `dsh-client-ui-sidebar/lib/client.js` | `f5cd3c44…a4b` | `sidebar.panellist` 行点击调用 `selectPanel(id)`；id 必须等于 main key |
| `dsh-client-connection/lib/index.js` | `0ebcca75…684` | `rpc.handle`/`rpc.intercept` 注册经过 connection fiber，消费方 context 不可用（运行验证）；`connection.admit(request)` 是实际可用的浏览器会话准入接缝；`handler(endpoint, payload, signal, peer)`；浏览器会话为 owner principal |
| `dsh-client-connection/lib/client.browser.js` | `dfc3544e…62` | 浏览器 `ctx.provide("connection", handle)`；`rpc.call(channel,endpoint,payload,signal)` 返回 `{ok,value}\|{ok,error}` |
| `dsh-host-webserver/lib/index.js` | `08907285…3ab` | `ctx.webServer.register({kind:"prefix"|"exact", path, handler})` 路由注册与 disposer；重复 (kind,path) 抛错 |
| `dsh-app-boot/lib/index.js` | `5135179a…e76` | profile/bundle patch 解析、隔离 `DSH_HOME` 与启动入口 |
| `dsh-web-app/lib/index.js` | `6662ca71…e84` | Web 面 bundle 装载 client 模块 |
| `dsh-web-frontend/dist/assets/index-BXV-oxvX.js` | `0f3fc6b8…2ef0` | client 静态种子（react/react-dom/cordis/zod/ui-primitives 等） |

client 静态种子（web shell 提供，无需注入声明）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。本工作台只 require `react`。

## 3. 分层验证状态

| 层 | 状态 | 证据/限制 |
|---|---|---|
| 严格合同/schema（manifest/profile/status/intent/access/RPC） | ✅ 组件通过 | `tests/compat.test.mjs`；未知字段/URL/绝对路径/超限拒绝 |
| 普通 Node 26.13.0 全量测试 | ✅ 157 项（155 pass / 2 skipped / 0 fail） | `tools/run-all-tests.mjs`；`evidence/tests.tap`、`evidence/test-summary.json`；2 项真实 Host 测试按设计跳过 |
| 版本与供应链门禁 | ✅ | `tools/doctor.mjs --isolated --host 0.2.1-rc.5` exit 0；未来 alpha exit 2 |
| fixture 双模块组合/冲突/事务恢复（T2/T3） | ✅ 组件通过 | `tests/resolve.test.mjs`（18）、`tests/conflicts.test.mjs`（15）、`tests/compose.test.mjs`（21） |
| fixture 组合 scratch CLI | ✅ | `tools/compose.mjs --fixture --out …` 输出 `restart_required`（需宿主重启）或显式本地验证 `active`；重复执行 `NO_CHANGE` |
| Host RPC/registry/actions/access/HTTP carrier 组件 | ✅ | `tests/registry.test.mjs`、`tests/actions.test.mjs`、`tests/rpc.test.mjs`、`tests/http-rpc.test.mjs` |
| 真实 rc.5 Cordis 生命周期（内嵌 Node 24.21.0） | ✅（合成 Host services 替身） | `tools/test-rc5-host.mjs`：真实 Context 挂载/HTTP 载体调用/卸载 Host 插件 |
| 客户端 bundle 组件行为（rc.5 原生格式、main/panellist、轮询/导航/预览、catalog 版本展示） | ✅ | `tests/client.test.mjs`（36）；`tools/smoke.mjs` 静态契约检查 |
| **完整 profile loader 装载本 bundle** | ✅（隔离 fixture profile） | `tools/isolated-profile-verify.mjs`：隔离 `DSH_HOME` + `web` profile（`dsh-base` + `dsh-web-app` + 本 bundle），真实 `dsh web` 启动；`__DSH_BOOT__` 71 个 client 插件中含 `@local/dsh-workbench-ui`，其 `inject` 与 `package.json` 的 `dsh.client.inject` 一致；真实 web server 返回 66,652 字节 client bundle（评审字节为精确前缀，combo server 追加 source-map 引用） |
| **浏览器内真实渲染/交互** | ✅（fixture 阶段，Chromium 1400×900） | 侧栏入口→面板打开→fixture 横幅→两张卡片显示 owner 版本 `0.0.0-fixture`→返回聊天→重开面板；DOM 文本断言与截图见 `evidence/isolated-profile/verification.json` / `render.png`。宿主自身首次运行/登录引导层可能覆盖截图，属宿主 UI，非本插件 |
| 05/07 真实能力接入（T5） | ⛔ blocked | 05 未完成完整 Host/UI release；07 未实现；catalog `real_modules: []`，禁止 fixture 冒称 |
| 06/03/04/02/01 后续接入（T6） | ⛔ blocked（接口已备） | 无已验证 release；兼容矩阵和 descriptor 注册接口就绪 |
| OS 出口认证 | ❌ 未执行 | 仅静态扫描无 network/spawn/eval 与固定 reason code 脱敏；不等于 OS 范围认证 |

## 4. 与设计文档的局部偏差（均有意、可审）

1. **文件扩展名**：设计列出的 `bundle/index.ts`、`bundle/client.tsx`、`ui/*.tsx` 需 TS/React 构建链。为避免引入未审核下载链，Host 半为 Node ESM `bundle/index.js`；client 半为 rc.5 原生 `window.__ModuleLoader__.load` 单文件 `bundle/client.js`（只用 `require('react')` 与 `React.createElement`，CSS 由 factory 注入并在 dispose 清理）。合同与行为不变。
2. **RPC 承载方式（运行验证后修正）**：设计 §6 假定 `ctx.connection.rpc.handle('/local-workbench', handler)` 可用。隔离启动实测该接缝在消费方 context 抛出 `cannot get property "webServer" without inject`（注册使用 connection 自身 fiber），共享 `/api` interceptor 又为单 owner（`shared RPC channel "/api" already has an interceptor`）。实现改用已审源码中的 `ctx.webServer.register({kind:"prefix", path:"/local-workbench", handler})` + `ctx.connection.admit(req)`，并继续使用冻结的 `client-request`/`server-response` 信封与 `rpc.call` 客户端 API；peer/owner 与浏览器会话准入不变。载波模块见 `src/http-rpc.mjs`。
3. **新增只读端点 `context.list`**：统一请求外壳要求 `context_ref`，但首次发现上下文前客户端还没有真实 id。为保证 owner/scope 仍由 Host 决定，`context.list` 允许保留字 `context_ref:'bootstrap'`；其他端点一律 `CONTEXT_UNBOUND`。该端点只返回已登记上下文与展示字段，不扩大权限。
4. **data 字段扩展**：`context.list` 增加 `fixture_mode:boolean`、只读 catalog 摘要 `modules:[{module_id,name,release_version,entry_kind,fixture}]`（卡片显示 owner 版本/名称，不参与权限判定）和每行 `active:boolean`（客户端校验已登记上下文）；`status.get` 增加 `scope_ref/scope_generation/context_revision/diagnostics`，用于客户端迟到/跨代丢弃与组合诊断。均为非秘密字段。
5. **组合摘要来源统一**：Host 运行时可接受 profile 当前 `composition_digest` 覆盖值，使 descriptor intent 与 profile revision 摘要一致；未提供时退回 catalog 摘要。首版 UI 不调用 `composition.apply`，应用仍属 Host 管理入口。
6. **composition.apply 输入**：RPC input 仅 `{preview_id, expected_revision}`，`operation_id` 取请求外壳（与设计端点表一致）；内部 `applyComposition` 仍要求 operation_id。
7. **fixture 状态是可配置替身**：`fixture_status` 允许注入 state/active_operations 以验证 UI 的 busy/attention/outcome_unknown 呈现；`fixture_mode:true` 时 UI 显示“非真实能力”横幅（客户端实现）。

## 5. 回归命令

```powershell
cd E:\dsh\plugin\08-workbench-ui
.\runtime\node.exe tools\doctor.mjs --isolated --host 0.2.1-rc.5
.\runtime\node.exe tools\run-all-tests.mjs
.\runtime\node.exe tools\compose.mjs --fixture --out .\scratch\compose-smoke
.\runtime\node.exe tools\restore.mjs --scratch .\scratch\compose-smoke --dry-run
.\runtime\node.exe tools\test-rc5-host.mjs
.\runtime\node.exe tools\isolated-profile-verify.mjs
.\runtime\node.exe tools\smoke.mjs --isolated --fixture --network-evidence
```

任何 Host 版本变化、client bundle 包装格式变化、`webServer`/`connection.admit` 形状变化、真实模块 release 接入或 writer/hook/slot 变化都必须重跑受影响层并更新本矩阵与 `source-lock.json`。
