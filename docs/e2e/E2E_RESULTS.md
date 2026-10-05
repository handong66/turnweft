# 端到端实测记录（2026-10-04，macOS arm64）

本文件记录 M2 阶段的真实链路测试。M0 的协议与能力实测见 `docs/m0/M0_RESULTS.md`。

## 1. 运行时 + 真实 Agent（`scripts/live-smoke.mjs`，提交 a9f868f，两轮交叉评审修复之后）

经由 `LocalService` 和真实 detached worker，对五个 Agent 各跑一遍：修 bug 并测试 → 同一会话追问口令（L1）→ 空闲超时停掉进程（`suspended`）→ 续接后追问口令（L2）→ 中途取消。U11 确认由测试脚本代为完成（`via: cli-tty`），正式使用时由用户本人确认。

| Agent | 测试模型 | U11 档位 | 实施 + 测试 | L1 | 停掉后续接（L2，原生 ID 不变） | 取消 |
| --- | --- | --- | --- | --- | --- | --- |
| Dim 0.5.16 | deepseek-v4.1-flash | workspace-write | ✅ | ✅ | ✅ | ✅ 477 ms |
| Droid 0.233.0 | glm-5.3-flash | normal+callback | ✅ | ✅ | ✅ | ✅ 229 ms |
| Grok 1.0.46 | 默认（grok-4.7） | user-config:always-approve | ✅ | ✅ | ✅ | ✅ 335 ms |
| agy 1.2.16 | 默认 | skip-permissions+accept-edits | ✅ | ✅ | ✅ | ✅ 502 ms |
| OpenCode 1.18.34 | opencode/ling-3.1-flash-free | build+config:default | ✅ | ✅ | ✅ | ✅ 171 ms |

每次实施的改动证据都只列出 `src/math.js`，预先存在的未提交文件 `NOTES.md` 单独列出，不算到 Agent 头上。

OpenCode 说明：`opencode-go/deepseek-v4.1-flash` 在测试时报 `Go usage limit exceeded`，改用支持工具调用的免费模型 `opencode/ling-3.1-flash-free`。build 模式下 OpenCode 没有发出任何权限请求，因为它按自身配置放行（测试机未设置 `permission`），这一点在 U11 档位中如实写明。免费模型偶有 `Upstream request failed: Endpoint is unavailable`，会表现为某一轮变慢或失败。

## 2. Codex 宿主端到端（插件启动器 → `turnweft mcp` → worker → Droid）

方式：`codex exec`（0.160.0），用 `-c mcp_servers.turnweft.*` 按 Codex 插件的注册方式挂载 `plugins/codex/launcher.mjs`；`turnweft` 通过 `npm link` 安装。测试项目为 `/tmp` 下的临时目录。

1. Codex 调用 `turnweft_session create`（droid，模型 glm-5.3-flash）→ `turnweft_ask` → `turnweft_job` 轮询：只读分析成功，准确列出两个 bug，并补充指出负奇数的边界情况。
2. `turnweft_delegate`：返回 `needs_confirmation`，同时给出 `nextAction: confirm_policy` 和 `turnweft policy grant <proposalId>` 的提示。无界面模式下 elicitation 被 Codex 自动 `decline`，任务未启动，文件未改动。
3. 在伪终端中运行 `turnweft policy grant <proposalId>`，输入 `yes`（测试中由 Claude 代替用户操作）。另一次输入在提示出现前就送达、随后流结束，结果为 `confirmation_cancelled`，未授权，符合“异常即拒绝”。
4. `codex exec resume --last`：同一 Codex 线程（`thread_id` 不变，host binding 匹配），用**同一个 requestId** 重新提交 `turnweft_delegate` → 任务接受 → `succeeded`。结果中：`files.changed = ["src/math.js"]`；实际权限 `autonomy_level=normal`、`model=glm-5.3-flash`；Turnweft 代为应答 3 次权限请求。
5. 同一会话继续 `turnweft_ask`：Droid 准确回答改了哪两行，以及这段对话中用户第一个请求的原文（会话连续性）。
6. Codex 自己运行 `node --test test/math.test.js`：2 项通过。

