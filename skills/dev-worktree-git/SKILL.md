---
name: dev-worktree-git
description: 两级分支规范：项目集成分支 feature/<project_id> 收口，每张 dev 卡一条 task/<任务号> 分支与独立 worktree；任务 PR 合入项目分支，收尾一个 PR 合入默认分支。
whenToUse: 项目立项建集成分支、dev 卡开工建任务 worktree、任务交付开 PR、项目收尾与清理时使用。
---

# 两级分支与 Git 规范

目标：**项目一条集成分支，任务一条任务分支，一任务一 worktree**。

| 分支 | 命名 | 作用 |
|------|------|------|
| 项目集成分支 | `feature/<project_id>` | 项目的收口分支，所有任务提交最终汇入这里 |
| 任务分支 | `task/<任务号>` | 单张 dev 卡的工作分支；任务号为平台 `w_` 前缀（V3 起 `t_`） |

- 任务 PR 的 base 是**项目分支**，不是默认分支；
- 项目收尾时只开一个 PR：`feature/<project_id>` → 默认分支；
- 主仓库全程不被污染。

## 触发条件

- 接到新项目，准备写第一行代码（建项目集成分支）；
- 一张 dev 卡开工（建任务 worktree）；
- 任务完成，需要提交、推送、开任务 PR；
- 全部任务验收通过，需要开收尾 PR；
- PR 合并后需要清理 worktree 与分支。

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
| `GIT_WRITE_OK` | 按下面的规范立项、建任务 worktree、提交、开 PR |
| `GIT_WRITE_BLOCKED` | 不要反复重试，也不要尝试提权。二选一：<br>A. 让 Leader 以**包含主仓库与 worktree 的父目录**作为 dsh 的 cwd 重新启动（推荐，`workspaceRoot` 随 cwd 扩大）；<br>B. 受信任仓库下用 `DSH_PERMISSION_MODE=danger-full-access` 启动 dsh，并在交付里声明该风险。 |
| 两者都不可行 | 切换「工作区交付」：不建 worktree、不 commit，交付 `git status --short` + `git diff` + 建议 commit message；Tester 按 `dev-role-tester` 的「工作区交付」路径验收。 |

> 禁止在 `GIT_WRITE_BLOCKED` 下假装已建分支/已提交；也禁止把 `git switch -c` 失败后的重试当成进展。
> 预检只做一次，结果写进项目卡片第 5 项与首个任务卡第 10 项。

项目位于 `<workspace>/projects/<repo>` 时，worktree 与本项目的 `git-common-dir` 都在 `<workspace>` 内，
预检结果应当是 `GIT_WRITE_OK`。若仍得到 `GIT_WRITE_BLOCKED`，说明项目不在 `<workspace>/projects` 下
（见第三节例外），按上表处理，不要靠重试或提权绕过。

## 一、立项：只建项目集成分支

```bash
cd "$ws/projects/<repo>"
git fetch origin --prune

# 幂等：已有就直接复用，没有才从默认分支最新提交创建
git ls-remote --heads origin "feature/<project_id>" | grep -q . \
  || git push origin "origin/main:refs/heads/feature/<project_id>"
```

要点：

- **一个项目只建一次**；后续所有任务都从这条分支切出，不重建、不换名。
- 起点固定为 `origin/main`（先 `fetch`），不从本地 HEAD 拉。
- **不建项目级 worktree**：项目分支只是集成分支，干活在任务 worktree 里。
- 立项后把 `PROJECT_BRANCH=feature/<project_id>` 与 `BASE_SHA`（= `origin/main` 当时的 commit）写进项目卡片。
- 项目中途默认分支前进：把 `origin/main` 合入项目分支（**不 rebase 已推送分支**），冲突在项目分支内解决。

## 二、分支命名

| 对象 | 格式 | 示例 |
|------|------|------|
| 项目集成分支 | `feature/<project_id>` | `feature/APP-12` |
| 任务分支 | `task/<任务号>` | `task/w_01M7N20QF1FYKWK33308A6K2GC` |

