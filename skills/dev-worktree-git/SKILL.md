---
name: dev-worktree-git
description: 项目分支规范：一个项目一条 feature 分支 + 一个 worktree，任务只产出 commit，全部验收后开一个 PR 合入 main。
whenToUse: 项目立项建分支/worktree、任务提交、收口开 PR、合并后清理时使用。
---

# 项目分支与 Git 规范

目标：**一个项目 = 一条分支 + 一个 worktree + 一个 PR**。任务只是这条分支上的 commit，不再逐任务建分支、逐任务合并。主仓库全程不被污染。

## 触发条件

- 接到一个新项目 / 一组需求，准备写第一行代码（立项）；
- 某个开发任务完成，需要提交；
- 全部任务验收通过，需要收口开 PR；
- PR 合并后需要清理 worktree 与分支；
- 发现当前目录里有别人的改动或未提交文件。

## 零、开工前写权限预检（必须，30 秒）

dsh 默认 `workspace-write` 沙箱只允许写当前工作目录。linked worktree 的 git 元数据在主仓库
`.git/`，经常在工作目录之外；不预检就直接 `git worktree add` / `git switch -c` / `git commit`
会得到 `Operation not permitted`，且 headless 模式没有审批通道，无法升级权限。

```bash
# 只在 Leader 启动 dsh 的那个 cwd 执行一次；子 agent 不要在自己的 cwd 重跑（会误判）。
root=$(git rev-parse --show-toplevel)
common=$(git rev-parse --git-common-dir)
case "$common" in /*) ;; *) common="$root/$common" ;; esac
common=$(cd "$(dirname "$common")" && pwd -P)/$(basename "$common")
ws=$(pwd -P)          # dsh workspaceRoot = 启动 dsh 时的 cwd
case "$common" in
  "$ws"/*) echo "GIT_WRITE_OK" ;;
  *) echo "GIT_WRITE_BLOCKED: git-common-dir=$common outside workspace=$ws" ;;
esac
```

| 结果 | 处理 |
|------|------|
| `GIT_WRITE_OK` | 按下面的规范立项、提交、开 PR |
| `GIT_WRITE_BLOCKED` | 不要反复重试，也不要尝试提权。二选一：<br>A. 让 Leader 以**包含主仓库与 worktree 的父目录**作为 dsh 的 cwd 重新启动（推荐，`workspaceRoot` 随 cwd 扩大）；<br>B. 受信任仓库下用 `DSH_PERMISSION_MODE=danger-full-access` 启动 dsh，并在交付里声明该风险。 |
| 两者都不可行 | 切换「工作区交付」：不建 worktree、不 commit，交付 `git status --short` + `git diff` + 建议 commit message；Tester 按 `dev-role-tester` 的「工作区交付」路径验收。 |

> 禁止在 `GIT_WRITE_BLOCKED` 下假装已建分支/已提交；也禁止把 `git switch -c` 失败后的重试当成进展。
> 预检只做一次，结果写进项目卡片第 5 项与首个任务卡第 10 项。

项目位于 `<workspace>/projects/<repo>` 时，worktree 与本项目的 `git-common-dir` 都在 `<workspace>` 内，
预检结果应当是 `GIT_WRITE_OK`。若仍得到 `GIT_WRITE_BLOCKED`，说明项目不在 `<workspace>/projects` 下
（见第三节例外），按上表处理，不要靠重试或提权绕过。

## 一、立项：项目分支与 worktree 只建一次

```bash
ws=$(pwd -P)                                   # dsh workspaceRoot = 启动 dsh 时的 cwd
cd "$ws/projects/<repo>"
git fetch origin --prune
git worktree add -b <type>/<项目号>-<短描述> \
  "$ws/projects/.worktrees/<repo>-<type>-<项目号>-<短描述>" origin/main
cd "$ws/projects/.worktrees/<repo>-<type>-<项目号>-<短描述>"
git status && git log --oneline -1            # 确认基点 = 最新 origin/main
```

要点：

- **一个项目只做一次**。后续所有任务复用这个 worktree 和这条分支，不新建、不切换。
- `-b` 一次完成「建分支 + 关联新 worktree」，不需要先 `checkout`；
- 起点固定为 `origin/main`（先 `fetch`），不从本地 HEAD 拉，避免带上别人未合并的改动；
- 立项后把 `PROJECT_BRANCH`、`WORKTREE`、`BASE_SHA`（= `origin/main` 当时的 commit）写进项目卡片，后续任务卡直接引用；
- 项目中途 `main` 前进：在项目分支上 `git merge origin/main`（**不 rebase 已推送分支**），冲突在项目分支内解决并随任务提交。

