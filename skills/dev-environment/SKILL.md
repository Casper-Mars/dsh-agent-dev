---
name: dev-environment
description: Agent 侧开发环境管理规程：把「环境定义」存放在工作区的 <workspace>/.agent-env/（既不是项目仓、也不是 $DSH_HOME），开工前先查后建、一 repo 一容器、交付前按账本与 label 双路核销、收尾按固定顺序回收。本技能只教判断与动作（在哪里放、先查什么、怎么复用、怎么核销），不依赖任何随 skill 分发的脚本；技术栈识别与配置编写由 agent 自己完成。
whenToUse: 任何需要构建、测试、运行、装依赖、起服务的任务开工前；需要给任务准备容器/浏览器/数据库等运行环境时；任务交付或项目收尾需要回收环境时。不用于纯文档/纯阅读任务（直接在当前环境完成即可）。
---

# 开发环境管理（Agent 侧环境规程）

本 skill 与 `dev-container` 的关系：`dev-container` 回答「用什么容器跑命令」，本 skill 回答
「**环境定义放在哪、开工先查什么、怎么复用、怎么核销、按什么顺序回收**」。

在 Dev Leader 流程里，本 skill 由**阶段 1.5 · 环境确保**（派发编码任务前）与
**阶段 6 · 环境清理**（交付前核销、收尾执行）调用；两处漏做都算交付不完整。

**核心立场**：技术栈识别、依赖判断、配置编写只有 agent 能做，不要指望工具自动完成；
但一致性不靠记性，靠**三条约定 + 一套检查清单**。

## 0. 三条不可协商的约定

1. **环境定义只存工作区**：`$WS/.agent-env/<repo>/`（`$WS` = workspace 根）。**禁止**往项目仓写
   `.devcontainer/`、`Dockerfile`、`make env`、`.env` 之类的环境产物——项目仓只被读、只被改业务代码；
   也**不要**放 `$DSH_HOME`（那是 profile/进程级目录，换个 dsh 进程就丢，且与「工作区里的仓库」不对应）。
2. **一 repo 一容器**：同一仓库的所有 worktree 共用一个容器（挂 `<workspace>/projects` 根，
   用 `exec -w <worktree>` 切目录）。**建之前必须先按 label 查**，查不到才建。
3. **先核销后拆 worktree**：容器与卷 `reclaim → git worktree remove → worktree prune → 删分支`。
   顺序颠倒会让容器失去可识别的路径锚点，孤儿就再也认不出是谁的。

## 1. 环境定义放在哪（目录约定）

```
$WS/.agent-env/               # $WS = pwd -P 的 workspace 根；不进任何仓库，也不放 $DSH_HOME
├── hostmap.json              # 容器内路径 ↔ 宿主机路径（探测一次，长期复用）
├── images/                   # 可选：自建 dsh-env:<stack> 的 Dockerfile 与构建说明
└── <repo>/                   # 按仓库建目录（repo = 仓库目录名，如 echuan）
    ├── env.md                # 必需：本项目的环境说明（人/AI 都能读）
    ├── Dockerfile            # 可选：基础镜像不满足依赖时才写
    ├── compose.yml           # 可选：需要浏览器 / 数据库 / 多服务时
    └── ledger.jsonl          # 必需：本项目容器/卷流水（appended by agent）
```

为什么放工作区而不是 `$DSH_HOME`：环境是**跟着工作区里的仓库走**的（`$WS/projects/<repo>` 与
`$WS/.agent-env/<repo>` 一一对应），换一个 dsh 进程/会话仍能读到同一份定义；`$DSH_HOME` 是
profile 级目录，跨进程不稳定，也不方便人工查看与清理。

`env.md` 的最小字段（下表全填，不要留「待补充」）：

```markdown
- 项目：<repo>  @ <git_url>（只读）
- 镜像：golang:1.26-alpine（含 go1.26.4）/ node:22 / 自建 dsh-env:<stack>
- 额外依赖：bash jq curl lsof（镜像内缺时 apk/apt 装，记下命令）
- 容器名：dsh-<repo>-dev
- label：dsh.repo=<repo> dsh.owner=agent dsh.created_by=<第一张卡的 work_id>
- 挂载：<WS>/projects → /work（rw，一 repo 一容器靠它复用）
- 卷：dsh-<repo>-gomodcache → /go/pkg/mod；dsh-<repo>-npmcache → /root/.npm
- 工作目录：/work/<repo>
- 校验命令：typecheck / test / build 各一条（从仓库脚本抄，不猜）
- 备注：仓库是否有自带 .devcontainer；是否有必须走 compose 的服务
```

