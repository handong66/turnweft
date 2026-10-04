import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Language = "en" | "zh";

/** `language` in ~/.turnweft/config.json: hosts started from the Dock see neither shell variables nor LANG. */
function configLanguage(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const file = join(env.TURNWEFT_HOME ?? join(homedir(), ".turnweft"), "config.json");
    return JSON.parse(readFileSync(file, "utf8")).language;
  } catch { return undefined; }
}

/**
 * Order: TURNWEFT_LANG, config.json `language`, LC_ALL / LC_MESSAGES / LANG, the macOS primary language
 * (cached, including failures), else English.
 */
export function createLanguageResolver(
  readAppleLanguages = () => execFileSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 5000 }),
  readConfigLanguage: (env: NodeJS.ProcessEnv) => string | undefined = configLanguage,
) {
  let appleLanguage: Language | undefined;
  return (env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Language => {
    if (env.TURNWEFT_LANG === "zh" || env.TURNWEFT_LANG === "en") return env.TURNWEFT_LANG;
    const configured = readConfigLanguage(env);
    if (configured === "zh" || configured === "en") return configured;
    for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
      const locale = env[key]?.trim();
      if (locale) return /^zh/i.test(locale) ? "zh" : "en";
    }
    if (platform !== "darwin") return "en";
    if (appleLanguage === undefined) {
      try {
        const first = readAppleLanguages().match(/\(\s*"?([^",\s)]+)/)?.[1];
        appleLanguage = first && /^zh/i.test(first) ? "zh" : "en";
      } catch { appleLanguage = "en"; }
    }
    return appleLanguage;
  };
}

export const currentLanguage = createLanguageResolver();

