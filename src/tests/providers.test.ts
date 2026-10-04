// Executable discovery and provider environment: hosts started from the GUI may have a minimal PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const TW_HOME = mkdtempSync(join(tmpdir(), "tw-prov-"));
process.env.TURNWEFT_HOME = TW_HOME;
const { resolveExecutable, fallbackLocations } = await import("../adapters/providers.js");
const { providerEnv } = await import("../adapters/env.js");

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("a CLI outside a minimal GUI PATH is found in common install locations", () => {
  const home = mkdtempSync(join(tmpdir(), "tw-home-"));
  try {
    for (const [dir, name] of [[".local/bin", "droid"], [".opencode/bin", "opencode"]] as const) {
      mkdirSync(join(home, dir), { recursive: true });
      writeFileSync(join(home, dir, name), "#!/bin/sh\n"); chmodSync(join(home, dir, name), 0o755);
    }
    withEnv({ HOME: home, PATH: "/usr/bin:/bin" }, () => {
      // The real list, in order; candidates outside the temporary HOME are left out so the host's own installs do not matter.
      assert.deepEqual(fallbackLocations("opencode"), [join(home, ".local/bin/opencode"), "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode", join(home, ".opencode/bin/opencode")]);
      const own = (p: string) => fallbackLocations(p as "droid").filter((c) => c.startsWith(home));
      assert.equal(resolveExecutable("droid", own("droid")), join(home, ".local/bin/droid"));
      assert.equal(resolveExecutable("opencode", own("opencode")), join(home, ".opencode/bin/opencode"));
    });
    // PATH still wins over the fallback locations.
    const onPath = mkdtempSync(join(tmpdir(), "tw-path-"));
    writeFileSync(join(onPath, "droid"), "#!/bin/sh\n"); chmodSync(join(onPath, "droid"), 0o755);
    withEnv({ HOME: home, PATH: `${onPath}${delimiter}/usr/bin` }, () => assert.equal(resolveExecutable("droid", [join(home, ".local/bin/droid")]), join(onPath, "droid")));
    rmSync(onPath, { recursive: true, force: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the provider's own directory is put first on its PATH, and the running Node last if missing", () => {
  const n = "/n/bin";
  assert.equal(providerEnv("/x/bin/droid", { PATH: "/usr/bin" }, n).PATH, ["/x/bin", "/usr/bin", n].join(delimiter));
  assert.equal(providerEnv("/usr/bin/droid", { PATH: `/usr/bin${delimiter}${n}` }, n).PATH, `/usr/bin${delimiter}${n}`, "nothing added twice");
  assert.equal(providerEnv("/x/bin/droid", {}, n).PATH, `/x/bin${delimiter}${n}`);
  assert.equal(providerEnv("droid", { PATH: "/usr/bin" }, n).PATH, `/usr/bin${delimiter}${n}`);
  assert.equal(providerEnv("/p/bin/droid", { PATH: `/other/bin${delimiter}/p/bin${delimiter}${n}` }, n).PATH, ["/p/bin", "/other/bin", n].join(delimiter), "moved to the front");
});

test("a node-script CLI found outside PATH starts under a PATH without node (round 10)", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "tw-script-"));
  try {
    writeFileSync(join(dir, "opencode"), "#!/usr/bin/env node\nconsole.log('ok ' + process.version)\n"); chmodSync(join(dir, "opencode"), 0o755);
    const env = providerEnv(join(dir, "opencode"), { PATH: "/usr/bin:/bin" });
    assert.match(execFileSync(join(dir, "opencode"), { env, encoding: "utf8" }), /^ok v/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("discovery skips a same-named directory or non-executable file (round 10)", () => {
  const home = mkdtempSync(join(tmpdir(), "tw-home-"));
  const bad = mkdtempSync(join(tmpdir(), "tw-bad-"));
  try {
    mkdirSync(join(bad, "droid"));                                              // a directory on PATH
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/droid"), "not executable\n");          // mode 0644
    mkdirSync(join(home, ".opencode/bin"), { recursive: true });
    writeFileSync(join(home, ".opencode/bin/opencode"), "#!/bin/sh\n"); chmodSync(join(home, ".opencode/bin/opencode"), 0o755);
    withEnv({ HOME: home, PATH: `${bad}${delimiter}/usr/bin` }, () => {
      assert.equal(resolveExecutable("droid", [join(home, ".local/bin/droid")]), undefined);
      // A broken earlier candidate does not hide a working later one.
      assert.equal(resolveExecutable("opencode", [join(home, ".local/bin/droid"), join(home, ".opencode/bin/opencode")]), join(home, ".opencode/bin/opencode"));
    });
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(bad, { recursive: true, force: true }); rmSync(TW_HOME, { recursive: true, force: true }); }
});
