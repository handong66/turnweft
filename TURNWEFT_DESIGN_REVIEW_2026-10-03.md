# Turnweft 设计草案 0.1 评审

> 评审对象：`TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md`（0.1，825 行）  
> 评审日期：2026-10-03（本机时区）  
> 评审方式：只读。核对了本机五个 CLI 的 `--version` / `--help`、Dim 安装位置、`agy-plugin-codex` 参数构造源码。未运行模型任务，未修改旧插件或设计文档本身。

## 结论：需要修改后试验

总体方向成立：MCP 作宿主入口、下游按目标选 ACP 或原生协议、三维度（intent / workspaceMode / effectivePolicy）拆分、accepted / delivered / completed 分离、L1/L2/L3 分级，都是对的。

但有一个设计矛盾必须在 M0 之前定案，否则 M0 退出条件“原项目实施、复用现有授权”无法通过，或只能靠违反 §7.4 通过：**授权模型要求精确表达，而 Droid / agy / OpenCode 的原生权限都是粗粒度档位**。另外，本机证据推翻或补充了 §3.2 与 §18.3 的几处能力判断，影响 ACP 层的范围和首个纵向切片的选择。

## 发现

### F1【阻断】§7.4 的“无法精确表达就返回 mismatch”与粗粒度原生权限冲突，实际会让默认实施落空

- **对应**：§7.3、§7.4、§11.2、§11.5；U06–U08；M0 退出条件。
- **证据**（本机 help，已核对）：
  - Droid 0.233.0 `droid exec`：**不带参数时默认只读**。`--auto low` 只允许文件创建和修改，不允许装包或构建；跑测试、构建需要 `--auto medium`，而这一档同时放开本地 `git commit/checkout/pull` 和“可信端点”联网。另外，`stream-jsonrpc` 模式下 `--auto` 和 `-m` 不生效，会话设置要走 JSON-RPC。
  - agy 1.2.16：`--mode` 只有 `accept-edits | plan`，另有 `--dangerously-skip-permissions` 和 `--sandbox`。旧代码（`agy-cli.ts:426-455`）记录了 1.1.18 的情况：任何一次拒绝都会终止运行并清空答案。因此旧代码实施时同时用 `--dangerously-skip-permissions --mode accept-edits`。
  - Grok 1.0.46 粒度较细：`--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`，加上 `--allow/--deny` 规则和 `--sandbox <PROFILE>`。
- **失败路径**：`WorkspaceGrant{write, execute:task-scoped, network:denied}` 映射到 Droid 时，最接近的能跑测试的档位是 `medium`，比 grant 宽。§7.4 只定义了“全局放开 → mismatch”，没有定义“比 grant 宽但不是全局”怎么处理。保守实现会返回 mismatch，实施任务失败；放宽实现又违反 §7.4 的字面要求。agy 如果在 1.2.16 上仍是“拒绝即终止”，唯一可用的实施路径仍是 skip-permissions，结果也一样。还有一种更隐蔽的情况：adapter 漏传 `--auto`，或者 ACP 下没有通过 JSON-RPC 设置 autonomy，Droid 就会**静默运行在只读模式**，正好重现用户对旧 agy 插件的不满。
- **对用户目标的影响**：对三个目标而言，“默认原项目实施”在设计上没有可通过的路径。
- **最小修改**：
  1. 在 §7.4 增加“方向化映射”：原生模式比 grant **窄**时，在提交前报 mismatch（禁止静默降级成只读）。原生模式比 grant **宽**时，允许执行，但必须事先有一条持久的 `user-policy`，按 provider × 项目 × intent 记录“接受该超范围档位”（例如 `droid.implement = auto-medium`，`agy.implement = skip-permissions+accept-edits`）。每次结果都要回报实际档位与 grant 的差集。
  2. 这条 user-policy 每个项目、每个 provider 只确认一次，之后复用，满足 U08。
  3. adapter 合约测试增加一条：在 implement 意图下，**读回** effective autonomy/mode，如果不是写能力档位就失败。不能只检查参数里是否传了 flag。