## 2b. Codex 宿主端到端：其余四个 Agent（`scripts/codex-host-e2e.sh`）

同样经由 Codex → 插件启动器 → `turnweft mcp` → worker。每个 Agent 都完成了：创建会话 → 只读分析 → U11 确认（伪终端中的 `policy grant`，测试中由 Claude 代替用户操作）→ 用同一个 requestId 重新提交实施 → 同一会话追问 → Codex 自己运行测试。

| Agent | 实施结果 | 追问（会话连续） | Codex 自测 |
| --- | --- | --- | --- |
| Dim | `src/math.js` 两处修复 | ✅ 说出改动行与最初请求 | 2/2 通过 |
| Grok | 同上（analyze 与 implement 各确认一次，因测试机配置为 always-approve） | ✅ | 2/2 通过 |
| agy | 同上，effectiveMode `permission_mode=always-proceed` | ✅ | 2/2 通过 |
| OpenCode | 同上（ling-3.1-flash-free） | ✅ | 2/2 通过 |

脚本问题（已修正，与 Turnweft 无关）：并行时 `codex exec resume --last` 会接到别的线程，改为按第一阶段记录的线程 ID 续接；后台运行时 `codex exec` 一直等待 stdin，改为 `< /dev/null`。

## 3. Claude Code 宿主端到端（用户在 CC 桌面版交互实测，插件 turnweft@turnweft 0.1.0）

1. `turnweft_agents`：列出五个 Agent 及版本，插件和 MCP 加载正常。
2. **发现并修复的 bug**：第一次在 `m0/fixture-template`（位于 Turnweft 仓库内）创建会话时，Agent 的工作目录被设成了仓库根目录，因此找不到 `src/math.js`。修复（bb0e871）：会话的 `cwd` 就是用户指定的目录；`canonicalRoot`（git 根目录）只用于项目写锁和 U11 策略。
3. 修复后新建 Droid 会话做只读分析：找出两个 bug，本轮改动列表为空。
4. `turnweft_delegate`：**CC 没有弹出确认框**，返回 `confirm_policy`，提示在终端运行 `turnweft policy grant`。用户在终端确认后，CC 用同一个 requestId 重新提交，Droid 修好 `src/math.js`，CC 自己重跑测试，2 项通过。
5. 同一会话追问：Droid 准确说出改了哪两行，以及这段对话中用户第一个请求的内容（会话连续）。
6. 会话标识：同一 CC 对话中的多次调用都被识别为同一宿主，后续提交没有被要求 attach。

本次实测发现、已修复的问题：
- MCP 返回给模型的 proposal 中含有 nonce → 已移除（548c381）。
- 确认框没有弹出时，回退提示不说明原因 → 现在会写明是“宿主未声明支持”“宿主返回 decline/cancel”还是“出错/超时”，并记录到 `~/.turnweft/logs/mcp.log`。CC 为何没有弹出确认框，待下次实测从日志确认。
- 改动证据按整个仓库统计，误把用户同时进行的修改算进来 → 现在只把会话目录内的改动算作本轮改动，目录外的改动单独列为 `changedOutsideCwd`，并提示可能是别人同时改的。

### 3b. macOS 对话框与 U19（等待确认）实测

- macOS 对话框（同步版，812435a）：CC elicitation 13 ms 内被拒 → Turnweft 弹出 macOS 对话框 → 用户 22.8 s 后点“允许” → policy `confirmedVia: native-dialog` → Droid 创建 `hello.txt`。
- 用户反馈：对话框里的“27 秒”不会倒数，且超时即拒绝不合理 → 改为 U19：任务进入 `waiting_confirmation`，对话框由独立进程弹出并一直等待。
- U19 实测（a7cc66c）：11:04:26 弹出对话框，用户约 4 分钟后（11:08:23）点“允许”，等待中的任务自动开始并成功，`/tmp/tw-cc-wait/hello.txt` 已创建，没有重新提交。
- 体验缺口：CC 在提示用户确认后就结束了这一轮，没有继续查询，所以用户感觉“没反应”。已在 skill 中要求同一轮内继续用 `turnweft_job` 查询（最多约 10 分钟）。
- 第二次实测：用户 16 s 后点“允许”，任务成功，但 CC 没有加载 skill，说了“会继续查询”却结束了这一轮。修复（f7f422d）：把“同一轮内继续查询”写进 awaiting_confirmation 结果（`nextAction: poll_until_confirmed`）、等待期间每次 `turnweft_job` 的结果，以及 ask/delegate 的工具描述。
- **第三次实测（f7f422d）：通过。** 对话框弹出后用户等了十几秒点“允许”，CC 一直保持处理中，用户点完后直接报告 `hello.txt` 已创建。

