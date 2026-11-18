// U27: with magpie installed, agy starts as `magpie agy run <args>`. Uses a scripted magpie and agy, never the real ones.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TierSpec } from "../adapters/types.js";

const home = mkdtempSync(join(tmpdir(), "tw-magpie-"));
process.env.TURNWEFT_HOME = home;
const { resolveLaunch, magpieLocations, ADAPTERS } = await import("../adapters/providers.js");
const { AgyConnection } = await import("../adapters/agy.js");
after(() => rmSync(home, { recursive: true, force: true }));

const nativeDir = join(home, "native"), magpieDir = join(home, "magpie-bin");
mkdirSync(nativeDir); mkdirSync(magpieDir);
const agy = join(nativeDir, "agy"), magpie = join(magpieDir, "magpie");
writeFileSync(agy, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("./fake-agy.js", import.meta.url))}" "$@"\n`);
// Like magpie: finds agy on PATH, adds its routed model unless one is given, and execs agy.
writeFileSync(magpie, `#!/bin/sh
[ "$1" = agy ] && [ "$2" = run ] || exit 2
shift 2
command -v agy >/dev/null 2>&1 || { echo "magpie: agy isn't installed, or isn't on your PATH" >&2; exit 1; }
case " $* " in *" --model "*|*" --version "*) exec agy "$@";; *) exec agy --model magpie/routed "$@";; esac
`);
chmodSync(agy, 0o755); chmodSync(magpie, 0o755);
const config = (value: object) => writeFileSync(join(home, "config.json"), JSON.stringify(value));
const tier: TierSpec = { tier: "request-review", excess: [], decide: () => "deny", satisfiedBy: () => true };

function withPath<T>(path: string, fn: () => T): T {
  const saved = process.env.PATH; process.env.PATH = path;
  try { return fn(); } finally { process.env.PATH = saved; }
}

test("U27: agy resolves to magpie when present; executables.agy, agyViaMagpie:false and other providers stay native", () => withPath("/usr/bin:/bin", () => {
  config({});
  assert.deepEqual(resolveLaunch("agy", [agy], [magpie]), { exe: agy, launcher: [magpie, "agy", "run"] });
  assert.deepEqual(resolveLaunch("agy", [agy], [join(home, "missing")]), { exe: agy, launcher: [] }, "no magpie: native");
  assert.equal(resolveLaunch("agy", [join(home, "none")], [magpie]), undefined, "magpie alone is not agy");
  config({ agyViaMagpie: false });
  assert.deepEqual(resolveLaunch("agy", [agy], [magpie]), { exe: agy, launcher: [] });
  config({ executables: { agy } });
  assert.deepEqual(resolveLaunch("agy", [], [magpie]), { exe: agy, launcher: [] }, "a configured path runs exactly that");
  config({ executables: { droid: agy } });
  assert.deepEqual(resolveLaunch("droid", [], [magpie]), { exe: agy, launcher: [] });
  process.env.PATH = `${magpieDir}${delimiter}/usr/bin`;
  assert.equal(magpieLocations()[0], magpie, "PATH is checked first");
  config({});
}));

test("U27: a session through magpie finds native agy under a minimal PATH and reports magpie's model", async () => {
  config({});
  const launch = withPath("/usr/bin:/bin", () => resolveLaunch("agy", [agy], [magpie]))!;
  const saved = process.env.PATH; process.env.PATH = "/usr/bin:/bin"; // a GUI host's PATH without agy
  try {
    for (const [model, expected] of [[undefined, "magpie/routed"], ["chosen-model", "chosen-model"]] as const) {
      const c = new AgyConnection(launch.exe, tmpdir(), {}, launch.launcher);
      try {
        const r = await c.open({ cwd: tmpdir(), tier, model });
        assert.deepEqual(r.model, { requested: model, effective: expected });
        assert.equal(r.effective.permission_mode, "request-review");
        let text = "";
        await c.prompt("hello", (e) => { if (e.type === "text") text += e.text; });
        assert.equal(text, "effort=default");
      } finally { await c.close(); }
    }
  } finally { process.env.PATH = saved; }
});

test("U27: the probe reads the version through magpie and shows the launcher", async () => {
  config({});
  const saved = process.env.PATH; process.env.PATH = [magpieDir, nativeDir, "/usr/bin", "/bin"].join(delimiter);
  try {
    const probe = await ADAPTERS.agy.probe();
    assert.equal(probe.available, true);
    assert.equal(probe.executable, agy);
    assert.deepEqual(probe.launcher, [magpie, "agy", "run"]);
    assert.equal(probe.cliVersion, "1.5.11-fake");
    config({ agyViaMagpie: false });
    assert.equal((await ADAPTERS.agy.probe()).launcher, undefined);
  } finally { process.env.PATH = saved; config({}); }
});
