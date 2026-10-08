import test, { mock } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createLanguageResolver, renderMessage, text } from "../core/i18n.js";
import { dialogAccepted, macosConfirm } from "../mcp/native-dialog.js";
import baseline from "./i18n-baseline.json" with { type: "json" };

test("language precedence, defaults and cached macOS primary language", () => {
  let reads = 0;
  const noConfig = () => undefined; // never read the real ~/.turnweft/config.json
  const resolve = createLanguageResolver(() => { reads++; return '(\n "zh-Hans-CN",\n "en-US"\n)'; }, noConfig);
  assert.equal(resolve({ TURNWEFT_LANG: "en", LC_ALL: "zh_CN" }, "darwin"), "en");
  assert.equal(resolve({ TURNWEFT_LANG: "zh", LANG: "en_US" }, "linux"), "zh");
  assert.equal(resolve({ TURNWEFT_LANG: "invalid", LC_ALL: "en_US", LC_MESSAGES: "zh_CN" }, "darwin"), "en");
  assert.equal(resolve({ LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US" }, "linux"), "zh");
  assert.equal(resolve({ LC_ALL: "", LANG: "zh_CN.UTF-8" }, "linux"), "zh");
  assert.equal(resolve({}, "linux"), "en");
  assert.equal(reads, 0);
  assert.equal(resolve({}, "darwin"), "zh");
  assert.equal(resolve({}, "darwin"), "zh");
  assert.equal(reads, 1);
  assert.equal(createLanguageResolver(() => '("en-US", "zh-Hans")', noConfig)({}, "darwin"), "en");
  assert.equal(createLanguageResolver(() => { throw new Error("defaults unavailable"); }, noConfig)({}, "darwin"), "en");
});

test("config.json language wins over the locale and the macOS language, but not over TURNWEFT_LANG", () => {
  const home = mkdtempSync(join(tmpdir(), "tw-lang-"));
  try {
    const resolve = createLanguageResolver(() => '("en-US", "zh-Hans")');
    writeFileSync(join(home, "config.json"), JSON.stringify({ language: "zh" }));
    assert.equal(resolve({ TURNWEFT_HOME: home, LANG: "en_US.UTF-8" }, "darwin"), "zh");
    assert.equal(resolve({ TURNWEFT_HOME: home, TURNWEFT_LANG: "en" }, "darwin"), "en");
    writeFileSync(join(home, "config.json"), JSON.stringify({ language: "fr" }));
    assert.equal(resolve({ TURNWEFT_HOME: home }, "darwin"), "en", "an unknown value falls through");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("messages render in both languages, including nested config summaries", () => {
  assert.equal(text("allow", undefined, "en"), "Allow");
  assert.equal(text("allow", undefined, "zh"), "允许");
  const message = { key: "openPolicy", params: { summary: { key: "openConfig", params: { config: '{"edit":"ask"}' } } } } as const;
  assert.equal(renderMessage(message, "zh"), 'OpenCode 按其自身权限配置运行：你的配置 permission={"edit":"ask"}');
  assert.equal(renderMessage(message, "en"), 'OpenCode runs under its own permission config: Your config has permission={"edit":"ask"}');
});

test("only the current language's Allow button with no timeout grants permission", () => {
  for (const language of ["en", "zh"] as const) {
    const allow = text("allow", undefined, language);
    const deny = text("deny", undefined, language);
    assert.equal(dialogAccepted(`${allow}|false\n`, language), true);
    for (const response of [`${allow}|true`, `${deny}|false`, `${allow}|`, ""]) {
      assert.equal(dialogAccepted(response, language), false);
    }
    assert.equal(dialogAccepted(`${text("allow", undefined, language === "zh" ? "en" : "zh")}|false`, language), false);
  }
});

// Captured from b7c3af5 before implementation, with CLI 1.2.3 / adapter 0.1.0.
// Each config-dependent branch carries its original Chinese bytes and digest.
test("every provider tier preserves legacy Chinese bytes and digest under both languages", () => {
  const home = mkdtempSync(join(tmpdir(), "tw-i18n-home-"));
  const built = new URL("../", import.meta.url).href; // dist/ or dist-test/, whichever this test was built into
  try {
    mkdirSync(join(home, ".grok"), { recursive: true });
    mkdirSync(join(home, ".config/opencode"), { recursive: true });
    const script = `
      import { ADAPTERS } from '${built}adapters/providers.js';
      import { capabilityDigest, buildProposal } from '${built}runtime/policy.js';
      import { renderMessage } from '${built}core/i18n.js';
      const row = JSON.parse(process.argv[1]);
      const probe = { provider: row.provider, available: true, cliVersion: '1.2.3', adapterVersion: '0.1.0', probedAt: '' };
      const tier = ADAPTERS[row.provider].tierFor(row.intent, probe);
      const proposal = buildProposal({ provider: row.provider, canonicalRoot: '/project', intent: row.intent, probe, tier });
      console.log(JSON.stringify({ tier: tier.tier, excess: tier.excess.map(m => renderMessage(m, 'zh')), digest: capabilityDigest(row.provider, probe, tier), proposal }));
    `;
    for (const row of baseline) {
      writeFileSync(join(home, ".grok/config.toml"), `permission_mode="${row.mode}"`);
      const config = join(home, ".config/opencode/opencode.json");
      if (row.config === "missing") rmSync(config, { force: true });
      else writeFileSync(config, JSON.stringify(row.config === "empty" ? {} : { permission: { edit: "ask", bash: "deny" } }));
      for (const language of ["en", "zh"]) {
        const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(row)], {
          cwd: process.cwd(), env: { ...process.env, HOME: home, TURNWEFT_HOME: join(home, ".turnweft"), TURNWEFT_LANG: language }, encoding: "utf8",
        }));
        assert.equal(result.tier, row.tier);
        assert.deepEqual(result.excess, row.excess);
        assert.equal(result.digest, row.digest, `${row.provider}/${row.tier}/${language}`);
        assert.equal(result.proposal.capabilityDigest, row.digest);
        if (language === "zh") assert.deepEqual(result.proposal.excessOverGrant, row.excess);
        else assert.ok(!/[\p{Script=Han}]/u.test(result.proposal.message));
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("standalone launcher setup text follows language and copies stay identical", () => {
  for (const language of ["en", "zh"]) {
    const outputs = ["shared", "claude-code", "codex"].map(plugin => execFileSync(process.execPath, [`plugins/${plugin}/launcher.mjs`], {
      env: { ...process.env, TURNWEFT_BIN: join(process.cwd(), ".missing-turnweft"), TURNWEFT_LANG: language },
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "turnweft_setup" } }) + "\n",
      encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }));
    assert.equal(outputs[0], outputs[1]);
    assert.equal(outputs[0], outputs[2]);
    const message = JSON.parse(outputs[0]!).result.content[0].text;
    assert.ok(message.includes("npm install -g turnweft"));
    assert.equal(/[\p{Script=Han}]/u.test(message), language === "zh");
  }
});

test("native dialog passes localized buttons and expiry to osascript", { skip: process.platform !== "darwin" }, async () => {
  const oldLanguage = process.env.TURNWEFT_LANG;
  const oldDisabled = process.env.TURNWEFT_NO_NATIVE_DIALOG;
  delete process.env.TURNWEFT_NO_NATIVE_DIALOG;
  let args: string[] = [];
  let response = "";
  const exec = mock.method(childProcess, "execFile", ((_file: string, argv: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
    args = argv;
    callback(null, response, "");
    return { pid: 123 };
  }) as unknown as typeof childProcess.execFile);
  syncBuiltinESMExports();
  const proposal = { proposalId: "twq_test", message: "Stored proposal", expiresAt: "2026-10-05T13:00:00Z" } as import("../core/types.js").PolicyProposal;
  try {
    for (const language of ["en", "zh"] as const) {
      process.env.TURNWEFT_LANG = language;
      response = `${text("allow", undefined, language)}|false`;
      assert.equal((await macosConfirm(proposal, 10000)).accepted, true);
      assert.deepEqual(args.slice(-2), [text("deny", undefined, language), text("allow", undefined, language)]);
      const expires = new Date(proposal.expiresAt).toLocaleString(language === "en" ? "en-US" : "zh-CN", { hour12: false });
      assert.equal(args.at(-4), `${proposal.message}\n\n${text("dialog", { id: proposal.proposalId, expires }, language)}`);
      assert.ok(args.includes('display dialog msg with title "Turnweft" buttons {denyLabel, allowLabel} default button denyLabel cancel button denyLabel with icon caution giving up after secs'));
      response = `${text("deny", undefined, language)}|false`;
      assert.equal((await macosConfirm(proposal, 10000)).accepted, false);
      response = `${text("allow", undefined, language)}|true`;
      assert.equal((await macosConfirm(proposal, 10000)).accepted, false);
    }
  } finally {
    exec.mock.restore(); syncBuiltinESMExports();
    if (oldLanguage === undefined) delete process.env.TURNWEFT_LANG; else process.env.TURNWEFT_LANG = oldLanguage;
    if (oldDisabled === undefined) delete process.env.TURNWEFT_NO_NATIVE_DIALOG; else process.env.TURNWEFT_NO_NATIVE_DIALOG = oldDisabled;
  }
});

test("U24: concurrent write warning is localized with peer IDs", () => {
  assert.equal(text("concurrentWrites", { jobs: "twj_a, twj_b" }, "zh"), "同一目录有其他写任务同时运行：twj_a, twj_b；改动可能互相覆盖，git 提交可能包含其他 Agent 的改动");
  assert.equal(text("concurrentWrites", { jobs: "twj_a, twj_b" }, "en"), "Other write jobs ran concurrently in the same directory: twj_a, twj_b; changes may overwrite each other, and git commits may include another agent's changes.");
});