`<WS>` = `pwd -P` 得到的 workspace 根；环境定义落在 `$WS/.agent-env/`，**不进** `$WS/projects/<repo>`（项目仓），也**不放** `$DSH_HOME`。

## 2. 开工决策树（每张卡都走一遍）

```
开工
 │
 ├─0 本任务真的需要环境吗？
 │    纯文档 / 纯阅读 / 纯 grep → 不建环境，直接做（结束）
 │
 ├─1 $WS/.agent-env/<repo>/env.md 是否存在？
 │    ├─ 无 → 读项目事实（第 3 节）→ 写 env.md（+ 必要时 Dockerfile/compose.yml）
 │    └─ 有 → 第 4 节「复用校验」：env.md 是否仍与项目匹配？
 │              ├─ 匹配 → 复用
 │              └─ 不匹配 → 改 env.md，并在 ledger 记一行 redefined（含原因）
 │
 ├─2 按 label 查本项目容器（**建之前必须查**）
 │    docker ps -a --filter label=dsh.repo=<repo> \
 │      --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
 │    ├─ 有且 Up        → reused，记一行 reuse
 │    ├─ 有但 Exited    → docker start <name> 后记一行 reuse
 │    └─ 无            → 按第 5 节创建，记一行 up
 │
 └─3 之后所有命令都走这一个容器：
      docker exec -w /work/<worktree> dsh-<repo>-dev <cmd>
```

## 3. 读什么来判断项目需要什么（agent 的活，工具替不了）

按存在性依次读，读到就停，不要凭感觉编版本号：

| 文件 | 取什么 |
|---|---|
| `go.mod` | `go <version>` → 选对应 Go 镜像；`require` 里有无 cgo 依赖（决定要不要装 gcc） |
| `package.json` / `pnpm-lock.yaml` | `engines.node` / `packageManager` → Node 版本、pnpm 版本；有无 test/build/typecheck 脚本 |
| `pyproject.toml` / `requirements.txt` | `requires-python`、依赖组 |
| `pom.xml` / `build.gradle*` | Java 版本 |
| `Cargo.toml` | Rust（一般不锁版本） |
| `Makefile` | `test` / `lint` / `build` 目标里**实际命令**（校验命令照抄，不猜） |
| `.devcontainer/devcontainer.json` | 仓库自带环境 → 走第 6 节（配置复制到 agent 侧，用 `--override-config`） |
| `Dockerfile` / `docker-compose.yml` | 官方运行方式，可作为镜像与依赖依据 |
| `scripts/*.sh` 头部注释 | 脚本对宿主工具的依赖（例如 `bash / go / jq / curl / lsof`） |

**只读不改**：这些文件是事实来源，读它们不产生任何 commit。

## 4. 复用校验（env.md 可能已过期）

三件事都要做，缺一条就当作「不匹配」：

```bash
# 4.1 版本比对：项目声明 vs env.md 记录（不同则改 env.md）
grep -E '^go |^node ' go.mod package.json 2>/dev/null

# 4.2 实测容器里的真实版本（不信任 env.md 的自述）
docker exec dsh-<repo>-dev sh -c 'go version; node -v; pnpm -v; jq --version; lsof -v 2>&1 | head -1'

# 4.3 挂载是否仍然正确（split 形态下宿主路径变了会让容器看着正常却写错目录）
docker inspect dsh-<repo>-dev --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

任何一条不符 → 改 `env.md`，容器差别大就 `docker rm -f` 重建（先记一行 redefined 再记 up）。

## 5. 创建容器（唯一模板，照抄改值）

```bash
WS=$(pwd -P)                 # 当前 workspace 根
REPO=echuan                  # 仓库目录名
HOST_WS=<宿主机上的 WS 路径>  # split 形态必需，探测见 5.1

docker run -d \
  --name "dsh-${REPO}-dev" \
  --label "dsh.repo=${REPO}" \
  --label "dsh.owner=agent" \
  --label "dsh.created_by=${WORK_ID}" \
  --label "dsh.ws=${WS}" \
  --network=host \
  -v "${HOST_WS}/projects:/work" -w "/work/${REPO}" \
  -v "dsh-${REPO}-gomodcache:/go/pkg/mod" \
  -v "dsh-${REPO}-gobuildcache:/root/.cache/go-build" \
  golang:1.26-alpine sleep infinity