## 二、分支命名

格式：`<type>/<项目号>-<短描述>`，短描述用小写 kebab-case，2~5 个词。

| type | 用途 |
|------|------|
| `feat` | 新功能、新能力、一组需求 |
| `fix` | 一轮缺陷修复 / 回归修复 |
| `docs` | 仅文档 |
| `refactor` | 不改外部行为的重构 |
| `chore` | 依赖、构建、配置、脚本 |
| `test` | 仅测试 |

项目号取值顺序：驿传 `project_id` 前 8 位 → 任务清单前缀（如 `task-04` 所属项目）→ `proj-<YYYYMMDD>`。

示例：

```
feat/proj-1a2b3c4d-social-login
fix/proj-5e6f7a8b-upload-timeout
docs/proj-0c1d2e3f-readme-refresh
```

禁止：`dev`、`test`、`tmp`、`my-branch`、中文分支名、带空格、带大写。

## 三、worktree 路径约定

```
<workspace>/projects/.worktrees/<repo>-<type>-<项目号>-<短描述>
```

- `<workspace>` 是 `pwd -P` 取到的真实 cwd（dsh `workspaceRoot`），**不是** `DSH_HOME`；两者不要混用；
- 一个项目一个目录，所有任务在里面串行完成；**不再**每任务一个 worktree；
- 目录名 = 仓库名 + 分支名（`/` 换成 `-`），一眼能从目录反推分支；
- 例外：既有本地仓库不在 `projects/` 下时，worktree 放在该仓库同一 workspace 内的
  `<该仓库父目录>/.worktrees/<repo>-<type>-<项目号>-<短描述>`，并在项目卡片写明路径与理由；
  不得以「例外」为由把新项目落到 workspace 根；
- 依赖装在 worktree 内（`pnpm install` / `go mod download`），不依赖全局环境。

## 四、任务开发：只提交，不建分支

每个开发任务在**同一个 worktree、同一条分支**上完成：

1. 开工先核对：`git -C <worktree> status --short` 为空、`git rev-parse --abbrev-ref HEAD` = 项目分支；
2. 只改本任务范围内的文件，一次一个小步并立刻验证；
3. 任务完成 → 按第五节提交 → 记下 `TASK_COMMIT`；
4. 下一任务的 `base` = 上一个任务的 `TASK_COMMIT`（首个任务为立项 `BASE_SHA`）。

硬约束：

- **不** `git switch -c`、**不** `git worktree add`、**不** `git merge` 回 main、**不** 每任务开 PR；
- 同一时间只允许一个 Developer 在该 worktree 写文件；需要并行开发 → 拆成多个项目（多条分支）；
- 任务被放弃时保留已有 commit（后续任务可继续），在汇报里说明，不 revert 半成品除非影响后续。

## 五、Conventional Commits

格式：

```
<type>(<scope>): <一句话说明>

<可选正文：为什么改、影响范围、验证方式>
```

- `scope` **必填**，用任务号（`task-04`）或模块名（`domain`、`skills`、`scripts`、`tests`）；
  需要同时体现两者时用 `task-04/skills`；
- 标题 ≤ 72 字符，祈使句，结尾不加句号；
- 正文写「为什么」，不写「改了什么」——改了什么看 diff；
- 破坏性变更用 `!`（`feat(pack)!: ...`）并在正文写迁移方式。

示例：

```
feat(task-04/skills): 补齐环境规程的容器后端说明

- 明确 PROJECT_DIR 与 WF 取值，补 split 形态的 workspaceMount 说明
- 验证：pnpm typecheck / pnpm test / pnpm build 均 exit 0
```

```
fix(task-07/plugin): Skill 注册失败时回滚不完整

原因：中途注册失败后只反注册了已成功项，未恢复 persona 注入状态……
验证：pnpm test tests/plugin.spec.ts（全部通过，用例数以实际输出为准）
```

## 六、提交前检查

```bash
git status --short           # 只应有预期文件
git diff --stat              # 确认没有产物、锁文件意外变更
git diff --cached            # 逐行看将要提交的内容
```