禁止：`dev`、`test`、`tmp`、`my-branch`、中文分支名、带空格、带大写；禁止给任务分支加 type 前缀。

## 三、任务 worktree：一张卡一个

```bash
git -C "$ws/projects/<repo>" fetch origin --prune
git -C "$ws/projects/<repo>" worktree add \
  "$ws/projects/.worktrees/<repo>-<任务号>" \
  -b "task/<任务号>" "origin/feature/<project_id>"
```

要点：

- **基线必须是 `origin/feature/<project_id>` 的最新远程提交**，不是默认分支，也不是上一张卡的本地 HEAD。
- 一张卡一个目录，不复用上一张卡的 worktree；上一张已合并就 `git worktree remove` 掉，未合并则保留供 review。
- 路径固定 `<workspace>/projects/.worktrees/<repo>-<任务号>`；`<workspace>` 是 `pwd -P` 的真实 cwd，不是 `DSH_HOME`。
- 例外：既有本地仓库不在 `projects/` 下时，worktree 放在该仓库同一 workspace 内的
  `<该仓库父目录>/.worktrees/<repo>-<任务号>`，并在卡片写明路径与理由；不得把新项目落到 workspace 根。
- 依赖装在任务 worktree 内（`pnpm install` / `go mod download`），不依赖全局环境。

## 四、任务开发与交付

1. 开工核对：`git status --short` 为空，`git rev-parse --abbrev-ref HEAD` = `task/<任务号>`。
2. 只改本任务范围；一次一个小步并立刻验证。
3. 交付前先同步项目分支：

   ```bash
   git fetch origin --prune
   git merge "origin/feature/<project_id>"
   ```

   冲突在本任务分支内解决；解决不了就停下汇报，不得假报完成。
4. 提交并推送任务分支：

   ```bash
   git push -u origin "task/<任务号>"
   git rev-parse HEAD
   git ls-remote --heads origin "task/<任务号>"
   ```

   两个 hash 必须一致；不一致视为未交付。
5. 开任务 PR，base **必须显式写项目分支**：

   ```bash
   gh pr create --base "feature/<project_id>" --head "task/<任务号>" \
     --title "<任务标题>" --body "Closes <任务号>"
   ```

   fork 路径下 PR 开在 fork 内部（同一仓库的 base/head）；没有 `gh` 时给出 compare 链接与 base/head。

硬约束：

- 一个任务一条分支、一个 worktree、一个 PR；**不**直接推项目分支，**不**推默认分支。
- 任务 PR 在任务验收通过后由人合入项目分支；Leader 不自行合入，除非用户明确授权。
- 未验收的任务不得合入；任务分支在合入前不删。
- 交付 = push 成功 + PR 建好；只在本地说「做完了」不算交付。

## 五、Conventional Commits

格式：

```
<type>(scope): 一句话说明

<可选正文：为什么改、影响范围、验证方式>
```

- `scope` **必填**，用任务号（`w_...` / `task-04`）或模块名；需要同时体现时用 `task-04/skills`。
- 标题 ≤ 72 字符，祈使句，结尾不加句号。
- 正文写「为什么」，不写「改了什么」——改了什么看 diff。
- 破坏性变更用 `!`，并在正文写迁移方式。

示例：

```
feat(task-04/skills): 补齐环境规程的容器后端说明

- 明确 PROJECT_DIR 与 WF 取值，补 split 形态的 workspaceMount 说明
- 验证：pnpm typecheck / pnpm test / pnpm build 均 exit 0
```

## 六、提交前检查

```bash
git status --short           # 只应有预期文件
git diff --stat              # 确认没有产物、锁文件意外变更
git diff --cached            # 逐行看将要提交的内容
```

- 不提交：`node_modules/`、`dist/`、`dist-server/`、`.env`、日志、编辑器临时文件；
- 不提交密钥、token、个人绝对路径；
- 不 `git add .` 盲加；按路径添加。