```

- **挂 `projects/` 而不是单个 worktree**：这是「一 repo 一容器」的实现方式；
  各卡用 `docker exec -w /work/<worktree> …` 切目录，互不干扰。
- 卷名带 repo 前缀（`dsh-<repo>-*`），避免跨项目误用；需要清缓存时显式
  `docker volume rm dsh-<repo>-gomodcache`。
- 镜像内缺工具时在容器里装（`apk add --no-cache bash jq curl lsof`），**把安装命令写回
  `env.md` 的「额外依赖」**；若每个项目都要装同样的东西，考虑自建 `dsh-env:<stack>` 镜像，
  构建命令和镜像 id 也记进 `env.md` / ledger。
- `--network=host` 只在你确实需要从容器访问宿主端口（浏览器验收、e2e 打本地服务）时用；
  否则用默认网络，避免端口冲突面扩大。

### 5.1 探测宿主机路径（split 形态，一次性）

```bash
# 容器内拿不到宿主路径，用挂载信息反推（本容器自身就是 agent 容器）
docker inspect "$(hostname)" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
# 例：/Users/xxx/project/opc/devcontainer/test -> /workspace
# → HOST_WS=/Users/xxx/project/opc/devcontainer/test
```

探测结果写进 `$WS/.agent-env/hostmap.json`，之后每张卡直接取，不要重新猜。
判定规则：宿主前缀在容器内**也可见** → same-path（`HOST_WS=$WS`）；不可见 → split（用探测值）。

## 6. 仓库自带 `.devcontainer` 的情况

仓库已有环境声明时**优先用它**（那是项目作者的事实），但**不要往仓库写任何东西**：

```bash
mkdir -p "$WS/.agent-env/$REPO"
cp -r <repo>/.devcontainer/* "$WS/.agent-env/$REPO/devcontainer/"   # 复制，不在仓库内改
devcontainer up \
  --workspace-folder "$WS/projects/<worktree>" \
  --override-config "$WS/.agent-env/$REPO/devcontainer/devcontainer.json"
```

- split 形态必须在该配置里写 `workspaceMount`，`source` 用 **宿主路径**（第 5.1 节探测值），
  否则容器里项目目录是空的。
- `devcontainer up` 的容器名不可控（随机名），所以：**解析它的返回 JSON 里的 `containerId`
  立即记进 ledger**，并在 `env.md` 记一行「本 repo 用 devcontainer 后端 + 该 containerId 家族」。
  这是本 skill 唯一允许「名字不可预测」的路径，代价必须用 ledger 补上。
- `up` / `exec` 的 `--workspace-folder` 必须同一值，否则报 `Dev container not found`。

## 7. 多服务（浏览器 / 数据库 / e2e）

放在 `$WS/.agent-env/<repo>/compose.yml`，**仍然只有一个入口**：

```bash
docker compose -p "dsh-${REPO}" -f "$WS/.agent-env/$REPO/compose.yml" up -d
docker compose -p "dsh-${REPO}" -f "$WS/.agent-env/$REPO/compose.yml" down -v
```

- `-p dsh-<repo>` 让整套服务可被一条 label/名字前缀识别；
- 服务容器名 `dsh-<repo>-<role>`（`chromium` / `db` / `e2e`），同样带
  `dsh.repo=<repo>` label；
- **禁止**用裸 `docker run` 起「临时凑一下」的服务——那就是这次环境失控的起点。

## 8. 记账（每次 up / reuse / redefined / reclaim 各一行）

```bash
cat >> "$WS/.agent-env/$REPO/ledger.jsonl" <<EOF
{"ts":"$(date -u +%FT%TZ)","repo":"${REPO}","event":"up","name":"dsh-${REPO}-dev","id":"$(docker inspect -f '{{.Id}}' dsh-${REPO}-dev | cut -c1-12)","image":"golang:1.26-alpine","by":"${WORK_ID}"}
EOF
```

`event` 取值：`up` / `reuse` / `redefined`（改配置重建）/ `reclaim` / `retain`（显式保留，必须带
`note` 说明理由）。

## 9. 交付前核销（固定两步，缺一步不算交付完成）

```bash
# 9.1 账本侧：本项目应有的容器都在？状态是否 active 却没被复用？
docker ps -a --filter "label=dsh.repo=${REPO}" \
  --format '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Label "dsh.created_by"}}'

# 9.2 label 侧兜底：本项目用过镜像、但没有本 repo label 的容器（漏登/裸 docker run 留下的）
for img in $(grep -o 'image=[^ ]*' "$WS/.agent-env/$REPO/env.md" | cut -d= -f2 | sort -u); do
  docker ps -a --filter "ancestor=$img" --format '{{.ID}}\t{{.Names}}\t{{.CreatedAt}}\t{{.Image}}'
done
# 逐个判定归属：看挂载源是否落在本 workspace 下
docker inspect <id> --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}'
```

交付说明里必须出现其中之一：

- **孤儿清单为空**（贴命令与空输出）；或
- **显式保留**：列出容器名 + 理由（例：`dsh-echuan-dev` 保留，下张卡还要用），并在 ledger 记
  `retain`。

判定「孤儿」的口径：`dsh.repo=<repo>` 存在、但项目已收尾 / 该容器挂载的目录已不存在 /
created_by 的卡已交付且无后续卡 → 回收。**不确定归属的容器一律不删**，写进交付说明交人判断
（本机同时跑着别人的容器是常态）。

## 10. 收尾（顺序写死）

```
1. 核销并回收容器/卷   docker rm -f dsh-<repo>-dev；compose down -v
                       docker volume rm dsh-<repo>-*（默认保留缓存，项目结束再删）
2. git worktree remove <每个 worktree>
3. git worktree prune；删本地/远端任务分支（-d 保护，确认已合入）
```

项目级收尾（最后一张卡 + 合并 PR 合并后）才动「镜像 / 全局缓存卷」；中途只删本项目的容器与
服务，保留缓存以复用。

## 11. 子 agent 协议（派发/被派发时都要遵守）

- **共享环境由 Leader 独占管理**：Developer / Tester 只使用 Leader 给的容器名与 `WF`，
  **禁止**自己 `docker run` / `devcontainer up` / 改 `.devcontainer/`（多 agent 并行时重建容器
  会互相打断）。
- **私有环境自建者负责登记**：确需自建（浏览器验收、独立 e2e），必须在报告里写
  `name=… id=…` 与 `已回收|待回收`，并写进本项目 ledger。
- **中断兜底**：agent 被中止时不会执行收尾段，因此 Leader 的交付核销（第 9 节）是唯一兜底，
  不能假设子 agent 一定清理过。

## 12. 常见故障与处置

| 症状 | 根因 | 处置 |
|---|---|---|
| 容器起来了但项目目录是空的 | split 形态 `workspaceMount` 源写成容器路径 | 改成第 5.1 节探测到的宿主路径后重建 |
| `Dev container not found` | `up` 与 `exec` 的 `--workspace-folder` 不一致 | 统一成同一值 |
| `docker exec` 里找不到 go/node | 镜像 PATH 或镜像选错 | `docker exec … sh -c 'echo $PATH; which go'` 后修 env.md |
| 端口被占（e2e 随机端口失败） | `--network=host` 与其他进程共用 | 换随机端口重试；或改用默认网络 + 端口映射 |
| 磁盘涨得很快 | 每卡一个容器 + 每卡一个镜像层 | 回到第 0 节第 2 条：一 repo 一容器 |
| 找不到某容器是谁的 | 裸 `docker run`、无 label | 第 9.2 节按镜像反查 + 挂载源归属判定 |

## 禁止项

- 禁止把环境定义写进项目仓（`.devcontainer/`、`Dockerfile`、`.env`、`make env` 一律不落仓库）。
- 禁止不查 label 就 `docker run` 新容器（这是「一卡一容器」和孤儿容器的唯一来源）。
- 禁止用裸 `docker run` 替代 compose（多服务必须进 `compose.yml`）。
- 禁止跳过第 9 节核销就宣布交付。
- 禁止全局清理（`docker system prune`、`docker volume prune`）：会误删别人的容器/卷。
- 禁止先删 worktree 再回收容器。
- 禁止删除归属不明的容器——写进交付说明交人判断。

## 检查清单

开工前：

- [ ] 判断过「本任务是否真的需要环境」（纯文档任务不建）
- [ ] `$WS/.agent-env/<repo>/env.md` 存在且已通过第 4 节三项校验（版本比对 / 容器内实测 / 挂载核对）
- [ ] 已按 label 查过本项目容器，结论是「复用」或「新建」并已写入 ledger
- [ ] 未向项目仓写入任何环境产物（`git status --short` 不出现环境文件）

交付前：

- [ ] 第 9.1 节 label 清单与第 9.2 节兜底反查都已执行，输出贴在交付说明里
- [ ] 孤儿要么已回收、要么已按 `retain` 记账并写明理由
- [ ] 交付声明含：容器名 / 镜像 / 账本行数 / 核销结论

收尾：

- [ ] 顺序为 回收容器与卷 → `worktree remove` → `worktree prune` → 删分支
- [ ] `docker ps -a --filter label=dsh.repo=<repo>` 为空（或仅剩显式保留项）
- [ ] 项目结束后清理镜像与缓存卷（`docker volume rm dsh-<repo>-*`）