- **验证实验**：Droid 的 ACP 和 stream-json 两条路径分别执行“改一个文件并跑 `npm test`”，读回会话的 autonomy，确认不设置时为只读。agy 1.2.16 在不跳过权限、仅用 `accept-edits` 时执行“改文件 + 跑测试 + 读 `.env`”，看拒绝是否仍然终止运行并丢失答案。

### F2【重要】“宿主授权来源”可以直接复用宿主自己的 MCP 工具审批，目前 D03 留空

- **对应**：§7.2、§10.1、D03；问题 2。
- **分析**：MCP server 拿不到宿主的权限模式，这一点文档已经承认。但有一个现成的、可信的授权事件：**用户（或用户的 allowlist）批准了某个 MCP 工具调用**。CC 和 Codex 都会按自己的权限规则拦截 MCP 工具调用，用户可以一次性 allow，之后就不再询问，这正好满足 U08。问题在于宿主的规则通常按**工具名**匹配，不按参数匹配。如果读和写共用一个 `turnweft_send(intent=...)`，用户就无法做到“只读任务自动放行、实施任务需要确认”，也无法“一次放行实施”。
- **最小修改**：按授权边界拆分工具名，例如 `turnweft_ask`（analyze）和 `turnweft_delegate`（implement），让宿主的原生审批承担“本轮许可”。由 F1 的 user-policy 承担“provider 超范围档位许可”。这样不需要自建确认向导。`turnweft_permission` 在找到可信通道之前不要开放：模型调用工具就能“自批”，不是可信通道。可信通道的候选是 MCP elicitation（由宿主直接向用户呈现，绕过模型）。
- **验证实验**：在 CC 和 Codex 中分别确认：①MCP 工具能否按名称单独 allow 或 ask；②两个宿主是否支持 MCP elicitation，以及在后台 job 期间能否弹出。这两项都**未核实**。

### F3【重要】§3.2 能力表遗漏了原生多轮路径，ACP 层的范围可能比设想的小

- **对应**：§3.2、§6.3 `transport-acp/`、§11.1–11.2；问题 5、8。
- **证据**（已核对）：
  - Droid：`--input-format stream-json`（help 原文是“for multi-turn sessions”）以及 `stream-jsonrpc`；`-s/--session-id` 续接，`--fork`。
  - Dim：**已定位**。CLI 是 app 内置的 `/Applications/DimAgent.app/Contents/Resources/runtime/cli/dim`，版本 `dimcode 0.5.16`，不在 PATH 中。提供 `dim acp`（stdio）、`dim acp --auth-setup`、`dim exec resume <id|--last>` 和 `dim session <command>`。
  - Grok：`-s/--session-id` 可以为**新**会话**预先指定** UUID。`--resume` 遇到非 UUID 的参数会按**标题**匹配。`--continue` 取当前目录最近的会话。
  - OpenCode `acp`：带 `--port`（默认 0）、`--hostname`（默认 127.0.0.1）、`--mdns`。传输究竟只用 stdio，还是同时起了本地监听，需要确认。
- **影响和修改**：
  1. Droid 的 L1 候选应同时列出 ACP 和原生 stream-json，M0 二选一。如果 stream-json 更稳定、`--auto` 生效路径更清楚，ACP 层在首版只服务 Dim 和 OpenCode，这会改变 D01 的权衡（见 F4）。
  2. §8.3 增加一条 adapter 规则：**能预先指定原生 ID 的目标一律预分配**（Grok `-s`），从根上消除“启动后抓 ID”的竞态。续接时只传 UUID 形态的 ID，禁止标题匹配和 `--continue/--last`。运行结束后核对返回的 ID 与请求的 ID 一致，这一条覆盖 A16。
  3. Dim 内置在 app 里，带来一个新风险：**app 自动更新会在会话运行期间替换二进制**。doctor 和 capabilities snapshot 要记录路径加版本，发现漂移时标记为 L2 待复验。
  4. OpenCode ACP 启动必须显式关闭 mdns，并确认是否存在监听端口。

