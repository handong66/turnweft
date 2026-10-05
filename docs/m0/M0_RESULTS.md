# M0 实测结果（2026-10-04，macOS arm64）

本文件是 M0 实测的权威记录。设计文档 §3.2、§11 引用这里的结论。原始帧日志在 `m0/results/`（只保存在本机，不公开：Agent 运行时加载的本机上下文，例如记忆、skill 列表和本机路径，会被一起录下），测试脚本在 `m0/probes/`，测试项目模板在 `m0/fixture-template/`（每次运行复制到 `m0/runs/`，不提交）。

**判分方式**：每次运行后用固定命令 `node --test test/math.test.js` 判断测试结果，不依赖测试项目的 npm 脚本。测试项目最初的 `npm test` 脚本（`node --test test/`）在 Node 25 上本身就会失败，属于测试夹具缺陷，已修正（`test/*.test.js`）；在此之前记录的“tests: fail”已按固定命令重新判分。Dim、Droid、Grok 在任务中都自行发现并修好了这个脚本。

## 1. 版本

| 目标 | 版本 | 入口 |
| --- | --- | --- |
| Dim | dimcode 0.5.16 | `/Applications/DimAgent.app/Contents/Resources/runtime/cli/dim acp` |
| Droid | 0.233.0 | `droid exec --output-format acp` |
| Grok | 1.0.46 | `grok agent --no-leader stdio` |
| OpenCode | 1.18.34 | `opencode acp` |
| agy | 1.2.16 | `agy --input-format stream-json --output-format stream-json --add-dir <root> -p=` |

## 2. 无 prompt 协议探针（不调用模型）

| 目标 | `initialize` | session 配置项（默认值） | 未知 ID 的 load / resume |
| --- | --- | --- | --- |
| Dim | loadSession；fork / list / resume / close | mode=agent；model=用户当前选择；**permission=read-only**（read-only / workspace-write / full-access）；thought_level | `-32002 ACP session not found` |
| Droid | loadSession | **autonomy_level=normal**（normal / spec / auto-low / auto-medium / auto-high）；model=gpt-6-sol；reasoning_effort | `-32602 Unknown session identifier` |
| Grok | loadSession；list / resume / close | model；reasoning_effort。**无权限配置项** | `-32603 Path not found (FS_NOT_FOUND)` |
| OpenCode | loadSession；fork / list / resume / close | model；effort；mode=build（build / plan）。**无权限配置项** | `-32603 OpenCode service failure`（不具体） |

四个 ACP 入口用未知 ID 加载时都会报错，不会静默新建；但错误码不统一，adapter 需要按目标分别归类为“会话不存在”。

session ID 格式不统一：Dim 为 `sess_<ts>_<rand>`，OpenCode 为 `ses_…`，Droid 和 Grok 为 UUID。“只接受 UUID”只能作为针对具体 adapter 的规则。

### 2.1 思考强度（U23，2026-10-05，无 prompt）

四个 ACP 目标都有一个 `category: "thought_level"` 的 select 配置项，只是 id 不同；agy 只有启动参数。可选值随模型变化，下表是测试机上各自默认模型的结果。

| 目标 | 配置项 | 默认值 | 可选值 | 其他模型下的变化 | 非法值 |
| --- | --- | --- | --- | --- | --- |
| Dim | `thought_level` | auto | auto / none / high / max | glm-5.3-flash：auto / high / max | `Invalid params: Unknown ACP thought level value` |
| Droid | `reasoning_effort` | high | none / low / medium / high / xhigh / max | glm-5.3-flash：low / high / max | set 返回 `{}`，不报错，强度保持不变：**只能靠读回发现** |
| Grok | `reasoning_effort` | high | low / medium / high / xhigh | — | 未测 |
| OpenCode | `effort` | low | low / high / max / default | ling-3.1-flash-free：low / medium / high / default；**切换模型会把强度重置为 low** | 未测 |
| agy 1.2.17 | `--effort` | — | low / medium / high / xhigh / max | — | 启动即退出：`invalid --effort "…" (valid: …)`；init 事件不回报强度 |

