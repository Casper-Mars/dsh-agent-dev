---
name: dev-container
description: 以项目级开发容器执行编码任务：已有 .devcontainer/devcontainer.json 就直接 `devcontainer up/exec`；没有就按依赖清单（package.json / go.mod / pyproject.toml / requirements.txt / pom.xml / Cargo.toml）自动生成配置再构建执行。使用本技能处理任意语言的构建、测试、运行、依赖管理与版本敏感工具链；不用于纯文档产出，也不用 `docker run` 单镜像兜底。
whenToUse: 任务涉及任意语言（Go/Node/Python/Java/Rust…）的构建、测试、运行、依赖管理、lint 或版本敏感工具链时；或用户明确要求使用 dev container 时。不用于只做需求、方案、评审等不执行代码的任务。
user-invocable: true
---

# 项目级开发容器（Project Dev Container）

本 agent 运行在**精简容器**内：**不要**往当前容器安装任何语言 toolchain。编码任务一律在
**项目自己的 devcontainer** 中执行：环境由项目目录下的 `.devcontainer/devcontainer.json`
声明（官方 features 多技术栈组合），由 Dev Container CLI 即时构建并进入。

**配置获取只有两条路**：① 项目已有 `devcontainer.json`；② agent 根据项目的依赖清单文件
**自动生成**。两条都走不通（探测不到任何技术栈）才算「不支持」，此时**不要**用 `docker run`
单镜像硬凑——单栈镜像无法满足多技术栈项目，宁缺毋滥。

## 1. 定位项目目录与配置

配置**跟着项目走**，不是跟着容器的挂载点走。先定项目目录，再找配置：

- **`PROJECT_DIR`**：任务实际操作的目录。用户点名了子目录就用它；否则从任务的工作目录
  逐级向上查找最近的 `.devcontainer/`；仍未命中才退回挂载根。
- **配置路径**：`$PROJECT_DIR/.devcontainer/devcontainer.json`。同一仓库允许存在多份配置
  （monorepo 各子项目各自持有），**不要**跨目录复用别的项目的配置。
- **已存在** → 直接用；若文件缺少 `workspaceMount` 而当前处于 split 形态（见 2.1），补上，
  否则容器里的项目目录会是空的。
- **不存在** → 按 1.1 自动生成，并向用户说明生成路径。

### 1.1 自动生成 devcontainer.json

探测 `$PROJECT_DIR` 下的依赖清单，**多个可并存**：

| 文件 | 技术栈 | 官方 feature | 版本提取（可省略） |
|---|---|---|---|
| `go.mod` | Go | `ghcr.io/devcontainers/features/go:1` | 首行 `go 1.24` → `"1.24"` |
| `package.json` | Node | `ghcr.io/devcontainers/features/node:1` | `engines.node` 首个数字段（`^22.0.0` → `"22"`） |
| `pyproject.toml` / `requirements.txt` | Python | `ghcr.io/devcontainers/features/python:1` | `requires-python` 主版本（`3.12`） |
| `pom.xml` / `build.gradle` / `build.gradle.kts` | Java | `ghcr.io/devcontainers/features/java:1` | `<java.version>`（无则省略） |
| `Cargo.toml` | Rust | `ghcr.io/devcontainers/features/rust:1` | 省略 |

**一个都识别不出** → 报告「无法从依赖文件推断技术栈，请补
`$PROJECT_DIR/.devcontainer/devcontainer.json` 或告知技术栈」并结束，**不要** `docker run` 兜底。

只保留与识别结果对应的 feature 与缓存卷，写入 `$PROJECT_DIR/.devcontainer/devcontainer.json`：

```jsonc
{
  "name": "<PROJ>-devcontainer",
  "image": "m.daocloud.io/mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/go:1": { "version": "1.24" }
  },
  "remoteUser": "root",
  // 仅 MODE=split 时保留下面两行；source 必须是 daemon 视角的宿主路径
  "workspaceMount": "source=${localEnv:PROJECT_HOST_DIR},target=<CONTAINER_WORKSPACE>,type=bind,consistency=cached",
  "workspaceFolder": "<CONTAINER_WORKSPACE>",
  "containerEnv": {
    "HTTP_PROXY": "<PROXY_VALUE>",
    "HTTPS_PROXY": "<PROXY_VALUE>",
    "ALL_PROXY": "<PROXY_VALUE>",
    "NO_PROXY": "localhost,127.0.0.1,::1,host.docker.internal,192.168.65.254"
  },
  "mounts": [
    "source=gomodcache,target=/go/pkg/mod,type=volume",
    "source=gobuildcache,target=/root/.cache/go-build,type=volume"
  ]
}
```

规则：

- `<PROJ>` 用项目目录名；缓存卷按技术栈增删（Node→`/root/.npm`，Python→`/root/.cache/pip`）。
- `<CONTAINER_WORKSPACE>` 用容器内目标路径（如 `/workspaces/<PROJ>`），与 `workspaceFolder`
  保持一致；`PROJECT_HOST_DIR` 是项目目录在宿主上的路径（见 2.1），不能用容器路径。
- 代理值取运行环境已有的 `DOCKER_PROXY`，缺省回落 `HTTPS_PROXY`；两者都没有就删掉整块
  `containerEnv`，不要凭空编造代理地址。
- 引用宿主路径变量会引入可移植性代价，**必须向用户说明**：在本地 IDE 直接
  「Reopen in Container」时变量为空会导致构建失败；项目要长期给多人用时，应由平台侧
  改成同路径挂载（回到 MODE=same-path）或按项目约定硬编码宿主路径。