### F4【重要】runtime owner 可以进一步精简：不建中心 broker，采用“每 session 一个后台 worker”

- **对应**：§6.2、§9、D01、D02、D12；问题 3、8。
- **分析**：A14（MCP 重启后任务继续）要求执行者与 MCP 进程分离，但不要求一个中心 broker。旧 `grok-plugin-codex` 的 `job-store.ts` / `job-worker.ts` 已经验证了“独立 worker + 持久状态”的模式。建议做法：
  - 每个 Turnweft session 对应一个 detached worker，它就是该原生连接的**唯一** owner，由 session 锁文件（flock 加 generation）保证互斥。L1 会话的 worker 空闲时继续存活，直到显式 close；只有 L2 会话才允许空闲释放。
  - 项目级写锁同样用 flock，不需要常驻调度进程。
  - MCP 前端和 CLI 都只做“读写状态库 + 唤醒或拉起 worker”。
  - ACP 客户端直接用官方 ACP TypeScript SDK（包名需核对）。acpx 只作为实现参考，**不嵌入它的会话持久化和队列**，从结构上消除 D02。如果 M0 发现 `acpx/runtime` 可以完全关闭自身持久化和排队，再考虑引入。
  - 存储可以评估 Node 内置 `node:sqlite`，避免原生模块的打包问题。具体从哪个 Node 版本起无需 flag，需要核对；acpx 自身要求 ≥22.13。
- **好处**：去掉 broker 的 IPC 鉴权、握手版本和调用方绑定（§6.2 第 5 条）这一整块；D13 也缩小为文件权限问题。
- **验证实验**：kill MCP 前端后 worker 继续运行并写入结果（A14）；kill worker 后另一个入口抢锁失败，且确认旧进程已死后才接管（A15）。

### F5【重要】未覆盖的状态

- **对应**：§8.4、§8.5、§9.2；问题 6。
  1. **无宿主在线时的 `waiting_permission`**：后台 job 等待审批时，原宿主聊天已经关闭。需要定义：保持挂起直到某个已绑定宿主 attach，或者在 `permissionTimeout` 后取消或进入 in_doubt。挂起时间是否计入执行预算也要定。
  2. **L1-only 会话遇到重启、睡眠或 worker 崩溃**：应该进入一个明确的终态（例如 `lost`，或 `broken` 加上“上下文已丢失”），而不是 `recovering`。可以给用户提供 L3 交接入口。
  3. **provider 认证过期或需要重新登录**：单独定义错误类别 `auth_required`，session 保持可用，不进入 broken。
  4. **provider 二进制在会话中途升级**（Dim app 更新、`agy update`、`droid` 自更新）：capabilities snapshot 失效，L2 跨版本恢复需要复验。
  5. **会话中途修改 model / mode**：当前 Droid ACP 只能通过 JSON-RPC 设置。原生会话不支持改模式时，按 §7.3“新建并交接”处理，需要能在状态中看出来。

### F6【建议】更早交付可信纵向切片

- **对应**：§15 M1/M2；问题 9。
- M1 只用 fake provider，范围又很大（A07–A15）。而最危险的假设（D03 授权映射、F1 粗粒度档位）只有接上真实 provider 才会暴露。
- **建议**：M0 之后先做 **M1a 纵向切片**：CC → Turnweft MCP → **Droid** → 在真实目录实施 → 同一会话追问 → 取消 → MCP 重启后查询结果。选 Droid 有三个理由：它是用户最初提出的问题；它的默认只读正好用来压测 F1；它同时有 ACP 和原生两条路径可以对比。状态机和 fake provider 只做到这条路径需要的程度，A07–A15 的其余部分放到 M1b 补齐。