## 七、项目收尾：一个 PR

前置：所有 dev 任务均为 done，且所有任务 PR 已合入项目分支。

```bash
git -C "$ws/projects/<repo>" fetch origin --prune

# 在项目集成分支上同步默认分支
git -C "$ws/projects/<repo>" switch "feature/<project_id>"
git -C "$ws/projects/<repo>" merge origin/main
git -C "$ws/projects/<repo>" push -u origin "feature/<project_id>"

gh pr create --base main --head "feature/<project_id>" \
  --title "<项目名>" \
  --body-file <(cat <<'EOF'
## 项目
<项目号 / 名称>，分支 `feature/<project_id>`，基点 `<BASE_SHA>`

## 任务与验收
| 任务 | 提交 | 验收 |
|------|------|------|
| ... | abc1234 | PASS |

## 验证
- typecheck / test / build 退出码

## 未覆盖项与风险
- ...

## 回滚
`git revert -m 1 <merge-commit>` 或按任务 revert
EOF
)
```

- 只有最后一张 dev 卡（没有下游 dev 依赖）负责建收尾 PR；其余卡只建任务 PR。
- 项目没有 dev 任务时（纯需求/方案/拆分），不产生任何分支与 PR。
- 合并用 `gh pr merge <n> --merge`，不用 squash；**合并前必须有人确认**。
- Leader 可以开 PR，不得自行合并；合并后删远端项目分支。

## 八、清理

```bash
# 任务 PR 合入后：清掉该任务的 worktree 与任务分支
git -C "$ws/projects/<repo>" worktree remove "<任务 worktree 路径>"
git -C "$ws/projects/<repo>" worktree prune
git -C "$ws/projects/<repo>" branch -d "task/<任务号>"

# 收尾 PR 合入后：清掉项目分支
git -C "$ws/projects/<repo>" branch -d "feature/<project_id>"
git -C "$ws/projects/<repo>" push origin --delete "feature/<project_id>"
```

- 顺序固定：**回收容器与卷 → `worktree remove` → `prune` → 删任务分支 → 删项目分支**。
- `-d` 只在确认已合并时用；`-D` 必须先确认提交已进目标分支。
- 定期 `git worktree list` 检查遗留目录。

## 禁止项

- **禁止 `git push --force` / `--force-with-lease`**（除非用户明确要求且已确认目标分支无人使用）；
- 禁止 rebase 已推送的公共分支；
- 禁止在默认分支上直接提交；
- 禁止把多张任务塞进同一条任务分支或同一个 worktree；
- 禁止把多个项目塞进同一条项目分支；
- 禁止未验收的任务合入项目分支；禁止自行合并收尾 PR；
- 禁止在没 push 成功时汇报「已交付」；
- 禁止用 `git checkout -- .` 丢弃没看懂的改动（先 `git stash` 或 `git diff` 存档）。

## 检查清单

- [ ] 写权限预检已跑，结果与交付形态已记录；
- [ ] 项目集成分支 `feature/<project_id>` 存在，`BASE_SHA` 已写进卡片；
- [ ] **没有**建项目级 worktree；
- [ ] 任务 worktree 路径为 `<workspace>/projects/.worktrees/<repo>-<任务号>`（例外已写明）；
- [ ] 任务分支为 `task/<任务号>`，基线是 `origin/feature/<project_id>` 最新提交；
- [ ] 任务 PR 的 base 是 `feature/<project_id>`，且显式写了 `--base`；
- [ ] push 后 `rev-parse HEAD` 与 `ls-remote` 一致；
- [ ] commit 标题符合 `type(scope): 说明`，正文写了为什么与验证方式；
- [ ] `git diff --stat` 无产物 / 锁文件意外变更；未提交密钥与个人路径；
- [ ] 收尾 PR 只在全部任务 done 且任务 PR 已合入后创建；
- [ ] 清理按「容器 → worktree → prune → 任务分支 → 项目分支」执行。
