# 最小工作台 UI 与组合独立开发计划

> 执行约定：先测装配规则，再选真实组件；本轮不安装或启动profile。

## 实施状态（2026-11-07 自测后回填）

- **已实现并自测**：Task 1（版本/source-lock/doctor）、Task 2（fixture 双模块求解/冲突/事务/恢复/CLI）、Task 3 的 Host/client 框架（真实 rc.5 Cordis 内嵌 Node 挂载、HTTP RPC 承载、client bundle 组件测试、静态出口扫描），以及**隔离完整 profile loader 装载 + 真实 Chromium 渲染/返回聊天/重开**（fixture 阶段）。
- **未执行（明确未验证）**：真实用户 profile 安装；完整键盘 Tab 旅程与窄/宽布局人工视觉走查；OS 出口认证。
- **blocked**：真实 05/07 接入（05 未有完整 Host/UI release，07 未实现）；后续 06/03/04/02/01 接入无已验证 release。
- 证据、命令与限制见[实施路线](docs/implementation-route.md)、[兼容矩阵](docs/compatibility-matrix.md)、[机制说明](docs/mechanisms.md)、`evidence/verification.json`。以下 2026-11-06 计划保留为历史任务分解，复盘以实施状态与证据为准。

2026-11-06设计入口：[software-design.md](docs/software-design.md)。用户已明确采用Harness内统一工作台；冻结rc.5原生main panel、模块descriptor、profile状态机/恢复与增量接入合同。编码和局部修改按其需求ID地图执行。

**Goal:** 为已通过验收的能力提供最小 DSH 工作台组合、明确版本门禁和冲突诊断。
**Architecture:** 交付 plugin bundle + 本地profile/组件manifest；以宿主原生侧栏为基础，只有必要时添加薄UI adapter。不重写Harness，不把全家桶作为默认实现。
**Tech Stack:** 固定 Node >=24.9、DSH安装版、Cordis bundle/profile，本地manifest与已审插件。
**Spec:** [UI组合设计](../docs/ecosystem-learning-design.md) §8—9；[共同约束](../docs/development-contract.md)。

**实施顺序更新（2026-11-04）：** 本能力排第三，接在05本地记忆和07上下文之后。先交付可独立使用的工作台框架及已验收的05/07入口；06、03、04、02、01随后按用户顺序逐项接入并各做组合回归，不等待全八完成。详细阶段门槛见[实施顺序](../docs/execution-order.md)。正式安装与已注册API测试沿用[安装验证计划](../docs/live-installation-plan.md)的现有授权。

## Global Constraints

- 已安装基线0.2.1-rc.5实施前重核。调查新版rewind要求>=0.2.2-alpha.2、web-all>=0.2.2-alpha.3；不绕过门禁、不隐式升级。
- 默认不挂市场/社区下载、GitHub同步、远程通知/relay/公网隧道/更新器，也不为皮肤开放网络。
- 当前只有文档。执行命令中的 .\runtime\node.exe（Linux ./runtime/node）及各工具由Task1离线准备并固定。
- 其他七项不需要先完成才可验证本项目；本项目用两个合成模块先证明装配规则，之后逐项接真实模块。

## Review Focus

1. 声明范围通过但真实导出/slot缺失必须拒绝而非半启动 → UI-01/03。
2. 相同工具/菜单/钩子或writer争用不能静默覆盖 → UI-02。
3. 禁用按钮仍有后台网络组件不能判通过 → UI-03。
4. profile变更失败可恢复之前组合且不碰真实用户profile → UI-02/03。
5. 关闭面板/卸载不残留订阅、进程或损坏会话数据 → UI-03。

## Task 1：组件manifest与版本 gate（UI-01）

**Files:** Create source-lock.json, package.json, profile/components.json, src/manifest.mjs, src/compat.mjs, tests/compat.test.mjs, tests/fixtures/modules/。
**Interfaces:** resolveComposition({hostVersion,capabilities,requestedModules,locks}) → {enabled,disabled,errors}；每模块含版本/摘要、提供工具/slots/writer、需要服务、网络能力及dispose要求。版本匹配使用已审离线semver实现，不自创字符串大小比较。

- [ ] 准备固定Node/DSH和两个无网络合成plugin构件，写锁校验；不下载最新真实全家桶。
- [ ] 写 UI-01：rc.5对未来alpha门槛拒绝、源码/包摘要不符拒绝、missing service/unknown module拒绝。运行 .\runtime\node.exe --test tests/compat.test.mjs，确认缺实现失败。
- [ ] 实现版本/依赖和明确服务需求校验，输出具体阻断原因；unknown不会自动转成允许，不为失败模块自动安装依赖或升级宿主。
- [ ] 复跑测试；manifest只标可装配，不把声明满足写成实际功能已兼容。

## Task 2：最小bundle与冲突可恢复装配（UI-02）

**Files:** Create src/conflicts.mjs, src/compose.mjs, bundle/index.ts, bundle/cordis.patch.yml, profile/cordis.patch.yml, tests/compose.test.mjs, tools/compose.mjs。
**Interfaces:** inspectConflicts(modules) → diagnostics；composeProfile({profileRoot,modules,expectedRevision}) → applied|conflict|denied|partial；profileRoot仅允许本工具创建的scratch目录，正式profile接入留明确部署任务。

- [ ] 写 UI-02：重复memory writer、同名工具、冲突turn hook/历史拦截、循环依赖、过期revision拒绝；发生写错时保留前版和journal。
- [ ] 实现显式选择manifest和最小bundle，用独立fixture模拟05/07，不强制依赖真实八项运行；每种动作只有一个owner。
- [ ] 运行 .\runtime\node.exe --test tests/compose.test.mjs；再运行 .\runtime\node.exe tools/compose.mjs --fixture --out ./scratch-profile，检查输出与选择一致，禁止输出所有上游子包。
- [ ] 故障注入重复执行/半写/版本冲突，验证恢复后状态明确；不自动修改C:/Users/admin/.dsh中的profile。

## Task 3：锁定宿主集成与真实模块递进（UI-03）

**Files:** Create tools/smoke.mjs, tests/network.test.mjs, tests/dispose.test.mjs, docs/compatibility-matrix.md, docs/restore.md。
**Interfaces:** smoke(manifest,{isolated:true}) → 分模块加载/功能/副作用/卸载/网络证据；不得自动启用未选模块。

- [ ] 写 UI-03：loader/slot形状不符、背景更新/下载尝试、关panel/卸载后遗留timer/进程拒绝通过；仅用模拟模块制造失败并确认测试能检出。
- [ ] 运行 .\runtime\node.exe --test tests/network.test.mjs tests/dispose.test.mjs 后启动临时宿主 .\runtime\node.exe tools/smoke.mjs --isolated --fixture，验证真实loader与两个合成plugin共存。
- [ ] 第三阶段先接入已独立验收的05/07并交付框架；随后按06→03→04→02→01逐项更新source-lock与兼容矩阵接入。未完成的能力不在界面标可用，不补假入口。
- [ ] 逐个真实组合验证网络、scope、03事件后的04/05时效、07实际上下文、卸载和会话保留。任何升级另有锁定版本/格式迁移/恢复证据，不能默认继续沿用旧结论。

## 独立交付

第三阶段独立交付工作台框架及已验收05/07的真实组合，fixture支持脱离对端的开发测试；全部模块组合是后续逐项形成的最终验收。UI不承接底层协议、索引、凭据或记忆持久层，不用一个巨型plugin替代前七项。