const messages = {
  zh: {
    usage: "Turnweft\n  mcp                         启动 stdio MCP 服务\n  doctor | agents list        探测目标，不提交模型任务\n  session create --agent ID --cwd PATH [--name LABEL] [--model MODEL]\n  session list [--cwd PATH] [--agent ID] [--include-closed]\n  session get|attach ID\n  session close ID [--policy reject_if_busy|cancel_running]\n  send --session ID [--intent analyze|implement] [--prompt-file FILE] [--request-id ID]\n                              未提供文件时从标准输入读取；默认意图为 analyze\n  job status|wait|result ID [--wait-ms MS] [--after-seq N] [--include-result]\n                           [--result-offset N] [--result-limit N]\n                              最多等待 25000 ms；其他查询立即返回\n  cancel ID\n  policy list [--cwd PATH] [--agent ID]\n  policy revoke ID\n  policy grant PROPOSAL_ID     需要标准输入、输出为终端，并手动输入 yes\n  所有命令接受 --json；mcp 标准输出始终为 MCP 协议流。\n",
    cancelled: "输入已关闭或确认已取消；未授予权限",
    declined: "未授予权限；任务继续等待",
    denied: "已拒绝；等待这次确认的任务已取消",
    waitingJob: "任务 {id} 正在等待确认。请运行：turnweft policy grant {proposal}（确认后自动开始）。",
    jobSummary: "{id}: {state}；下一步：{next}",
    needsConfirmation: "需要用户确认权限；任务尚未开始。",
    noEntries: "没有记录。",
    none: "  （无）",
    grantDetails: "提供方: {provider}\n项目： {root}\n意图： {intent}\n档位： {tier}\n超出授权的权限：\n{excess}\n过期时间： {expires}\n提案 ID： {id}\nCLI 版本： {version}\n适配器版本： {adapter}\n权限指纹： {digest}\n",
    fakeExcess: "fake: commands approved without network filtering",
    autoApprove: "Turnweft 会自动批准 {name} 的编辑和命令请求，不区分命令是否联网",
    dimGit: "Dim workspace-write：git 操作不经逐次确认",
    openDefault: "你的配置未设置 permission，编辑和命令默认不经询问（含联网）",
    openConfig: "你的配置 permission={config}",
    openMissing: "未找到 OpenCode 配置，按默认规则：编辑和命令不经询问（含联网）",
    grokUnverified: "Turnweft 无法读回 Grok 的实际权限模式；按 ~/.grok/config.toml 判断为 {mode}",
    grokUngated: "你的 Grok 配置 permission_mode={mode}：所有工具调用（含命令和联网）不经确认",
    grokReadonly: "无法限制为只读：Grok 可能修改文件",
    openPolicy: "OpenCode 按其自身权限配置运行：{summary}",
    openUnverified: "Turnweft 只应答 OpenCode 主动发来的权限请求，无法读回它实际生效的权限规则",
    agyUngated: "agy 跳过权限检查：所有工具调用（含命令和联网）不经确认",
    implement: "修改代码（implement）",
    analyze: "只读分析（analyze）",
    unknownVersion: "版本未知",
    proposal: "Turnweft 需要你确认一次：允许 {provider}（{version}）在项目 {root} 中以「{tier}」档位{intent}。\n这个档位比当前授权多出：\n- {excess}\n确认后任务会自动开始；同一项目、同一 Agent、同一意图不再询问；Agent 版本或档位语义变化时会重新确认。",
    deny: "拒绝",
    allow: "允许",
    dialog: "提案 {id}。这个对话框会一直等你选择（提案 {expires} 过期）；也可以在终端运行 turnweft policy grant {id}。",
    confirmTitle: "允许（选“否”并提交表示拒绝；关闭不算拒绝）",
    confirmed: "已确认：{provider} / {intent} / {tier}，项目 {root}；同一项目、同一 Agent、同一意图不再询问。撤销：turnweft policy revoke {id}",
    grantPrompt: "输入 yes 授予此项权限，或 no 拒绝："
  },
  en: {
    usage: "Turnweft\n  mcp                         Start the stdio MCP server\n  doctor | agents list        Probe targets without submitting a model task\n  session create --agent ID --cwd PATH [--name LABEL] [--model MODEL]\n  session list [--cwd PATH] [--agent ID] [--include-closed]\n  session get|attach ID\n  session close ID [--policy reject_if_busy|cancel_running]\n  send --session ID [--intent analyze|implement] [--prompt-file FILE] [--request-id ID]\n                              Otherwise read the prompt from stdin; intent defaults to analyze\n  job status|wait|result ID [--wait-ms MS] [--after-seq N] [--include-result]\n                           [--result-offset N] [--result-limit N]\n                              Waits are capped at 25000 ms; other queries return immediately\n  cancel ID\n  policy list [--cwd PATH] [--agent ID]\n  policy revoke ID\n  policy grant PROPOSAL_ID     Requires stdin and stdout TTY and manual yes\n  All commands accept --json; mcp stdout remains the MCP protocol stream.\n",
    cancelled: "Input closed or confirmation was cancelled; policy was not granted",
    declined: "Policy was not granted; jobs keep waiting",
    denied: "Denied; jobs waiting for this confirmation were cancelled",
    waitingJob: "Job {id} is waiting for confirmation. Run: turnweft policy grant {proposal} (it starts by itself once confirmed).",
    jobSummary: "{id}: {state}; next: {next}",
    needsConfirmation: "Needs user policy confirmation; no task started.",
    noEntries: "No entries.",
    none: "  (none)",
    grantDetails: "Provider: {provider}\nProject: {root}\nIntent: {intent}\nTier: {tier}\nExcess over grant:\n{excess}\nExpires at: {expires}\nProposal ID: {id}\nCLI version: {version}\nAdapter version: {adapter}\nCapability digest: {digest}\n",
    fakeExcess: "fake: commands approved without network filtering",
    autoApprove: "Turnweft automatically approves {name} edit and command requests, including commands that access the network",
    dimGit: "Dim workspace-write: git operations do not require individual confirmation",
    openDefault: "Your config does not set permission; edits and commands run without asking by default (including network access)",
    openConfig: "Your config has permission={config}",
    openMissing: "No OpenCode config found; defaults allow edits and commands without asking (including network access)",
    grokUnverified: "Turnweft cannot read back Grok's effective permission mode; ~/.grok/config.toml indicates {mode}",
    grokUngated: "Your Grok config has permission_mode={mode}: all tool calls (including commands and network access) run without confirmation",
    grokReadonly: "Cannot enforce read-only access: Grok may modify files",
    openPolicy: "OpenCode runs under its own permission config: {summary}",
    openUnverified: "Turnweft only answers permission requests sent by OpenCode and cannot read back its effective permission rules",
    agyUngated: "agy skips permission checks: all tool calls (including commands and network access) run without confirmation",
    implement: "modify code (implement)",
    analyze: "perform read-only analysis (analyze)",
    unknownVersion: "unknown version",
    proposal: "Turnweft needs your one-time confirmation: allow {provider} ({version}) to {intent} in project {root} using tier \"{tier}\".\nThis tier exceeds the current grant by:\n- {excess}\nThe task starts automatically after confirmation. You will not be asked again for the same project, agent and intent; changes to the agent version or tier semantics require confirmation again.",
    deny: "Deny",
    allow: "Allow",
    dialog: "Proposal {id}. This dialog waits for your choice (the proposal expires at {expires}); you can also run turnweft policy grant {id} in a terminal.",
    confirmTitle: "Allow (submit No to deny; closing is not a denial)",
    confirmed: "Confirmed: {provider} / {intent} / {tier}, project {root}; you will not be asked again for the same project, agent and intent. Revoke: turnweft policy revoke {id}",
    grantPrompt: "Type yes to grant this exact policy, or no to deny it: "
  }
} as const;

export type MessageKey = keyof typeof messages.en;
export interface Message { key: MessageKey; params?: Record<string, string | Message> }

export function renderMessage(message: Message, language: Language = currentLanguage()): string {
  return messages[language][message.key].replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = message.params?.[key];
    return typeof value === "object" ? renderMessage(value, language) : value ?? `{${key}}`;
  });
}

export function text(key: MessageKey, params?: Message["params"], language: Language = currentLanguage()): string {
  return renderMessage({ key, params }, language);
}