### 交互式 Codex 确认流程（9b812a8，2026-10-04）

- Codex 桌面版，MCP 客户端 `codex-mcp-client` 0.160.0，插件从本仓库的 `.agents/plugins/marketplace.json` 安装。
- 第一次试在 Turnweft 仓库里进行，那里已有 droid × implement 的确认记录，所以直接执行、不弹窗，符合“每个代理 × 项目 × 意图只确认一次”。
- **第二次在新目录 `/private/tmp/tw-codex-dialog` 中进行：通过。**
  - 12:58:59.897：Codex 收到 elicitation 后 2 ms 返回 `decline`。
  - 12:58:59.898：Turnweft 改为弹出 macOS 对话框。
  - 12:59:05.664：用户点“允许”，策略按 `native-dialog` 记录。
  - 12:59:05.757：等待中的任务自动开始。
  - 12:59:19.867：任务成功。
  - Codex 在同一轮内继续查询并报告 `succeeded`、档位 `normal+callback`，以及 `changed=["hello.txt"]`。

## 3c. 公开发布版：五个 Agent × 两个宿主只读实测（2026-10-04）

安装方式与普通用户相同：运行时为 npm `turnweft@0.1.0-alpha.0`，CC 和 Codex 的插件都从 GitHub `handong66/turnweft` 安装。每组都新开一个无界面宿主会话，只允许使用 Turnweft 工具：创建会话 → `turnweft_ask`（analyze）读 README 第一行 → 用 `turnweft_job` 查询到结束。Grok 的 analyze 档位比授权宽（测试机配置为 always-approve），所以在已确认过的测试目录中运行。

| Agent | 模型 | 档位 | CC | Codex |
| --- | --- | --- | --- | --- |
| Dim | dimcode-api-oauth/deepseek-v4.1-flash | read-only | ✅ 36 s | ✅ 53 s |
| Droid | glm-5.3-flash | normal+callback-readonly | ✅ 23 s | ✅ 45 s |
| OpenCode | opencode/ling-3.1-flash-free | plan+callback-readonly | ✅ 45 s | ✅ 63 s |
| agy | 默认 | request-review | ✅ 33 s | ✅ 57 s |
| Grok | 默认 | user-config:always-approve | ✅ 31 s | ✅ 47 s |

耗时是整个宿主会话的时间，包括宿主模型自身的推理。十组答案都正确。

发现的问题：Grok 在调用工具前说的一句话（"I'll read README.md…"）和最终答案被直接首尾相连，中间没有换行。修复后，工具调用或权限请求前后的文字之间加一个空行，内容不删减。该修复随 0.1.0-alpha.1 发布；从 npm 升级后在 CC 中复测 Grok，最终文本为“I'll read the first line of `README.md` …”加空行，再接“# tw-fixture”。

## 3d. 宿主 bypass 模式授权（U21，2026-10-05）

用户反馈：在开了 bypass 的 CC 对话里，委派任务仍要求去终端确认。原因是那个对话的插件工具已经失效（插件重装之前开的对话），Claude 改为调用 `turnweft send`，而命令行路径当时只提示去终端确认、不弹窗。修复后：

- bypass 对话直接放行；
- 命令行路径需要确认时，也弹出 macOS 对话框。

实测在开发模式（`npm link`）下进行，用 Grok 在全新目录中写文件。这类任务的档位比授权宽，原本必须确认：

