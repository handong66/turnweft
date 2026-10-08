# Turnweft

[English](README.md)

[![npm](https://img.shields.io/npm/v/turnweft)](https://www.npmjs.com/package/turnweft) [![license](https://img.shields.io/npm/l/turnweft)](LICENSE)

**让 Claude Code 和 Codex 把活交给你的其他编程 Agent：就在你的真实项目里做，对话还能一直接着聊。**

你照常和 Claude Code 或 Codex 对话。想听听另一个模型的意见、想多一双手并行干活，或者单纯想换个模型时，直接说就行，比如“让 Grok 帮我审一下这段代码”“让 Droid 把挂掉的测试修好”。Turnweft 会在同一个项目目录里启动那个 Agent，让它读写真实的文件，再把结果带回你的对话。第二天再追问，接上的还是同一个 Agent 会话，它还记得之前做过什么。

支持的 Agent：**Dim、Droid、Grok、OpenCode、agy**。

> 状态：`0.1.0-alpha`，只支持 macOS。五个 Agent 在 Claude Code 和 Codex 中都已经端到端跑通，但难免还有粗糙的地方。版本改动见 [CHANGELOG.md](CHANGELOG.md)。

---

## 为什么做 Turnweft

如果你同时用好几个编程 Agent，大概经历过这些：

- 把代码和背景从一个工具复制到另一个，再把答案复制回来；
- 另一个 Agent 在副本或另一个目录里干活，改完还得手动搬回来；
- 过一阵子回来，只能开个新对话，把来龙去脉从头再讲一遍；
- 每个 Agent 各有一个插件，用法和表现都不太一样。

Turnweft 把这些统一成一种用法：你待在熟悉的助手里，另一个 Agent 就在你代码所在的地方干活，每个会话都能随时接着用。

## 用起来是什么样

下面的对话只是示意，实际措辞取决于你用的 Agent 和模型。

### 不离开对话，拿到第二意见

> **你**（在 Claude Code 里）：让 Grok 审一下我刚改的登录逻辑，别改任何东西。
>
> **Claude**：Grok 看了 `src/auth/session.ts` 和 `src/auth/login.ts`，指出两个问题：一是会话令牌用 `==` 比较，没有用防时序攻击的比较方式；二是登录失败后没有重置尝试次数。要让 Grok 来修，还是我来修？

Grok 读的是你项目里的真实文件。因为你要的是审查，它什么都没改。

### 把修复交出去，你接着忙自己的

> **你**：让 Droid 把 `test/math.test.js` 里挂掉的测试修好，然后告诉我它改了什么。
>
> **Claude**：Droid 修好了两个 bug，这一轮改动的文件是 `src/math.js`。你自己还没提交的 `NOTES.md` 改动是之前就有的，没有动。我自己跑了一遍测试：2 个通过，0 个失败。

Turnweft 会在这一轮前后各拍一次 git 快照，把“这一轮里变动的文件”和“你原本就有的未提交改动”分开列出来。它分不出是谁改的：如果 Agent 干活时你也在改同一个目录，你的改动也会出现在里面。插件还会要求 Claude 自己跑测试，不只听 Agent 说一句“测试通过了”。

### 接着上次聊

> **你**（第二天早上）：问问同一个 Droid 会话，它为什么改了取整方式。
>
> **Claude**：Droid 说原来的代码用的是 `Math.floor`，对这个函数来说负数会取错方向，所以改成了 `Math.trunc`……

每个 Turnweft 会话都绑定着 Agent 自己的原生会话。Agent 空闲一段时间后会被停掉以节省资源；下次提问时，接上的仍是那个会话，不会换成一个什么都不记得的新会话。

### 权限：只问一次，或者干脆不问

某个 Agent 在某个项目里第一次需要“读”以外的权限，比如改文件、执行命令时，会弹出一个 macOS 对话框，写明是哪个 Agent、哪个项目，以及它具体能做什么。同一个 Agent、项目和任务类型，你点一次“允许”就够了，等待中的任务会自动开始。如果你的 Claude Code 对话开着 **bypass 权限**，或者 Codex 开着**完全访问**，Turnweft 就把它当作你已经同意，不再询问。

## 一次典型的使用流程

1. **装一次**：运行 `npm install -g turnweft`，再给 Claude Code 和/或 Codex 装上插件（见[快速开始](#快速开始)）。
2. **用大白话提要求**：比如“问问 OpenCode 这个模块是怎么组织的”“让 agy 实现 CSV 导出”，不用学新命令。
3. **需要时确认一次**：某个 Agent 第一次在某个项目里改文件时，可能会弹出确认框。它会一直等你选择，你不回应也不算拒绝。
4. **检查结果**：你会看到 Agent 的回答、这一轮里变动了哪些文件，以及它实际用的权限模式。插件会要求 Claude 或 Codex 先核实一遍（比如自己跑测试）再说做完了。Agent 说“做完了”只是它的说法，不等于证明。
5. **随时追问**：几分钟后也好，几天后也好，问同一个 Agent，它都记得之前的工作。
6. **一切在你掌控之中**：可以取消正在跑的任务，查看或撤销以前的授权，也能清楚看到每个 Agent 被允许做什么。

## 适合谁用

- 已经在用 Claude Code 或 Codex，同时还有其他编程 Agent 账号的人；
- 想让另一个模型审查、复核工作，又不想来回复制粘贴的人；
- 想把工作分给不同的 Agent、额度或模型，同时由一个对话统一指挥的人。

## 快速开始

**需要：**

- macOS；
- Node.js 22.13 或更高版本；
- 你想用的 Agent 的命令行工具（`dim`、`droid`、`grok`、`opencode`、`agy`），并且都已登录。

```bash
npm install -g turnweft
turnweft doctor        # 列出找到了哪些 Agent，不会启动模型任务
```

**Claude Code：**

```bash
claude plugin marketplace add handong66/turnweft
claude plugin install turnweft@turnweft
```

**Codex：**

```bash
codex plugin marketplace add handong66/turnweft
codex plugin add turnweft@turnweft
```

装好后**新开一个对话**，插件才会加载；Codex 要先重启应用。然后试试：

```
让 Droid 用五条要点说明这个项目是做什么的。
```

## 可以这样用

- “让 Grok 审查我最近一次提交有没有安全问题，只读。”
- “让 Droid 修好 `test/api.test.ts` 里失败的测试，并跑一遍测试。”
- “问问 OpenCode 我们两种缓存方案哪个更好，给出建议。”
- “让 agy 给导出命令加一个 `--json` 参数。”
- “接着用同一个 Dim 会话：你为什么选了那个库？”
- “取消 Droid 的任务。”

想指定模型也可以，比如“让 Droid 用 glm-5.3-flash”；思考强度也能指定，比如“让 Dim 用 max 思考强度”。不指定时，各 Agent 用自己的默认设置。思考强度用各 Agent 自己的取值，具体有哪些取决于模型：

| Agent | 思考强度 | 设置方式 |
| --- | --- | --- |
| Dim | `auto`、`none`、`high`、`max` | ACP 配置项 `thought_level` |
| Droid | `none`、`low`、`medium`、`high`、`xhigh`、`max` | ACP 配置项 `reasoning_effort` |
| Grok | `low`、`medium`、`high`、`xhigh` | ACP 配置项 `reasoning_effort` |
| OpenCode | `low`、`high`、`max`、`default`（部分模型有 `medium`） | ACP 配置项 `effort` |
| agy | `low`、`medium`、`high`、`xhigh`、`max` | 启动参数 `--effort` |

对话中途也能调整思考强度，比如“接下来让 Dim 想得更深一点”。调整对之后开始的每个任务生效（已在运行的任务保持原强度），用的还是同一个 Agent 会话，之前的上下文都在。Dim、Droid、Grok、OpenCode 直接在运行中的会话里改，和在它们自己的 CLI 里改一样；agy 只在启动时接受强度，Turnweft 会带上新强度重启 agy，并接回同一个对话。每次恢复会话都会重新设置强度。Agent 在当前模型下不提供这个强度时，该任务会以 `invalid_effort` 失败，此时什么都还没发出，错误信息里列出它实际提供的取值，会话本身仍可继续使用。结果里同时写明请求的强度和 Agent 读回的强度。

## 权限与安全

- **要分析时就只读。** 审查和提问类的任务，只要 Agent 有只读或“先问再做”的模式，就用这种模式运行。Grok 是例外：Turnweft 无法核实 Grok 实际的权限模式，所以 Grok 的任务即使只是分析也要确认一次；如果你的 Grok 配置设成全部自动批准，它就完全无法被限制为只读，确认时会写明这一点。
- **更宽的模式只确认一次。** 有些 Agent 只能用超出你授权的模式改代码，比如自动批准命令、或者跳过它自己的权限检查。这时会弹出 macOS 对话框，同一个 Agent、项目和任务类型只问一次。Agent 版本变了，或者这个模式允许的范围变大了，会重新询问。
- **开了 bypass 的对话不问。** Claude Code 只认 `bypassPermissions`，auto 模式和其他模式照常弹窗；Codex 只认完全访问（`danger-full-access`）。Turnweft 从 Claude Code 或 Codex 本身得知当前模式，从不听信模型的说法。这种放行只对当次任务有效，不会被记住。
- **每次结果都如实交代权限。** 结果里会写明 Agent 实际用的模式、这个模式超出你授权的部分，以及是谁授权的。
- **不会意外执行两次。** 任务交出去之后，如果和 Agent 的连接断了，任务会标记为 `in_doubt`（待核对），交给你检查，不会自动重发。关掉 Claude Code 或 Codex 不会停止正在跑的任务，它会在后台继续，之后可以再查看。
- **只在本机运行。** Turnweft 的状态保存在 `~/.turnweft`，它自己不发出任何网络请求。各 Agent 照常和它们自己的服务通信。

Turnweft 做不到的：

- 它没法把 Agent 限制得比这个 Agent 自己的权限模式更严；
- 它也没法阻止你账户下运行的其他程序修改 Turnweft 的本地文件。

## 支持的 Agent

在 macOS 上用以下版本测试过：

| Agent | 接入方式 | 改代码时用的模式 | 改文件 | 追问 | 停掉后续接 | 取消 |
| --- | --- | --- | --- | --- | --- | --- |
| Dim 0.5.16 | ACP | `workspace-write`，命令请求由 Turnweft 应答 | ✅ | ✅ | ✅ | ✅ |
| Droid 0.233.0 | ACP | `autonomy_level=normal`，编辑和命令请求逐次由 Turnweft 应答 | ✅ | ✅ | ✅ | ✅ |
| Grok 1.0.46 | ACP（`agent --no-leader stdio`） | 遵从你的 `~/.grok/config.toml` | ✅ | ✅ | ✅ | ✅ |
| OpenCode 1.18.34 | ACP | `build` 模式，按 OpenCode 自身的权限配置运行 | ✅ | ✅ | ✅ | ✅ |
| agy 1.2.16 | 原生长连接 stream-json | 跳过权限检查 + accept-edits | ✅ | ✅ | ✅ | ✅ |

## 工作原理

```
Claude Code / Codex ──MCP──▶ turnweft mcp ──▶ 共享状态库（~/.turnweft/state.sqlite）
                                                   │
                                                   ▼
                                     每个活跃会话一个后台 worker
                                                   │
                  ┌──────────── ACP ───────────────┴──── 原生 stream-json ──┐
                  ▼          ▼          ▼          ▼                          ▼
                 Dim       Droid      Grok     OpenCode                     agy
```

- **一个运行时，两个轻量插件。** npm 包是唯一的运行时。两个插件各自只包含 MCP 注册、一份教助手如何使用 Turnweft 的 Skill，以及一个小启动器。CC 插件还多一个钩子，用来上报当前对话的权限模式。找不到运行时的时候，插件只提供一个安装说明工具。
- **会话与任务。** 每个会话绑定一个原生 Agent 会话。每次请求都是一个后台任务，由调用方提供 `requestId`，重试时返回原任务。同一会话里的任务按顺序执行；同一项目的写入任务即使来自不同会话，也一个一个来。
- **原生权限，能读回的都读回。** 每次打开或续接 Agent 会话时，Turnweft 都会设置 Agent 自己的权限模式；对能报告当前模式的 Agent，还会读回核对，对不上任务就不运行。Grok 的模式只能从它的配置文件推断，无法读回；OpenCode 只核对模式，不核对它完整的权限规则。
- **空闲与续接。** Agent 空闲 10 分钟后会被停掉，下次请求时按原生会话 ID 续接。续接失败会明确报错，不会悄悄开一个新会话。
- **两个宿主，一份状态。** Claude Code 和 Codex 共用同一份状态。要在另一个宿主里继续某个会话，需要显式 attach。

完整设计和所有决定见 [TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md](TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md)。测试记录见 [docs/m0/M0_RESULTS.md](docs/m0/M0_RESULTS.md)（协议探针）和 [docs/e2e/E2E_RESULTS.md](docs/e2e/E2E_RESULTS.md)（端到端）。

## 权限确认的细节

Agent 的模式超出你的授权时，任务先记为 `waiting_confirmation`（等待确认），这时什么都不会运行：

1. Turnweft 先请宿主弹出它自己的确认框。实测 Claude Code 2.1.286 和 Codex 0.160.0 桌面版都会自动回绝，并不会显示给你。
2. 于是 Turnweft 弹出 macOS 对话框，写明 Agent、项目、模式和超出授权的部分。对话框会一直等你选择，不回应不算拒绝。
3. 点“允许”后，等待中的任务自动开始，不用重新提交；点“拒绝”则取消任务（`confirmation_denied`）。提案 24 小时后过期（`confirmation_expired`）。
4. 命令行 `turnweft send` 需要确认时也会弹出这个对话框。你也可以在终端运行 `turnweft policy grant <proposalId>`，输入 `yes` 允许、`no` 拒绝。它拒绝非终端输入，也没有自动同意的参数，但分辨不出是谁在敲键盘，所以请自己运行，不要让带终端工具的 Agent 代劳。

**开了 bypass 的对话。** Turnweft 只认宿主为这一次调用给出的信号：

- **Claude Code**：每次调用 `turnweft_ask` 或 `turnweft_delegate` 之前，插件的 PreToolUse 钩子会从 Claude Code 拿到当前对话的权限模式，并按这一次调用（工具和任务参数）记下来。这条记录 15 秒内有效，只用一次，模式必须是 `bypassPermissions`。
- **Codex**：本次调用附带的元数据里，`sandbox_mode` 必须是 `danger-full-access`。

放行只对这一个任务有效，而且只覆盖你提交时的权限范围。命令行 `turnweft` 永远不接受 bypass 信号。你安装或更新插件之前就已经开着的对话，会继续用旧版本，直到你新开一个对话。

确认结果按 Agent × 项目 × 任务类型保存。用 `turnweft policy list` 查看，用 `turnweft policy revoke <id>` 撤销。

## 并行写任务

同一 canonical root（Git 项目或 worktree 的根目录）内，`implement` 任务默认排队串行执行。要让多个 Agent 并行写同一个项目，推荐为每个 Agent 创建独立的 git worktree，再用各自目录创建 Turnweft 会话；不同 worktree 不会互相阻塞。审查使用 `turnweft_ask`（`analyze`），它不等待项目写锁；同一会话仍然按 FIFO 排队。

用户可自行在 `~/.turnweft/config.json` 中设置 `"parallelWrites": ["/absolute/project/directory"]`，允许该目录并行写入。Agent 绝不能代改此配置。并行改动可能互相覆盖，git 提交可能包含其他 Agent 的改动；实际重叠运行的任务会在 `concurrentWrites` 中列出彼此的 job ID，并显示警告。

## 配置

可选设置写在 `~/.turnweft/config.json` 里：

```json
{
  "language": "zh",
  "executables": { "droid": "/custom/path/droid" },
  "idleReleaseMs": 600000,
  "inactivityTimeoutMs": 600000
}
```

- **`language`**：给人看的文字（对话框、命令行输出、确认内容）用什么语言，`"zh"` 或 `"en"`。
  - 优先顺序：环境变量 `TURNWEFT_LANG`，然后是这个设置，再依次是 `LC_ALL`、`LC_MESSAGES`、`LANG` 和 macOS 系统首选语言，最后是英文。
  - 从程序坞启动的宿主读不到终端里的环境变量，要固定语言就用这个设置。
  - 写给模型看的工具说明和流程提示始终是英文。
- **`executables`**：指定各 Agent 命令行工具的路径。
  - 不指定时，先在 `PATH` 里找，再依次找 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`。
  - OpenCode 还会找 `~/.opencode/bin`，Dim 还会找 DimAgent.app 内置的 `dim`。
- **`parallelWrites`** 是绝对项目目录数组，仅接受用户配置文件。路径先解析符号链接并规范化，再与会话 canonical root 精确匹配；不会递归匹配其他 canonical root（含嵌套 worktree）。同一 Git 根目录下的子目录会话共用该根目录的设置。相对路径、非字符串、不存在或非目录的条目被忽略。不能通过 MCP 参数、任务 CLI 标志或项目文件设置。每次尝试取锁都重新读取配置：已运行任务保留原共享／独占锁直到释放；独占任务等所有持有者退出，共享任务等独占持有者退出。
- **`idleReleaseMs`**：Agent 空闲多久后停掉，默认 10 分钟。
- **`inactivityTimeoutMs`**：一轮任务里 Agent 多久没有任何动静就取消，默认 10 分钟。

## 命令行

日常用插件就够了。命令行适合写脚本和排查问题：

```bash
turnweft session create --agent droid --cwd .        # 返回 tws_… 会话 ID
turnweft session update tws_… --effort high          # 之后任务的思考强度
echo "修复 src/math.js 的 bug 并跑测试" | turnweft send --session tws_… --intent implement
turnweft job wait twj_… --include-result
turnweft cancel twj_…
turnweft policy list
turnweft session close tws_…
```

## 常见问题

- **某个 Agent 显示不可用**：运行 `turnweft doctor`。它会检查各命令行工具是否装好并报告版本，但不检查你是否已登录。没登录的 Agent 会在执行任务时失败，错误码取决于 Agent 和失败的阶段。工具装在不常见的位置时，在 `executables` 里写上路径。
- **开着 bypass 却弹出了确认框**：bypass 放行需要运行时 0.1.0-alpha.2 或更高版本（`npm install -g turnweft@latest`）。版本没问题的话，有两种可能：一是这个对话是在安装或更新插件之前开的，二是助手改用了 `turnweft` 命令行，没用插件工具。新开一个对话即可。
- **助手说 Turnweft 没装**：插件没找到运行时。运行 `npm install -g turnweft`，然后新开一个对话。
- **日志**在 `~/.turnweft/logs/` 下：
  - `mcp.log`：确认通道的记录；
  - `dialog.log`：对话框的记录；
  - `worker-*.log`：每个会话一个。

## 已知限制

- 只支持 macOS，确认用的系统对话框也只有 macOS 版本。
- 停止 Agent 靠进程组跟踪：脱离自己进程组的子进程（例如用了 `setsid`）不在跟踪范围内。
- Grok 的实际权限模式无法读回，只能按 `~/.grok/config.toml` 判断；OpenCode 实际生效的权限规则也无法读回。结果里会写明这一点。
- OpenCode 的 ACP 不回传 provider 错误（例如额度用尽），Turnweft 只能靠无活动超时发现。
- 显式指定 Dim 的模型会永久改变该工作区的默认模型，结果里会说明。
- agy 不回报思考强度，结果里显示的是启动时传入的值。
- Claude Code 和 Codex 是宿主，不是委派对象：Turnweft 不会把工作交给它们。

## 卸载

先取消或关闭正在运行的会话（`turnweft session list`，再 `turnweft session close <id> --policy cancel_running`），卸载本身不会停止已经在跑的任务。

```bash
claude plugin uninstall turnweft@turnweft
codex plugin remove turnweft@turnweft
npm uninstall -g turnweft
```

Turnweft 的会话、确认记录和日志保存在 `~/.turnweft`，删除这个目录前会一直保留。

## 开发

```bash
git clone https://github.com/handong66/turnweft.git
cd turnweft
npm install         # 同时启用仓库自带的 git 钩子（已设置 core.hooksPath 时不覆盖；CI 中跳过）
npm run build
npm link            # turnweft 命令改为运行这份代码
npm test            # 核心和宿主层测试，用模拟 Agent，不消耗模型额度
node scripts/live-smoke.mjs droid --model <模型> [--effort <强度>]   # 真实 Agent 端到端测试（消耗额度）
```

每次影响用户的改动都要同步更新文档，并在 [CHANGELOG.md](CHANGELOG.md) 里写一条记录。每次提交和合并时，git 钩子都会检查这一点，并扫描要提交的内容里有没有隐私信息。发布时，`CHANGELOG.md` 里必须有当前版本的一节，最终的 npm 包也会自动扫描。改版本号只用 `npm version <版本>`，它会同步插件说明文件里的版本。

## 许可证

[MIT](LICENSE)
