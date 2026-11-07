# dsh-workbench-ui · DeepSeek Harness 本地工作台

> 08 能力：在已安装的 **DeepSeek Harness 0.2.1-rc.5** 内提供最小工作台——能力入口、非秘密状态聚合、组合诊断与可恢复的本地 profile 组合；不重写 Harness，不另做独立 Web 应用。
>
> 状态（2026-11-07）：**首版（stage A）实现并完成自测，含完整隔离 profile 装载与真实 Chromium 渲染验证**。已实现合同/门禁、fixture 双模块组合与事务恢复、Host RPC、真实 rc.5 Cordis 运行时挂载、rc.5 原生 client 工作台组件测试，并在隔离 `DSH_HOME` + `web` profile 中完成真实 profile loader 装载、`__DSH_BOOT__` client 模块图、HTTP RPC 与浏览器内面板/返回聊天/重开验证（[证据](evidence/isolated-profile/verification.json)、[截图](evidence/isolated-profile/render.png)）。**05/07 真实能力接入（T5）仍未完成、OS 出口认证未执行**；见[兼容矩阵](docs/compatibility-matrix.md)§3 与[机制说明](docs/mechanisms.md)§8。
>
> 同步仓库：<https://github.com/thestuckedcat/dsh-workbench-ui>

## 交付内容

| 路径 | 内容 |
|---|---|
| `bundle/index.js` | Host 半：Cordis 插件入口，经 `webServer` 前缀路由 + `connection.admit` 提供 `/local-workbench/<endpoint>` HTTP RPC 承载（复用固定 client-request/server-response 信封与浏览器会话准入） |
| `bundle/client.js` | client 半：rc.5 原生 `window.__ModuleLoader__.load` 模块，注册 keyed `main` 面板 + `sidebar.panellist` 入口；只 require `react` |
| `src/contracts.mjs` | 严格 v1 合同：manifest/profile/status/navigation intent/access/RPC 外壳；未知字段与越界值拒绝 |
| `src/compat.mjs` | rc.5 精确基线、归档摘要/源码接缝复核、source-lock 校验、离线固定 semver 门禁 |
| `src/resolve.mjs` / `src/conflicts.mjs` | 依赖 DAG 确定性排序、工具/slot/writer/hook 冲突、网络策略、组合摘要 |
| `src/profile-store.mjs` / `src/compose.mjs` | scratch profile 唯一 writer：revision、锁、journal、原子切换、幂等、崩溃恢复 |
| `src/access.mjs` / `src/registry.mjs` / `src/actions.mjs` / `src/rpc.mjs` / `src/http-rpc.mjs` | owner/scope 登记、descriptor 单 owner 聚合、导航 intent 校验、固定错误码 RPC 与 HTTP 承载 |
| `src/host-rc5.mjs` / `src/composition-adapter.mjs` | 本地配置、fixture descriptor、组合端点适配 |
| `tools/` | `doctor`、`source-lock`、`compose`、`restore`、真实 rc.5 Host 测试 runner、隔离 smoke、**隔离 profile + 浏览器渲染验证**（`isolated-profile-verify.mjs` / `tools/isolated-profile/`）、rc.5 归档分析工具 |
| `profile/components.json` | 已锁 fixture catalog（`fixtures:true`，`real_modules:[]`） |
| `tests/` | 157 项 node:test（155 pass / 2 skipped / 0 fail；2 项真实 Host 测试在普通 Node 下跳过，由 Electron 内嵌 Node 运行并通过）；client 36 项 |
| `docs/` | [产品形态](docs/product-form.md)、[软件设计](docs/software-design.md)、[实施路线与来源](docs/implementation-route.md)、[兼容矩阵](docs/compatibility-matrix.md)、[恢复说明](docs/restore.md)、[机制说明](docs/mechanisms.md) |
| `evidence/` | rc.5 源清单/接缝证据、真实 Host 测试 TAP/JSON、完整测试 TAP/摘要、总体验证记录，以及[隔离 profile + 浏览器渲染证据](evidence/isolated-profile/verification.json)与截图 |

## 边界（首版明确不做）

- 不代替 05/07/06/03/04/02/01 的底层数据、执行或权限；本仓库不保存任何业务数据与凭据。
- 不读写用户真实 `C:\Users\admin\.dsh` profile；组合事务只写本工具创建的 scratch 目录（带 `.workbench-profile` 标记）。
- 无网络运行路径：无市场/下载/更新/字体 CDN/通知/同步/隧道；不调用模型，不读 Provider key。
- 不把 `accepted`/`opened` 当作业务完成；fixture 不冒称真实能力可用。
- 不做热卸载半切换：组合写入返回 `restart_required`，由下一次隔离启动验证。

## 快速开始（只读/隔离）

前置：本机已安装 DeepSeek Harness `0.2.1-rc.5`（`E:\dsh`）。以下命令在仓库根目录运行，使用已固定测试运行时（未随仓库分发，需从本机复制 Node 26.13.0 到 `runtime/node.exe`）。

```powershell
.\runtime\node.exe tools\doctor.mjs --isolated --host 0.2.1-rc.5
.\runtime\node.exe tools\run-all-tests.mjs
.\runtime\node.exe tools\compose.mjs --fixture --out .\scratch\compose-smoke
.\runtime\node.exe tools\restore.mjs --scratch .\scratch\compose-smoke --dry-run
.\runtime\node.exe tools\test-rc5-host.mjs
.\runtime\node.exe tools\isolated-profile-verify.mjs
.\runtime\node.exe tools\smoke.mjs --isolated --fixture --network-evidence
```

- `tools/test-rc5-host.mjs`：用已安装 Electron 的内嵌 Node 24.21.0 运行真实 rc.5 Cordis 生命周期测试（合成 Host services 替身）。
- `tools/isolated-profile-verify.mjs`：在 `scratch/isolated-profile/` 创建隔离 `DSH_HOME` + `web` profile，真实启动 rc.5 `dsh web`，验证 `__DSH_BOOT__` client 模块图与客户端字节，再用本机 Electron/Chromium 打开面板、验证 fixture 横幅/owner 版本/返回聊天/重开并截图；写出 `evidence/isolated-profile/verification.json`。
- `tools/smoke.mjs`：汇总已证明/未证明层并输出 `evidence/verification.json`。

## 安装到 Harness 的方式（首版未执行真实安装）

本仓库 root `package.json` 是最小 bundle 包（`dsh.bundle.patch` → `cordis.patch.yml`；`dsh.client.inject` 声明 client 依赖；`exports["./client"]`）。真实安装/启用需要：隔离 `DSH_HOME`、把本包作为 profile bundle 引入、提供 `$DSH_HOME/workbench/workbench.json`（见 `src/host-rc5.mjs` 的严格配置 schema），然后由下一次启动装载验证。`tools/isolated-profile-verify.mjs` 已按该方式在隔离 profile 中验证 bundle 装载与浏览器渲染；但**没有写入用户真实 profile/Dsh 安装**，不得把本仓库当作已全局生效插件。

## 工作区说明

本仓库是 `E:\dsh\plugin` 八能力工作区的第 08 项，随仓库保留自己的设计与证据。设计文档中指向工作区级文档（如 `../../docs/design-review-surfaces.md`）的链接只在完整工作区可解析；本仓库内可读的交付文档见 `docs/`。

## 许可

自有代码未声明开源许可（UNLICENSED）；第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