### F7【建议】工具和模块可以删减

- **对应**：§6.3、§10.1；问题 8。
- 工具：合并 `status` 和 `result`，成为 `turnweft_job`（返回状态、事件游标、分页结果）。`permission` 在可信通道明确前不开放（F2）。`handoff` 本来就排在后期。加上 F2 的拆分，首版约为 `agents / session / ask / delegate / job / cancel` 六个工具。
- 模块：首版用单包、按目录分模块即可，不需要六个 workspace 包。`transport-acp/` 的规模取决于 F3 的结论。

### F8【建议】文档事实需要更新

- §3.2 和 §18.3 的 Dim 行：已定位，见 F3。
- §11.5：补充“agy 忽略进程 cwd、可见范围由 `--add-dir` 决定”这一历史结论（1.1.16 测量，`agy-cli.ts:419-424`），以及 1.2.16 新增的 `--project/--new-project`、`--sandbox`。M0 必须验证写入是否落在 canonical root（A04/A17），因为 `--project` 可能改变了工作区语义。
- §2.4 第 3 条：旧 Codex 插件实施路径除了 `--dangerously-skip-permissions`，还带 `--mode accept-edits`（`agy-cli.ts:455`）。
- §11.2：补充“Droid 默认只读”。

## 对 §17 九个问题的直接回答

1. **有没有偷偷退回只读或一次性**：有一处结构性风险，即 F1。粗粒度 provider 加上严格的 mismatch 规则，实际会让默认实施失败；Droid 漏设 autonomy 时会静默只读。其余部分（direct 默认、不自动 mirror、跨宿主需要显式 attach）符合 U05–U07。
2. **权限是否混淆**：§7.2 的三层区分是对的。缺少的是“宿主许可从哪里来”的具体机制。F2 建议复用宿主的工具审批，F1 建议用一次性的 provider 档位策略。
3. **owner 是否重复**：按文档原样同时用 broker 和 acpx，确实会重复。用 F4 的“每 session 一个 worker + 直接 SDK”可以消除。
4. **身份是否清晰**：四个身份的拆分足够。需要补充：原生 ID 预分配和回读核对（F3），禁止标题、latest 形式的续接。
5. **能力结论是否超出证据**：Dim 的“未找到”已经过时。Droid 少写了原生 stream-json 多轮路径和“默认只读”。agy 少写了 `accept-edits` / `--sandbox` / `--project`。最能改变架构的三个实验：Droid stream-json 与 ACP 的对比；agy 1.2.16 不跳过权限时的实施行为；宿主工具审批与 elicitation 的能力。
6. **未覆盖状态**：见 F5。
7. **迁移是否丢能力**：§2.3 的清单完整。旧插件的独立 job-worker 模式应作为 runtime 的起点直接沿用（F4），不必重写成 broker。
8. **是否过度设计**：broker、IPC 鉴权、六个包、八个工具都可以删减（F4、F7），不影响核心需求。
9. **能否更早交付切片**：可以，见 F6。

## 已核对事实（本次）

- 本机版本：Droid 0.233.0、OpenCode 1.18.34、Grok 1.0.46（2765805b9442）、agy 1.2.16、Dim（dimcode）0.5.16（app 内置路径）。`acpx` 不在 PATH 中。
- 各 CLI 的 help 内容如 F1、F3 所列。
- `agy-plugin-codex/.../agy-cli.ts:398-462` 的参数构造与注释。

## 仍属推测或未验证

- CC 和 Codex 能否按工具名分别设置 MCP 工具的放行或询问、是否支持 MCP elicitation、后台期间能否弹出。
- Droid stream-json 路径下 `--auto` 是否生效，ACP 下 autonomy 的 JSON-RPC 设置方法。
- agy 1.2.16 是否仍然“拒绝即终止”，`--project` 对工作区的影响。
- OpenCode `acp` 是否开启本地监听。
- `node:sqlite` 从哪个 Node 版本起无需 flag；官方 ACP TypeScript SDK 的准确包名。

