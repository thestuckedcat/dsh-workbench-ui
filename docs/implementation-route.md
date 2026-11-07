# 08 工作台实施路线与来源

更新：2026-11-07。状态：正式开工。本文件按根[AGENTS.md](../../AGENTS.md)要求在编码前向用户说明路线、来源机制、隔离/状态/出口边界与首个验收动作；实现过程中只追加实际结果，不把未执行项写成已通过。

## 1. 路线（实施顺序与首个可验交付）

1. **T1 / UI-01 基线与供应链门槛。** 先为隔离真实rc.5准备只读证据：重算安装包SHA256、从app.asar解析并重算设计冻结的client/Host源码摘要、固定运行时；然后实现严格contracts、source-lock校验、版本/服务形状compat与`tools/doctor.mjs`。首个可验交付是`doctor`对rc.5放行、对未来alpha/未知导出/摘要不符明确拒绝。
2. **T2 / UI-02 最小双模块装配。** 两个无网络fixture（05/07替身）证明依赖确定顺序、重复memory writer/同名工具/同key slot/独占hook/循环依赖全部blocked，observe可共存，未选模块不启用。
3. **T3 / UI-03 scratch profile事务。** 只写本工具创建的scratch profile：revision、CAS preview、锁、journal、崩溃恢复、外部修改保留双方；重复相同组合no-op，失败回前一已验证组合。
4. **T4 / UI-04,05 原Harness内工作台。** Host半通过已审`webServer`前缀路由+`connection.admit`提供`/local-workbench/<endpoint>` HTTP RPC承载（运行验证后替换设计假定的`rpc.handle`，见兼容矩阵§4.2），client半以真实`window.__ModuleLoader__.load`格式注入`main` keyed slot与`sidebar.panellist`入口，通过真实`ctx.layout.selectPanel`打开/返回聊天；实现access/rpc/registry/actions/events、view epoch与取消。用fixture完整验证Host/client合同、隔离profile装载、浏览器渲染与卸载清理。
5. **T5 / UI-06,07 真实05/07接入。** 只在05/07有独立验收release时执行；当前05未完成、07未实现，本任务**blocked**，不以fixture冒称真实能力可用，不跳过门禁。
6. **T6 后续模块接入与T7 机制/发布。** T6按06→03→04→02→01逐项增量，当前无可接入真实release，保留接口与兼容矩阵；T7交付`docs/mechanisms.md`、`docs/restore.md`、验证记录并在已有授权内做隔离安装验证。

首个验收动作：`runtime/node.exe tools/doctor.mjs --isolated --host 0.2.1-rc.5`，随后`runtime/node.exe --test tests/compat.test.mjs`。

## 2. 来源与逐来源机制、采用方式