- `image` 默认走 DaoCloud 加速前缀；加速站不可用时切回
  `mcr.microsoft.com/devcontainers/base:ubuntu` 并依赖代理。

## 2. 构建并启动

先自检 daemon 可达，再构建；首次数分钟，之后走镜像层缓存，容器保持运行以复用依赖缓存：

```bash
docker version >/dev/null 2>&1 && docker ps >/dev/null 2>&1 || { echo "宿主机 Docker socket 不可达"; exit 1; }
devcontainer up --workspace-folder "$WF"
```

### 2.1 `WF` 取值（路径唯一容易出错的地方）

`--workspace-folder` 的值要**同时**满足两个视角：

- **CLI 视角**：`devcontainer` CLI 进程跑在 agent 容器内，会去读
  `<WF>/.devcontainer/devcontainer.json` 并计算 `${localWorkspaceFolder}` —— 只认容器内路径；
- **daemon 视角**：bind 挂载源由宿主 daemon 解析 —— 只认宿主路径。

记 `PROJECT_HOST_DIR` 为项目目录在宿主上的路径（`HOST_PROJECT_PATH` 拼上 `PROJECT_DIR`
相对挂载根的部分；项目目录就是挂载根时两者相等），探测：

```bash
[ -d "$PROJECT_HOST_DIR" ] && echo MODE=same-path || echo MODE=split
```

- **MODE=same-path**（宿主前缀在容器内同样存在）：`WF="$PROJECT_HOST_DIR"`，配置里**不要**
  写 `workspaceMount`/`workspaceFolder`，走 CLI 默认值。
- **MODE=split**（容器内只重建了挂载根，宿主前缀不可见）：`WF="$PROJECT_DIR"`（容器路径，
  满足 CLI 视角），并在配置里把 `workspaceMount` 的源写成 `PROJECT_HOST_DIR`（满足 daemon 视角）。
- `up` 与 `exec` 使用**同一个** `WF`；CLI 按建容器时写入的 `local_folder` 标签定位容器，
  值不同会报 `Dev container not found`。
- daemon 为远程（`DOCKER_HOST` 指向别处）时，`PROJECT_HOST_DIR` 必须是**那台 daemon 主机**
  上存在的路径。

## 3. 在开发容器内执行任务

每次任务一次 exec，`WF` 与第 2 步完全一致：

```bash
devcontainer exec --workspace-folder "$WF" <CMD>
```

例：`devcontainer exec --workspace-folder "$WF" go test ./...`

## 4. 生命周期

开发容器保持运行以跨任务复用依赖缓存；需要清理时用
`docker ps --filter "name=vsc-"` 找到并 `docker rm -f`（不要动其他容器）。

修改了 `devcontainer.json` 或 features 后需重新 `devcontainer up` 才生效——配置是构建期注入，
不是运行期动态附加。

## 5. 排障对照表

| 症状 | 根因 | 处置 |
|---|---|---|
| `Dev container config (<PROJECT_HOST_DIR>/.devcontainer/devcontainer.json) not found`（文件其实存在） | `WF` 用了宿主路径，但该路径在容器内不可见 | 按 2.1 探测，split 形态改用 `WF="$PROJECT_DIR"` |
| `invalid mount config ... bind source path does not exist` | `workspaceMount` 源写成了容器路径 | 源改为 `PROJECT_HOST_DIR` |
| 容器起来了但项目目录是空的 | split 形态缺 `workspaceMount`，或源指错 | 补/改 `workspaceMount` 后重建 |
| `Dev container not found` | `exec` 的 `WF` 与 `up` 不一致 | 统一为同一值 |
| 容器里是别的子项目 | `PROJECT_DIR` 定位错，复用了上层配置 | 以任务目标目录向上找最近的 `.devcontainer/` |
| `Error fetching image details: ... TLS connection ...` | features 从 ghcr.io 拉取未走代理 | 确认代理值已注入 `containerEnv` 与 CLI 进程环境 |
| 改了配置不生效 | 构建期注入 | 重新 `devcontainer up` |

## 6. 边界

- **不要**在 agent 容器内安装 go/node/python 等 toolchain。
- **不要**对未覆盖的技术栈用 `docker run` 单镜像硬凑，也不要用别的项目的配置顶替。
- **不要**用宿主路径拼接文件读写（读不到且触发沙箱审批）；文件操作一律走 `PROJECT_DIR`
  的容器路径。
- **不要**在 build 失败时反复盲改而不报告；调整一次仍失败就报告并附配置路径。
- **不要**为绕过沙箱拦截而换命令；拦截时报「需要一次更宽放行」，由用户决定。
- 不承诺构建一定成功：feature 版本、网络、镜像源都可能失败，失败如实上报。

## 7. 验收

本次执行合格需同时满足：

- [ ] 已说明 `PROJECT_DIR`、探测到的 MODE 与选定的 `WF`，且 `up`/`exec` 取值一致；
- [ ] `devcontainer up` 退出码为 0，容器处于运行中；
- [ ] 在开发容器内**实际跑通**至少一条命令（如 `go version`）并回显真实版本号；
- [ ] 容器内工作目录的内容与 `PROJECT_DIR` 一致（split 形态下确认 bind 生效）；
- [ ] 若为自动生成配置，已告知生成路径与宿主路径变量带来的可移植性代价；
- [ ] 失败路径如实报告：错误原文、已排除的假设、下一步建议，不伪造通过结果。