## 需要用户决策的产品问题

1. **是否接受“比当前授权宽”的 provider 档位**（例如 Droid `auto-medium` 允许本地 git commit 和可信端点联网，agy 可能必须 skip-permissions），前提是每个项目、每个 provider 确认一次并在每次结果中如实回报？如果不接受，这些目标在首版就无法默认实施。
2. **首个纵向切片用 Droid 还是 Dim**（本评审建议 Droid）。
3. **只支持 L1 的会话，空闲进程是否允许一直保留到显式关闭**（占用资源，但不丢上下文）？还是允许超时释放、并明确提示上下文已丢失？

---

## 第二轮：Codex / Grok 交叉评审综合（2026-10-04）

评审对象为设计 0.2。两轮均为只读：没有改文件，也没有运行 Droid、Dim 等目标 Agent 的模型任务。Codex 0.160.0 和 Grok 1.0.46 各做两轮，第二轮互相回应对方要点。下文的“已核对”指至少一方给出 help 原文、源码位置或二进制字符串，并由 Claude 复核过关键项。

### 一、三方一致的修改

1. **§7.4 / §15 的残留冲突**：删除“全局放开就 mismatch”“M0 不能用 unsafe 绕开”的绝对表述，改为 U11 优先。没有确认记录时报 mismatch；已确认的具体档位允许使用，并且每次回报。
2. **每次 open / resume 都重新套用档位并读回**：续接是新进程，不继承上一进程的权限状态。旧 Grok 插件记录过 plan 会话被续接成可写（`grok-plugin-codex/.../tools.ts:649-651`）。
3. **U11 可信确认通道**：
   - 主路径：在前台 `delegate` 调用内、provider 启动**之前**同步发 MCP elicitation。内容由 Turnweft 生成，包括项目、provider、intent、档位和超出 grant 的部分，并绑定 request 与 nonce。只有匹配的协议回复才能写入 policy。拒绝、取消、超时或路由失败时都不启动 provider，也不在后台 worker 中补发 elicitation。
   - 退路：用户在外部终端运行 `turnweft policy grant`。它不是 MCP 工具，非 TTY 或带自动同意参数时直接失败。
   - 威胁模型写明：能防“模型通过工具参数自批”，不能防“模型拥有同用户任意 shell”。后者需要另加用户在场验证，不列入首版。
   - 工具放行、永不 allowlist 的专用工具，都**不能**当作 U11 凭据。Codex 有 per-tool `approval_mode`，也有 `approval policy is never` 的失败分支。
   - CC 和 Codex 是否能把 elicitation 呈现给人，两者都只有字符串证据，M0 必须实测。哪个宿主测不通，就只用 CLI grant。
4. **版本变化处理**：policy 记录完整 CLI 版本、adapter / transport 版本和档位能力摘要。任何变化都先重新验证；权限范围等价就复用原确认，范围扩大或无法证明等价时才重新确认（采纳 Codex 对 G2 的限定）。
5. **runtime**：不建中心 broker。worker 定义为“活跃 session 的执行者”，不是逻辑 session 的永久进程。由共享存储负责原子领取、session FIFO、项目写互斥和 generation，空闲时按 U13 释放。旧插件实际是“每 job 一个 worker + job 锁”（`job-store.ts:351-398, 723-762`），只能作为起点，不能当作已验证的方案。
6. **提交与超时**：`send` 在可靠落盘后立即返回。requestId 由调用方在提交前生成，响应丢失后用同一 ID 找回原 job。有界等待要短于宿主工具超时。MCP 请求取消与 `cancel(jobId)` 分开。
7. **身份竞态**：原生 ID 已出现但尚未落盘时崩溃，job 进入 `in_doubt` 并给出核对入口。只有帮助写明“用于新会话”的目标（Grok `-s`）才能预分配 ID；Droid `-s` 是续接已有会话。
8. **pending action 持久化**：绑定 session / job / request / grant revision。宿主不在时等待到 `permissionTimeout`，之后取消当前 turn 并保留 session。
9. **M0 / M1a 收缩**：M0 先在两个宿主上做不调用模型的 MCP 探针（审批、elicitation、超时、前端生命周期）。M1a 保持 Droid + Dim（U12），每个 provider 只选一条主路径。L2 不成立的 provider 按 U13 例外处理，不挡住 M1a。Codex 宿主的风险探测提前到 M0。
10. **Grok 共享 leader**：委派进程必须隔离 leader。ACP 路径用 `grok agent --no-leader stdio`（注意参数位置），或者使用独立的 `--leader-socket`。
11. **事实更正**：Droid 的“flags 不生效”只针对 Stream JSON-RPC 模式，不能推广到 ACP。OpenCode 的 `--mdns` 默认就是 false。