| 来源与固定身份 | 借鉴/依赖的机制 | 采用分类与边界 |
|---|---|---|
| 本机DeepSeek Harness `0.2.1-rc.5`（Electron 44.7.0，内嵌Node 24.21.0）；exe SHA `7ae939b5…0cc4`，app.asar SHA `e1b6f25f…6915`（实施前重算核对） | 原生bundle/profile、Cordis service/fiber/effect、client模块装载器`window.__ModuleLoader__.load({id,factory})`、`ctx.slots.inject/register`的keyed main、`ctx.layout.selectPanel/beginNavigation`、`ctx.connection.rpc.handle/call` | **直接依赖+薄适配**。只注册一个keyed main和已有slot，不注册root/sidebar单例；不复制Host代码。实施时从asar只读抽取核对源码，不修改安装目录。 |
| 同版本归档源码：`dsh-client-modules`（模块图/静态种子：react、react-dom、cordis、zod、ui-primitives等）、`dsh-client-ui-layout`（main keyed、selectPanel）、`dsh-client-ui-renderer`（slots registry）、`dsh-client-connection`（RPC外壳`{ok,value}`/`{ok,error}`、owner peer）、`dsh-client-ui-sidebar`（`sidebar.panellist`入口） | 上面列出的真实接口与生命周期 | **只读核对+按真实接口自行实现**；摘要写入`evidence/host-rc5/source-manifest.json`。未运行完整profile loader/client前不称已通过运行验收。 |
| 本机已装第三方插件包 `dsh-context@0.82.0`（Apache-2.0）、`dsh-pet@0.4.3`、`superpowers-dsh@0.4.0` | 作为已在本机rc.5实际运行的bundle样例，核对`package.json`的`dsh.bundle.patch`/`dsh.client.inject`/`exports['./client']`、`cordis.patch.yml` insert行、client bundle的`__ModuleLoader__`格式与CSS注入位置 | **仅调查对照**，不合入任何字节、不复制UI代码、不作为可依赖版本；仅用于确认08自有bundle清单格式与rc.5兼容。 |
| 设计冻结的[dsh-web固定树 `975ba292…`](https://github.com/zhu1090093659/dsh-web/tree/975ba292d5803f9a4e6df6ba3c25ed44e567f3ac)（dsh-web-all 0.4.14，Apache-2.0） | 模块化patch/工作台入口作为对照；其市场/remote bridge/GitHub扩展等附加路径不采用 | **仅调查，不合入**；对宿主要求高于rc.5，不使用version exemption绕过。保持设计结论。 |
| 05/07及后续能力 | descriptor入口、scope状态、release证据、disposer；08只消费公共合同 | **消费明确公共合同**，不复制数据库/Agent逻辑。当前05未完成、07未实现，T5 blocked。 |
| 离线固定`semver`包（本机profile已装版本，实施时固定并vendor许可证/摘要） | 版本区间判定 | **薄复用工具库**，不自创字符串比较；只用于`declared_range`/`verified_versions`门禁，不据此推断兼容。 |
| 本机ui-ux-pro-max guidance | 状态提交反馈、键盘可见焦点、内容不被固定导航遮挡 | **仅可用性原则借鉴**；不采用营销落地页/远程字体。 |

其余调查候选（RestRegular、Hindsight、Mneme、OpenViking等）不构成本轮实现来源。

## 3. 本项目必须补足的隔离、状态与出口边界

- **隔离**：测试与smoke只用本工具创建的`scratch`/隔离`DSH_HOME`，路径从可信的本地登记根解析，拒绝`..`、UNC/网络盘、重解析点/符号链接和身份变化；不读写用户真实profile，不接触`.credentials.yaml`、Provider配置、cookie/token。
- **状态**：唯一profile writer；`prepare→apply`用CAS与排他锁，revision+journal持久；`accepted/opened`不得提升为业务完成；切换scope/session时递增view epoch、abort在途、迟到响应丢弃；卸载清理订阅/timer/进程。
- **出口**：08运行路径网络mode固定`none`；无模型调用、无downloader/市场/更新/字体CDN/remote bridge/隧道；复用Host已鉴权连接，权限由Host与各owner模块再次校验；owner peer仍需scope/profile登记，不因UI显示而放行。
- **可见诚实性**：fixture与真实release分开；无真实descriptor的能力只显示“后续接入”，不画可执行假按钮；T5/T6未完成项在README、验证记录和UI状态中明确标出。

## 4. 首个验收与证据边界

- 首个验收命令：`runtime/node.exe tools/doctor.mjs --isolated --host 0.2.1-rc.5`；随后`runtime/node.exe --test tests/compat.test.mjs`。
- 分层记录：静态manifest/合同→组件测试（本机Node26固定运行时）→真实rc.5归档接口核对→隔离完整Host/client（若未运行则明示）→出口/故障恢复。任何一层缺失不能写“已完整兼容”。
- 证据文件：`evidence/host-rc5/source-manifest.json`、`evidence/verification.json`、各阶段TAP/JSON；命令、exit、pass/fail/skip和限制一并记录。

## 5. 与设计的局部偏差（实施中新增，需保留）

- 设计文件布局中的`bundle/index.ts`、`bundle/client.tsx`、`ui/*.tsx` 需要TS/React构建链。本轮不引入未经审核的构建下载链：Host半用Node ESM `bundle/index.js`；client半按rc.5真实加载器格式手写`bundle/client.js`（`window.__ModuleLoader__.load`，React通过rc.5静态种子`react`取得，CSS由factory内注入`<style>`并随disposer清理）。合同、行为与设计一致，文件扩展名变化记入兼容矩阵。
- 设计提及的“05/07真实descriptor”在T5验收，当前fixture与真实catalog分文件分字段，避免混淆。
- 统一请求外壳要求`context_ref`，首次发现上下文前客户端还没有真实id：新增保留字`context_ref:"bootstrap"`仅用于`context.list`，其他端点一律`CONTEXT_UNBOUND`；该端点只返回已登记上下文与只读catalog摘要，不扩大权限。
- `context.list` 额外返回只读 catalog 摘要（module_id/name/release_version/entry_kind/fixture），用于卡片显示 owner 版本；`status.get` 额外返回 scope_ref/scope_generation/context_revision/diagnostics 供迟到/跨代丢弃与诊断。

## 6. 实施结果（2026-11-07 自测后回填）

| 步骤 | 结果 | 证据/命令 |
|---|---|---|
| T1 基线与门禁 | 完成。exe/asar 摘要与设计冻结值一致；10 个 rc.5 接缝文件 SHA 与源码探针通过；source-lock（82 artifacts）校验通过；未来 alpha/未知导出被拒绝 | `tools/doctor.mjs --isolated --host 0.2.1-rc.5` exit 0；`tests/compat.test.mjs` 13 项；`evidence/host-rc5/source-manifest.json` |
| T2 fixture 双模块装配 | 完成。依赖确定排序（05→07）、重复 writer/同名工具/同 key slot/独占 hook/循环依赖 blocked、observe 共存、未选不启用 | `tests/resolve.test.mjs` 18 + `tests/conflicts.test.mjs` 15，全通过 |
| T3 scratch profile 事务 | 完成。stale revision 拒绝、重复 no-op、锁占用、切换崩溃恢复、外部修改保留双方、写失败保留旧 current、幂等冲突 | `tests/compose.test.mjs` 21；`tools/compose.mjs --fixture --out .\scratch\compose-smoke` exit 0（第二次 NO_CHANGE）；`tools/restore.mjs --dry-run` exit 0 |
| T4 Host/client 工作台 | 完成组件层：Host RPC/registry/actions/access/HTTP carrier + 真实 rc.5 Cordis 内嵌 Node 挂载/调用/卸载 + client bundle 模拟 rc.5 环境 36 项行为测试（含 catalog 版本展示）+ 静态出口扫描 | `tests/registry.test.mjs` 8、`tests/actions.test.mjs` 7、`tests/rpc.test.mjs` 11、`tests/http-rpc.test.mjs` 6、`tests/dispose.test.mjs` 5、`tests/network.test.mjs` 8、`tests/host-rc5.test.mjs` 12、`tests/client.test.mjs` 36；`tools/test-rc5-host.mjs` 2/2 pass |
| T4 完整 profile loader/浏览器渲染 | **完成（隔离 fixture 阶段）**：隔离 `DSH_HOME`+`web` profile 真实加载 71 个 client 插件，含本 bundle；client 字节与评审一致；真实 Chromium 打开面板/返回聊天/重开并截图 | `tools/isolated-profile-verify.mjs`；`evidence/isolated-profile/verification.json`、`render.png`；宿主首次运行引导层可能遮挡截图（已记录限制） |
| T4 RPC 承载修正（运行发现） | `rpc.handle`/`rpc.intercept` 在 rc.5 消费方 context 不可用；改用 `webServer` 前缀路由 + `connection.admit(req)` + 冻结信封；真实隔离启动验证通过 | `src/http-rpc.mjs`；`tests/http-rpc.test.mjs`；兼容矩阵 §4.2 |
| T5 真实 05/07 | **blocked**：05 未完成完整 Host/UI release；07 未实现。未用 fixture 冒称真实能力 | `tools/smoke.mjs` 的 `blocked.T5_real_05_07`；catalog `real_modules: []` |
| T6 后续模块 | **blocked**：无已验证 release；接口/兼容矩阵已备 | `tools/smoke.mjs` 的 `blocked.T6_followup_modules` |
| T7 机制/发布 | 完成首版机制说明与恢复说明；真实用户 profile 安装/发布未执行 | `docs/mechanisms.md`、`docs/restore.md`、`evidence/verification.json` |

集成自测总计：普通 Node 26.13.0 运行 157 项测试（155 pass、2 项真实 Host 测试按设计跳过、0 fail；`evidence/tests.tap`/`evidence/test-summary.json`）；真实 rc.5 内嵌 Node 24.21.0 运行 2 项全通过（`evidence/host-rc5/host24.json`）；隔离 profile loader/浏览器渲染验证通过（`evidence/isolated-profile/verification.json`）；`tools/smoke.mjs --isolated --fixture --network-evidence` 的已实现层全部 true，未验证层（真实 05/07、OS 出口认证）显式为 false。详细逐层状态见[兼容矩阵](compatibility-matrix.md)。

以上偏差与新增字段均记入[兼容矩阵](compatibility-matrix.md)第 4 节；任何后续 Host 版本/接口变化必须按 WB-DOC-01 重跑受影响层并更新证据。
