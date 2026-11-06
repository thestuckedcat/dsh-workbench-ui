# 第三方声明（08-workbench-ui）

本工作台自身代码为本仓库自有实现（未声明开源许可）。以下为随仓库分发或复核时使用的第三方物料。

## 1. 随仓库分发的第三方代码

| 物料 | 版本/来源 | 许可 | 位置 | 使用方式 |
|---|---|---|---|---|
| `semver` | 7.8.6，npm 包 `semver`（node-semver，作者 Isaac Z. Schlueter and Contributors） | ISC，见 `vendor/semver/LICENSE` | `vendor/semver/**` | 原字节随仓库（未修改）。固定用于 `declared_range`/`verified_versions` 的离线版本判定，不自创字符串比较。源文件摘要记录在 `source-lock.json`。 |

## 2. 只读复核、未随仓库分发、未复制代码的物料

| 物料 | 固定身份 | 许可 | 使用方式 |
|---|---|---|---|
| DeepSeek Harness（本机安装） | `0.2.1-rc.5`，exe SHA256 `7ae939b5a82b220fbd8ad04dfbafaaedb5a49ab43dc884a5db6381f678dd0cc4`，resources/app.asar SHA256 `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915` | 见安装包内 `LICENSE.electron.txt` / `LICENSES.chromium.html` 及上游仓库 | 只读解析归档、核对接口与摘要；不复制 Host 源码。工作台代码依赖其运行期公开接缝（Cordis、slots/layout、connection RPC、client module loader）。 |
| `dsh-context` 0.82.0（本机 profile 已装第三方插件） | `package.json` 版本 0.82.0，作者 bowenliang123，上游 Apache-2.0 | Apache-2.0 | 仅作为 rc.5 真实 bundle 形状的**调查对照**（manifest 字段、`cordis.patch.yml`、client 包装方式）；未复制其代码或 UI。 |
| `dsh-pet` 0.4.3、`superpowers-dsh` 0.4.0（本机 profile 已装） | 各包 `package.json` 版本 | 见各自包内 LICENSE | 仅调查对照 bundle/清单格式；未复制代码。 |
| dsh-web 固定树 | `975ba292d5803f9a4e6df6ba3c25ed44e567f3ac`（设计冻结，dsh-web-all 0.4.14） | Apache-2.0 | 仅调查对照；未合入，未作为依赖。 |

## 3. 说明

- 本仓库不包含 Harness 安装包、Electron、Node 运行时二进制；`runtime/node.exe`（测试运行时）与 `scratch/` 在 `.gitignore` 中，不随仓库分发。
- 未采用任何远程字体、图标 CDN、市场/同步/隧道服务。
- 来源与摘要的更完整记录见 `source-lock.json`、`evidence/host-rc5/source-manifest.json`、`docs/implementation-route.md`。