### 二、新发现（已核对）

- **Grok 1.0.46 的 `grok agent stdio` 是双向 ACP server**：只发 `initialize`、不发 prompt，返回 `protocolVersion:1`、`loadSession:true`、`sessionCapabilities{list,resume,close}`、`agentVersion:"1.0.46"`，以及 `modelState`。Claude 已用 node 复现。首轮“Grok 不是 ACP server”的说法应修正为：顶层 `streaming-json` 只是单轮输出；`agent stdio` 才是 ACP server。
- **Dim 0.5.16 两条路径的权限默认相反**：
  - ACP `newSession` 默认 `preset: "read-only"`。权限档位有 `read-only`、`workspace-write`（允许读写和 git，其他命令和联网需要询问）、`full-access`，可以通过 config option 设置并读回。
  - 原生 exec 默认 `full-access`，headless 模式下以 `"auto-approved in headless exec mode"` 自动批准；`exec resume` 不会重新设置权限。
- **Dim ACP 设置模型的副作用**：会经由 `switchProvider(..., {cwd})` 在事务中持久写入该 **workspace** 的 `providerSelections`，但不会改全局默认（只有不带 cwd 时才写全局）。目前没有找到“只改当前 session”的开关。
- **运行 `dim --version` 也会对 `~/.dimcode/v2/dimcode.sqlite` 执行 chmod**（Codex 在沙箱里被 EPERM 拒绝）。所以 doctor 调用 Dim CLI 不是纯只读操作。

### 三、主路径收敛

| provider | 首版主路径 | 依据 / 待验证 |
| --- | --- | --- |
| Dim | ACP（`dim acp`）；每次 new / load / resume 后设置 permission 并读回 | 优先 `workspace-write`，命令和联网的权限请求由 Turnweft 按 grant + U11 自动应答，不擅自上 `full-access`；exec 只作 L2 对照 |
| Droid | 原生 `--input-format stream-json` + `--auto` / `-m` / `-s` | Codex 选定，Grok 同意。待验证：stream-json 下能否读回 effective autonomy；读不回就改走 ACP，因为二进制中有 `session/set_mode` / `autonomyMode` |
| Grok | 候选改为 ACP（`agent --no-leader stdio`，用 loadSession / resume 续接）；原生每轮 `--resume <uuid>` 作退路 | Grok 主张，Claude 复核了握手。Codex 未见到握手证据，原先主张走原生路径。待验证：ACP 下权限模式如何设置，未知 ID 是否报错而不是新建 |
| agy、OpenCode | 各自已验证的原生路径 | M3 阶段处理 |

### 四、仍有分歧、需要用户决定

- **Dim 默认模型（U12）**：Codex 建议设置并如实回报“该项目的 Dim 默认模型会变”；Grok 建议在证明有 session-only 设置之前不设模型，沿用用户在 Dim 里的选择。Claude 倾向 Codex 的方案：影响只限该 workspace，且与用户想要的默认值一致；续接时读回，已匹配就不重复设置；不做“事后还原”。