| 宿主与模式 | 结果 |
| --- | --- |
| CC，`--permission-mode bypassPermissions` | ✅ 直接执行，文件已写入；提示 `Authorized by the host's bypass mode (claude-code:bypassPermissions)` |
| CC，`--permission-mode default` | ✅ 进入 `waiting_confirmation`，文件未写入（测试时用 `TURNWEFT_NO_NATIVE_DIALOG=1` 关掉了对话框） |
| Codex，`-s danger-full-access` | ✅ 直接执行，文件已写入；提示 `codex:danger-full-access` |
| Codex，`-s workspace-write`（无界面） | 未到 Turnweft：Codex 在审批策略为 never 时自己拒绝了 MCP 工具调用。桌面版普通模式下，Codex 会先请用户允许工具调用；这一路的 Turnweft 行为只由自动化测试覆盖 |

CC 的 `auto` 模式及其他非 bypass 模式照常弹窗，由 `src/tests/host-mode.test.ts` 覆盖。

第 11 轮交叉评审（Codex）发现上面这一版的信号可以伪造：

- 它用正则扫描对话记录，会误认模型写在工具参数里的 `permissionMode` 字样；
- 命令行路径下，可以通过环境变量指向伪造的、或别的对话的记录；
- 对话记录异步写入，模式切换后可能滞后；
- 已有长期确认时，bypass 授权会被丢弃；
- 排队期间档位变化，bypass 任务仍会执行新档位。

修复后：

- CC 改用插件的 PreToolUse 钩子取得本次调用时的 `permission_mode`；
- 命令行不再接受 bypass 信号；
- bypass 授权独立保存，并绑定提交时的权限指纹。

修复后（93570f3）的实测结果如下，CC 插件从 GitHub 重装，带钩子：

| 宿主与模式 | 结果 |
| --- | --- |
| CC，`bypassPermissions` | ✅ 直接执行，文件已写入，`authorizedBy: claude-code:bypassPermissions` |
| CC，`default` | ✅ `waiting_confirmation`，文件未写入 |
| CC，`default`，先用 Bash 写入伪造的 bypass 钩子记录，再调用 | ✅ 伪造记录被钩子用真实模式覆盖，仍为 `waiting_confirmation`，文件未写入 |
| Codex，`-s danger-full-access` | ✅ 直接执行，文件已写入 |

第 12 轮评审后（33d1601），钩子记录改为绑定整次调用（工具 + 全部任务参数）、有效期 15 秒、参数无效也会被消耗。CC 插件从 GitHub 重装后复测：`bypassPermissions` 直接执行（说明钩子和运行时对真实调用参数算出的摘要一致），`default` 进入 `waiting_confirmation`，结束后 `~/.turnweft/host-mode/` 下没有残留记录。

## 4. 插件启动器

- 运行时已安装（`npm link`，`/opt/homebrew/bin/turnweft` 为指向 `dist/cli/main.js` 的符号链接）：启动器找到运行时，并成功启动 `turnweft mcp`（上面第 2 节即经由它运行）。
- 找不到运行时、运行时版本过低：启动器改为提供只含 `turnweft_setup` 的 MCP 服务，调用后返回安装或升级说明。

## 5. 尚未完成

- **CC 确认框（已查明）**：CC 2.1.286 桌面版声明 `elicitation: {form, url}`，但收到表单确认请求后自动返回 `decline`，耗时 4–6 ms，“Bypass permissions”和“Manual”两种模式下都一样。因此 CC 先弹 macOS 对话框（U18），终端确认（`turnweft policy grant`）作为第三通道。不做链接式（url）确认：它需要一个本机网页服务，任何本机进程（包括能执行命令的模型）都能访问，比要求真实终端的 CLI 确认更弱。
- **CC 中 ▷ 运行按钮**：命令在伪终端中运行，通过了 TTY 检查并显示确认内容，但内嵌输出框不接受输入，无法输入 `yes`。需要在终端面板或自己的终端中运行。
- **交互式 Codex 确认框（已查明）**：Codex 0.160.0 桌面版同样自动 `decline`（2 ms），所以走 macOS 对话框，实测通过（见第 3 节）。