- Dim 的 `thought_level` 只作用于当前 session：设成 max 后新开 session（同目录或别的目录）仍是 auto，没有可改的持久默认值。
- 因此 Turnweft 的顺序是：权限档位 → 模型 → 思考强度，并按当前模型的可选值校验、再读回核对。
- **会话内调整**：四个 ACP 目标都能在运行中的会话里直接 `set_config_option` 改强度，不需要重启进程（Dim 约 200 ms，Droid / Grok / OpenCode 100 ms 以内）；非法值被拒绝后保持原强度。Droid 即使设成当前值也会发 `config_option_update`，所以"只认新回报"不会多等。

## 3. 真实任务（ACP，消耗额度）

场景：①在真实测试目录修两个 bug 并跑测试，同时记住一个随机口令；②同一进程内追问口令（L1）；③关闭进程，新进程 `session/load` 后追问口令（L2）；④让它执行 `sleep 45`，12 秒后发 `session/cancel`。Turnweft 探针对所有权限请求回答 `allow_once`。

| | Dim | Droid | Grok |
| --- | --- | --- | --- |
| 设置 | model=deepseek-v4.1-flash，permission=workspace-write | model=glm-5.3-flash，autonomy 保持 normal | 默认 |
| 设置读回 | `set_config_option` 返回值即读回 | 返回 `{}`；读回靠 `config_option_update` 通知或 `session/load` 返回值 | — |
| 修 bug + 测试 | ✅ | ✅ | ✅ |
| 权限请求 | 8 次，全为 execute（`exec`） | 6 次：edit 与 execute，标题含命令和风险级别，例如 `` `npm test` (low) `` | **0 次**（见下） |
| L1 追问 | ✅ | ✅ | ✅ |
| L2：新进程 load 后追问 | ✅（load 后 permission 仍为 workspace-write） | ✅（load 后 model=glm-5.3-flash） | ✅ |
| 取消 | `stopReason: cancelled`，约 12 秒 | 同左 | 同左 |

**Grok 零权限请求的原因**：测试机的 `~/.grok/config.toml` 配置为 `permission_mode = "always-approve"`。Turnweft 尊重原生配置，但必须在结果中如实回报“Grok 当前为全部自动批准”，并按 U11 记录它比 grant 宽的部分。ACP 下能否针对单个会话覆盖这个模式，尚未验证。

**OpenCode**：与其他三家并行运行时，卡在 `session/new` 十几分钟无响应（单独运行的无 prompt 探针中 `session/new` 正常）。已单独重跑，结果见 §6。

## 4. agy 长连接 stream-json（消耗额度）

- **输入格式**（通过解析器报错探出）：`{"event":"user","message":{"content":[{"type":"text","text":"..."}]}}`；内容块只支持 `text`。
- 每条输入跑一轮，每轮以 `{"event":"result", ...}` 结束；`init` 事件给出 `conversation_id` 与 `permission_mode`（默认 `request-review`）。
- **L1 与 L2 都通过**：同一进程内追问正确；关闭后用 `--conversation <id>` 新进程追问正确，ID 不变。
- **权限**：
  - `--mode accept-edits` 下，无界面时**文件编辑被允许**（成功修好两个 bug）。
  - 未匹配允许规则的命令（如 `npm test`）被自动拒绝。拒绝后这一轮立即结束、回复为空，但 **`status` 仍为 `SUCCESS`**，只在 `result.denied_actions` 中列出被拒操作。adapter 必须把非空 `denied_actions` 视为“被权限阻断”，不能报告成功。
  - `settings.json` 中的 `permissions.allow` 规则在无界面时生效：测试机已有的一条 `command(cp)` 允许规则让 `cp` 命令直接执行。agy 自己的报错文案也建议用这种方式添加允许规则。
  - 另有项目级授权：`~/.gemini/config/projects/<id>.json` 的 `permissionGrants.allow`（规则如 `read_file(<path>)`、`command(<name>)`），与 agy 的 `--project` 关联。
  - 结论：agy 的 U11 档位可以用“`accept-edits` + 精确的命令允许规则”表达，**不需要** `--dangerously-skip-permissions`。规则写在哪里（项目级 grant 还是用户级 settings），M2 定。
