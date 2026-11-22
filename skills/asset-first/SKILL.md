---
name: asset-first
description: 资产优先：先查再写、第二次就资产化、没有就建 L3、卡结束必须 settle；适用于取证/验证/环境/操作等重复劳动。
whenToUse: 开工前、准备写第二个同类脚本、资产运行失败、卡结束交付前。
---

# 资产优先

本 Skill 随 `dsh-agent-dev` 发布，只读。工具入口只有一个：`asset`。

## 触发条件

- 接到新卡，准备开始取证 / 验证 / 搭环境 / 跑脚本；
- 同一类命令或脚本在卡内已经跑了第二次；
- `asset` 返回 `health=missing|stale` 或 `run` 失败；
- 卡结束、准备交付或 `echuan_task_report` 之前。

## 五条硬规则

1. **先查后写**：开工先 `asset({action:'search', tags:[...]})`；命中且 `health=ok` 就直接 `run`，不重写。
2. **第二次就资产化**：同一动作第二次出现，用 `asset({action:'create'})` 把临时脚本抽成 L3；不要继续复制第三份。
3. **没测试不算资产**：L3 必须有 `test/smoke.sh` 且能跑通；不过就留在 staging，不提升。
4. **新东西只进 staging**：写到 `.agent/assets/staging/<task-id>/`，不散落 `/tmp`，不直接改共享库。
5. **交付必须写 `## 资产`**：used / created / promoted / discarded / debt，缺段不算交付。

## 开工三步

1. **search**：`asset({action:'search', tags:['web','ui'], project_root:'<项目根>'})`
   - 返回 `items`（id / layer / source / health / known_limits）与 `issues`；
   - 项目资产优先于共享库；`health=stale|invalid` 先诊断，不直接绕过。
2. **plan**：在任务笔记里写一句：`use <id>`、`create <name>` 或 `update <id>`，并写预期复用次数。
3. **use**：`asset({action:'run', id, scenario:'<场景 JSON>', project_root})`
   - `smoke:true` 跑资产自测；`timeout_ms` 默认 120000；
   - 只把 `status / exit_code / result_path / artifacts / diagnosis` 当事实，不把 stdout 当结论。

## 六个触发点

| 触发 | 动作 | 产出 |
|---|---|---|
| search miss | `asset({action:'create', task_id, name, purpose, inputs, outputs, reuse_expect})` | L3 脚手架 |
| 场景不匹配 | 先加 L2 场景 JSON；runner 表达不了才改 L1 | 新 pack / runner PR |
| run 失败 | `asset({action:'audit', id})` 看诊断，分类输入 / 环境 / 代码 / 契约 | 修复或 workaround |
| 卡结束 | `asset({action:'settle', id, decision})` | registry / 报告 |
| 月度审计 | `asset({action:'audit'})` 看 stale / unused / duplicate | prune 候选 |
| 需要跨项目复用 | `settle decision='propose-l1'` | promotion bundle |

## L3 最小契约

```text
.agent/assets/staging/<task-id>/<name>/
  asset.yaml
  run.mjs          # 或 run.sh
  scenario.json    # 示例输入
  test/smoke.sh
```

`asset.yaml` 必填：`id`、`layer: L3`、`purpose`、`inputs`、`outputs`、`entry`、`owner`、`reuse_expect`、`created_from`、`status: staging`。

质量门槛：确定性输出、参数化（禁止硬编码 task_id / 端口）、`result.json` 结构化结果、自清理、无密钥、smoke 1–2 分钟内跑完。

## settle 四选一

- `promote-l2`：项目专用，移入 `.agent/assets/packs/<name>/`，更新项目 registry；
- `propose-l1`：跨项目通用，生成 `.agent/assets/promotions/<name>/` bundle，人等审 PR；
- `discard`：用一次就废，删除并写 reason；
- `debt`：有价值但这次没时间，移入 `debt/` 并写 `debt.yaml`，14 天 TTL。

**不允许留在 staging**。卡结束由 Leader 检查：staging 为空或每条有结算记录。

## 失败处理

- `asset({action:'audit', id})` 先看 `entryExists / health / ageDays / knownLimits`；
- 输入或场景变了：改 L2 JSON，不改 runner；
- runner 代码 bug：L2 场景下先 patch staging 保住当前卡，再在共享库开 PR 加回归场景；
- 环境问题：修 env 资产，不记资产债；
- dsh 版本不兼容：查兼容矩阵，项目先 pin 旧版本。

每次失败在报告里写 `asset_incident`：id、版本、场景、错误分类、修复动作、是否 workaround。

## 禁止

- 直接改共享库（只能 `propose-l1`，人等审 PR）；
- 把带 task_id / 端口的脚本提升为 L2/L1；
- 同一动作第三次还手写；
- 建了不用还留在 staging；
- 用 `asset` 输出里的 stdout 代替 `result.json` / `artifacts`。

## 例子

新卡要验证「列表行点击开抽屉」，search 未命中：

1. 先写 `node /tmp/check-drawer.mjs` 跑通；
2. `asset({action:'create', task_id:'t_123', name:'verify-drawer', purpose:'验证只读抽屉', inputs:['scenario.json'], outputs:['result.json'], reuse_expect:4})`；
3. 把 base_url / viewport / expected_fields 抽到 `scenario.json`，补 `test/smoke.sh`；
4. `asset({action:'run', id:'verify-drawer', scenario:'scenario.json'})` 通过，本卡返工轮次继续复用；
5. 卡结束 `asset({action:'settle', id:'verify-drawer', decision:'promote-l2'})`；
6. 下一张抽屉卡 search 命中，直接 run，不再写脚本。
