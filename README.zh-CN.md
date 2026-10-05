# Turnweft

[English](README.md)

在 Claude Code 和 Codex 中使用持久的 Agent 会话。

在 Claude Code（CC）或 Codex 中把任务委派给 **Dim、Droid、Grok、OpenCode、agy**。被委派的 Agent 在你当前项目的真实目录里读写和运行命令，会话可以持续追问；已经确认过的权限不重复询问。

> 状态：`0.1.0-alpha`，只支持 macOS。设计与决策见 [TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md](TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md)，协议实测见 [docs/m0/M0_RESULTS.md](docs/m0/M0_RESULTS.md)，端到端实测见 [docs/e2e/E2E_RESULTS.md](docs/e2e/E2E_RESULTS.md)。

## 工作方式

```
CC / Codex ──MCP──▶ turnweft mcp ──▶ 共享状态库（~/.turnweft/state.sqlite）
                                          │
                                          ▼
                              每个活跃会话一个后台 worker
                                          │
                 ┌──────────── ACP ───────┴──────── 原生 stream-json ─┐
                 ▼          ▼          ▼          ▼                    ▼
                Dim       Droid      Grok     OpenCode               agy
```

- **会话持续**：每个 Turnweft 会话绑定一个原生会话 ID。空闲超时后停掉进程，下次追问时用原生 ID 续接（L2）；续接不了就明确报错，不会偷偷新建会话。
- **真实目录**：默认直接在项目目录工作，不复制、不建 worktree。每轮结果分开列出“本轮改动的文件”和“之前就有的未提交改动”。
- **权限**：每次打开或续接都重新设置原生权限档位，并读回确认。档位比当前授权宽时，同一项目、同一 Agent、同一意图只请你确认一次（见下文“权限确认”）；每次结果都写明实际档位。
- **不重复执行**：调用方生成 `requestId`，重试时返回原任务。投递后断线的任务标为 `in_doubt`（待核对），不会自动重发。

## 安装

需要 macOS、Node.js ≥ 22.13，以及你要用的 Agent CLI（各自已登录）。

```bash
npm install -g turnweft
turnweft doctor     # 检查五个 Agent 是否可用，不启动模型任务
```

Turnweft 先在 PATH 中查找各 Agent 的 CLI，再查找常见安装位置（`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`，以及 `~/.opencode/bin` 和 DimAgent.app 内置的 `dim`），从程序坞启动的宿主 PATH 较短时也能找到。其他路径可在 `~/.turnweft/config.json` 中用 `executables` 指定。

### Claude Code

```bash
claude plugin marketplace add handong66/turnweft
claude plugin install turnweft@turnweft
```

### Codex

```bash
codex plugin marketplace add handong66/turnweft
codex plugin add turnweft@turnweft
```

装好后重启 Codex，新对话才会加载插件。

两个插件只包含 MCP 注册、Skill 和启动器；运行时统一来自 `turnweft` 命令。找不到运行时或版本过低时，插件只提供一个 `turnweft_setup` 工具，调用后返回安装说明。

## 权限确认

档位比当前授权宽时，任务先记为 `waiting_confirmation`（等待确认），这时什么都不会运行：

1. Turnweft 先请宿主弹出确认框。实测 CC 2.1.286 和 Codex 0.160.0 桌面版都会自动回绝，不显示给你。
2. 于是 Turnweft 在屏幕上弹出 macOS 对话框，写明 Agent、项目、档位和超出授权的部分。对话框会一直等你选择，不会因为没有回应就默认拒绝。
3. 点“允许”后，等待中的任务自动开始，不需要重新提交；点“拒绝”则取消任务（`confirmation_denied`）。提案 24 小时后过期（`confirmation_expired`）。
4. 命令行 `turnweft send` 需要确认时，同样弹出这个对话框。也可以在终端运行 `turnweft policy grant <proposalId>`，输入 `yes` 允许、`no` 拒绝。它拒绝非终端输入，也没有自动同意的参数，但分辨不出是谁在输入：请自己运行，不要让带终端工具的 Agent 代为执行。