- **中断**：发 SIGINT 后这一轮约 4 秒结束，进程仍可继续接收下一轮。

## 5. Droid 原生 stream-json 已弃用

Droid 0.233.0 二进制中有提示：“stream-json is deprecated. Use --input-format stream-jsonrpc for daemon-compatible JSON-RPC protocol.” 再结合 §3 的结果（ACP 的 `normal` 档逐次请求许可、可设置可读回、L1 和 L2 通过），**Droid 主路径改为 ACP**；原生 stream-json 不再作为候选。

## 6. OpenCode 单独重跑

单独重跑时 `session/new` 正常（约 6 秒）。但 `session/prompt` 发出后，ACP 一侧再无任何 update，也没有响应。OpenCode 自己的日志（`~/.local/share/opencode/log/opencode.log`）显示：默认模型 `opencode-go/deepseek-v4.1-flash` 报 `AI_APICallError: Go usage limit exceeded`，用于生成标题的 `opencode/mimo-v2.6-flash-free` 重试 3 次后也失败。

- **结论**：OpenCode 1.18.34 的 ACP 入口**没有把 provider 错误回传给客户端**，`session/prompt` 会一直挂起。Turnweft 必须为每一轮设置“无活动超时”（watchdog），超时后取消该轮，并附上 provider 日志中的最近错误作为诊断。
- 本轮 OpenCode 测试使用默认模型，未换模型；真实任务测试改用其他模型补做（见 `docs/e2e/E2E_RESULTS.md`）。ACP 的协议能力已由 §2 的无 prompt 探针确认。

## 7. 宿主探针

- **CC**：无界面实验因 CLI 登录过期没有跑成。但 MCP `initialize` 中 CC 声明了 `elicitation: {form: {}, url: {}}` 与 `roots`。“确认框能否呈现给人”需要在交互界面中实测。
- **Codex 0.160.0（`codex exec`，用 `-c mcp_servers.*` 临时挂载，只在本次运行中生效）**：
  - MCP `initialize` 声明 `elicitation: {form: {}, url: {}}`。
  - 在本次测试配置下（`approval_policy = "never"`，turn 元数据显示 `sandbox_mode: danger-full-access`），`tw_probe_echo` 与 `tw_probe_delegate` 都**未经询问直接执行**。这再次说明工具放行不能当作 U11 确认凭据。
  - 无界面时，`elicitation/create` 在 12 ms 内返回 `{"action":"decline"}`：没有人时自动拒绝，不会自动接受。
  - **每次 `tools/call` 的 `_meta` 都带有 `x-codex-turn-metadata`**：`session_id` / `thread_id`（稳定的宿主会话标识）、`turn_id`、`model`、`sandbox_mode`、`workspaces`（工作区根目录 → git 远端、最新提交、`has_changes`）、`codex_version`。另有 `callId` 与 `progressToken`。host binding（§8.2）可以直接用 `thread_id`，不需要猜测或读取私有文件；`sandbox_mode` 只作参考信息，不作为授权凭据。
  - 生命周期：`codex exec` 结束时，MCP server 收到 stdin 结束信号，随之退出。交互式 Codex 与桌面客户端的生命周期尚未测试。

## 8. 对设计的影响（写入设计 0.4）

1. Droid：主路径改为 ACP；`autonomy_level=normal` 下由 Turnweft 逐次应答 edit / execute 请求（精细，不需要粗档位）。只有用户明确选择档位时才设 auto-*，并按 U11 回报。
2. ACP 层服务 Dim、Droid、Grok、OpenCode；原生层只服务 agy。
3. agy：`accept-edits` + 精确命令允许规则；检查 `denied_actions`。
4. Grok：遵从用户 config 的 permission_mode，并回报实际模式。
5. 未知会话错误按目标归类；session ID 格式按目标校验。
6. 设置读回：Droid 依赖 `config_option_update` 通知，其他三家用 `set_config_option` 返回值。
