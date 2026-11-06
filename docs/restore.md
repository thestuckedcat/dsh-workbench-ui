# 08 组合恢复与回退说明

更新：2026-11-07。适用范围：本工具创建的 scratch profile（根目录带 `.workbench-profile` 标记）。**不适用于用户真实 `C:\Users\admin\.dsh` profile**；首版没有部署真实 profile 的操作，也不删除任何不属于本工具的文件。

## 1. 磁盘布局

```text
<scratch-root>/
  .workbench-profile                     # 工具创建标记（kind=workbench-scratch-profile）
  profiles/<profile_id>/
    current.json                         # 当前组合指针（revision + composition_digest + policy_digest）
    revisions/<n>/profile.json           # 该 revision 的 ProfileV1（module_refs+sha256）
    revisions/<n>/cordis.patch.yml       # 该 revision 的组合投影（scratch fixture 明确标 NOT loadable）
    journal/<operation_id>.json          # 事务 journal（prepared/staged/switching/switched/…）
    .lock                                # 单 writer 锁（pid+start token+op）
```

## 2. 正常应用流程（`tools/compose.mjs --fixture` / `composition.preview`+`apply`）

1. `prepare` 在**持锁前**校验 `expected_revision`、catalog 摘要、Host 白名单、网络策略、冲突，绑定 `preview_id + composition_digest + policy_digest + selected_ids`，TTL 10 分钟。
2. `apply` 持排他锁：复读 current → 仍匹配 preview → 写 staged revision 目录并 fsync → journal `prepared` → 原子切换 `current.json` → journal `switched` → 本地验证（重读字节/摘要）→ journal `verified`。
3. 无注入 verify 时结果固定为 `restart_required`：**写入新 revision 但明确要求下次隔离启动验证**，不谎称已 active。
4. 相同 selected 再 prepare/apply 为 `no_change`：不新增 revision；同 operation_id 同摘要返回已知结果，同 operation_id 不同摘要拒绝 `IDEMPOTENCY_CONFLICT`。

## 3. 故障与恢复

| 现场 | 判定 | 动作 |
|---|---|---|
| 只有 journal `prepared`/`staged`，current 未切换 | 切换前中止 | 删除本工具 staged 目录，保留旧 current；报告 `rolled_back`（旧组合继续有效） |
| journal `switched` 但未 `verified` | 新组合未验证 | 重核 `previous_revision` 的 profile/patch 摘要与身份，原子恢复旧 `current.json`；报告 `rolled_back` |
| current 被外部修改（revision/digest 与 journal 不符） | 外部修改 | **保留双方**：不覆盖，输出差异与 `REVISION_CONFLICT`/`partial`；等待人工处理 |
| revision 目录不可读/摘要不符 | 无法证明身份 | `partial`/`outcome_unknown`；不删除、不恢复无法验证的版本 |
| 写文件失败（磁盘满/EACCES/共享占用） | 切换前失败 | 旧 current 保持；staged 清理；报告失败原因码（无原始堆栈/路径） |
| 锁被活动进程持有/无法证明进程退出 | busy | 不抢锁，返回 `LOCKED`；只有能证明 pid 已退出（ESRCH）才清理陈旧锁 |
| apply 进程崩溃 | 下次 `recover()` | 按上表恢复并写 journal `recovered`，报告动作列表 |

恢复命令：

```powershell
cd E:\dsh\plugin\08-workbench-ui
.\runtime\node.exe tools\restore.mjs --scratch .\scratch\compose-smoke                 # 实际恢复
.\runtime\node.exe tools\restore.mjs --scratch .\scratch\compose-smoke --dry-run       # 只报告
```

恢复只切换组件组合，**不恢复 05/03 等业务数据库**，也不清理`profiles/<id>/revisions`中的历史（默认保留最近 5 个已验证组合与所有未解决 journal；当前实现按目录保留，不自动删除未解决 journal）。真实 profile 的恢复属于后续部署任务，需另行提供可审差异、备份和离线闭包证明。

## 4. 边界与已知限制

- 所有路径从可信 root 解析：拒绝相对路径、`..`、UNC/网络盘、root 外 symlink/junction、非本地盘；字符串前缀不是充分条件。
- Windows 原子替换依赖同卷 rename；共享占用失败时保持旧 current 并明确失败，不假装成功。
- 进程启动 token 用于区分“同 pid 复用”的能力有限（无法查 Windows 进程启动时间时保守判 busy），不抢锁。
- `.lock` 只有本工具会写；不是 OS 级强制锁。
- 首版只在 scratch root 运行；不写用户真实 DSH profile，不读写凭据/Provider 配置。
- fixture 组合的 `cordis.patch.yml` 是**组合投影、不可直接装载**，防止把 scratch 结果冒充真实 profile。