**开了 bypass 的对话不再询问。** 宿主对话处于 bypass 模式时，Turnweft 直接放行任务：不生成提案，也不弹窗。它只认宿主为这一次调用给出的信号。Claude Code：插件自带的 PreToolUse 钩子会在每次 `turnweft_ask` / `turnweft_delegate` 调用前，从 Claude Code 拿到当前对话的权限模式，必须是 `bypassPermissions`（auto 模式和其他模式照常弹窗）。Codex：本次调用附带的元数据里，`sandbox_mode` 必须是 `danger-full-access`（完全访问）。放行只对这一个任务、以及提交时的权限范围有效，不会记住，所以同一项目在没开 bypass 的对话里照常询问。命令行 `turnweft send` 永远不会自动放行。结果写明实际档位和 `authorizedBy`。

确认结果按 Agent × 项目 × 意图保存，在仍然有效期间同类任务不再询问；Agent 版本变化或档位允许的范围变化时会重新询问。`turnweft policy list` 查看，`turnweft policy revoke <id>` 撤销。

给人看的文字（对话框、命令行输出、确认内容）有中英两种。要固定语言，在 `~/.turnweft/config.json` 中写 `"language": "zh"` 或 `"en"`；从程序坞启动的宿主读不到终端里的环境变量，用这种方式同样有效。没有设置时，依次按 `TURNWEFT_LANG`、`LC_ALL`、`LC_MESSAGES`、`LANG`、macOS 系统首选语言选择，都没有则用英文（`TURNWEFT_LANG` 优先于配置文件）。面向模型的工具描述和 warnings 始终为英文，已有确认记录保留原文。

## 命令行

```bash
turnweft session create --agent droid --cwd .        # 返回 tws_… 会话 ID
echo "修复 src/math.js 的 bug 并跑测试" | turnweft send --session tws_… --intent implement
turnweft job wait twj_… --include-result
turnweft cancel twj_…
turnweft policy list
turnweft session close tws_…
```

## 各 Agent 的接入方式（M0 实测，macOS）

| Agent | 接入 | 实施时的原生档位 | 写入 | 同会话追问 | 停掉后续接 | 取消 |
| --- | --- | --- | --- | --- | --- | --- |
| Dim 0.5.16 | ACP | `permission=workspace-write`，命令请求由 Turnweft 应答 | ✅ | ✅ | ✅ | ✅ |
| Droid 0.233.0 | ACP | `autonomy_level=normal`，编辑和命令请求逐次由 Turnweft 应答 | ✅ | ✅ | ✅ | ✅ |
| Grok 1.0.46 | ACP（`agent --no-leader stdio`） | 遵从你的 `~/.grok/config.toml`（比你的授权宽时需确认一次） | ✅ | ✅ | ✅ | ✅ |
| agy 1.2.16 | 原生长连接 stream-json | 跳过权限检查 + accept-edits（需确认一次） | ✅ | ✅ | ✅ | ✅ |
| OpenCode 1.18.34 | ACP | `mode=build`，按 OpenCode 自身权限配置运行（需确认一次） | ✅ | ✅ | ✅ | ✅ |

## 已知限制

- 只支持 macOS；确认用的系统对话框也只有 macOS 版本。
- 进程停止靠进程组跟踪：Agent 用 `setsid` 等方式脱离自己进程组的子进程不在跟踪范围内。
- Grok 的实际权限模式无法读回，只能按 `~/.grok/config.toml` 判断；OpenCode 生效的权限规则也无法读回。结果中会写明这一点。
- OpenCode 的 ACP 不回传 provider 错误（例如额度用尽），只能靠无活动超时发现。
- 显式指定 Dim 的模型会持久改变该工作区的默认模型（U14），结果中会说明。
- Turnweft 不指定模型：各 Agent 默认用自己的模型，除非你显式传入。

## 开发

```bash
git clone https://github.com/handong66/turnweft.git
cd turnweft
npm install
npm run build
npm link            # 用这份代码提供 turnweft 命令
npm test            # 核心 + 宿主层测试（模拟 Agent，不消耗额度）
node scripts/live-smoke.mjs droid --model <模型>   # 真实 Agent 端到端（消耗额度）
```

## 许可证

[MIT](LICENSE)