- 不提交：`node_modules/`、`dist/`、`dist-server/`、`.env`、日志、编辑器临时文件；
- 不提交密钥、token、个人绝对路径；
- 提交信息用中文正文可以，但 `type(scope)` 前缀必须是英文小写；
- 不 `git add .` 盲加；按路径添加。

## 七、PR 收口（全部任务 PASS 后，一次）

前置：任务清单里所有任务都有 Tester 的 PASS 报告；未完成任务不得进 PR。

```bash
cd <worktree>
git fetch origin --prune
git merge origin/main                     # 有前进才需要；冲突在项目分支解决
git log --oneline origin/main..HEAD       # 复核 PR 包含的任务 commit 列表
git push -u origin <PROJECT_BRANCH>

gh pr create --base main --head <PROJECT_BRANCH> \
  --title "<项目名>" \
  --body-file <(cat <<'EOF'
## 项目
<项目号 / 名称>，分支 `<PROJECT_BRANCH>`，基点 `<BASE_SHA>`

## 任务与验收
| 任务 | commit | 验收 |
|------|--------|------|
| 任务-01 ... | abc1234 | PASS（Tester 报告要点）|

## 验证
- typecheck / test / build 退出码
- 关键路径冒烟结果

## 未覆盖项与风险
- ...

## 回滚
`git revert -m 1 <merge-commit>` 或按任务 revert 单个 commit
EOF
)
```

- PR 正文必须含任务表、验证结果、未覆盖项、回滚方式；只写 `--fill` 不够；
- 合并用 `gh pr merge <n> --merge`（保留任务 commit 作为审计轨迹），**不用 squash**；
- **合并前必须有人确认**（用户或 CTO review 通过）；Leader 可以开 PR，不得自行合并；
- 合并后删除远端分支：`git push origin --delete <PROJECT_BRANCH>`；
- 项目中途被叫停：分支保留、不开 PR，在交付说明写明状态与后续建议；不把半成品合进 main。

## 八、清理（PR 合并后）

```bash
git -C <项目根目录> worktree remove <worktree 路径>   # 目录干净时
git -C <项目根目录> worktree remove --force <路径>    # 仅确认改动已合并时
git -C <项目根目录> worktree prune
git -C <项目根目录> branch -d <PROJECT_BRANCH>
```

- 顺序固定为 **回收容器与卷 → `worktree remove` → `prune` → 删分支**；
- 删除分支用 `-d`（已合并才删得掉），`-D` 只在确认提交已进 main 时使用；
- 定期 `git worktree list` 检查是否有遗留目录。

## 禁止项

- **禁止 `git push --force` / `--force-with-lease`**（除非用户明确要求且已确认目标分支无人使用）；
- 禁止 rebase 已推送的公共分支；
- 禁止在主干分支上直接提交；
- 禁止一个任务一条分支 / 一个任务一个 worktree / 一个任务一个 PR；
- 禁止把多个项目的改动塞进同一条分支；
- 禁止未验收的任务进 PR；禁止自行合并 PR；
- 禁止用 `git checkout -- .` 丢弃自己没看懂的改动（先 `git stash` 或 `git diff` 存档）。

## 检查清单

- [ ] 开工前已跑写权限预检，结果（`GIT_WRITE_OK` / `GIT_WRITE_BLOCKED`）与所选交付形态已记录；
- [ ] 项目分支只建一次，起点是 `origin/main`，`PROJECT_BRANCH` / `WORKTREE` / `BASE_SHA` 已写进卡片；
- [ ] worktree 路径符合 `<workspace>/projects/.worktrees/<repo>-<type>-<项目号>-<描述>`（例外已写明）；
- [ ] 分支名符合 `<type>/<项目号>-<描述>`，type 在允许列表内；
- [ ] 每个任务只产生 commit，未新建分支 / worktree，`scope` 为任务号；
- [ ] commit 标题符合 `type(scope): 说明`，正文写了为什么与验证方式；
- [ ] `git diff --stat` 无产物 / 锁文件意外变更；未提交密钥与个人路径；
- [ ] 交付信息含项目分支 + 任务 commit；
- [ ] 全部任务 PASS 后只开一个 PR，正文含任务表 / 验证 / 风险 / 回滚；
- [ ] 合并经用户或 CTO 确认，合并方式为 merge commit；
- [ ] 收尾已 `worktree remove` + `prune` + 删分支，容器已 `down -v`。
