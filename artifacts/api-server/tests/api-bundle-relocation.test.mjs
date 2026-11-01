import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, cp, rm, mkdir, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildAll } from "../build.mjs";

// Deliberately use NO inherited credentials, no live API and no member data.
const dir = await mkdtemp(path.join(tmpdir(), "buzzbooster-relocation-"));
after(() => rm(dir, { recursive: true, force: true }));
const original = path.join(dir, "temporary-build");
const deployed = path.join(dir, "deployed app with spaces", "api-server");
await buildAll({ distDir: original });
await mkdir(path.dirname(deployed), { recursive: true });
await cp(original, deployed, { recursive: true, filter: file => !file.endsWith(".map") });
// The old build location must disappear, exactly as after a GitHub export.
await rm(original, { recursive: true, force: true });
await cp(path.join(deployed, "scripts/check-sabito-connection.mjs"), path.join(deployed, "diagnostic-root.mjs"));

for (const mode of [undefined, "production"]) {
  for (const script of ["diagnostic-root.mjs", "scripts/check-sabito-connection.mjs"]) {
    test(`relocated ${script} logs correctly with NODE_ENV=${mode ?? "unset"}`, () => {
      const result = spawnSync(process.execPath, [path.join(deployed, script)], {
        cwd: tmpdir(), env: mode ? { NODE_ENV: mode } : {}, encoding: "utf8", timeout: 15_000,
      });
      assert.ifError(result.error);
      // Missing configuration is expected; a logging/module crash is not.
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /SABITO_URL_INVALID/);
      assert.match(result.stdout, /DATABASE_UNAVAILABLE/);
      assert.match(result.stdout, /CHECKS_BLOCKED/);
      assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module|uncaught/i);
      assert.equal(result.stdout.includes(original), false);
      assert.equal(result.stderr.includes(original), false);
    });
  }
}

test("relocated supervisor starts its child and reports config errors without logger crashes", async () => {
  const child = spawn(process.execPath, [path.join(deployed, "scripts/sabito-supervisor.mjs")], {
    cwd: tmpdir(), env: {}, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  let observed = false;
  const exited = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Relocated supervisor did not produce its expected safe diagnostics"));
    }, 12_000);
    child.on("error", error => { clearTimeout(deadline); reject(error); });
    child.stdout.on("data", data => {
      stdout += data;
      if (!observed && stdout.includes("CONFIGURATION_INVALID") && stdout.includes("CHILD_RESTART")) {
        observed = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", data => { stderr += data; });
    child.on("exit", () => { clearTimeout(deadline); resolve(); });
  });
  await exited;
  assert.equal(observed, true, `${stdout}\n${stderr}`);
  assert.doesNotMatch(stderr, /MODULE_NOT_FOUND|Cannot find module|uncaught/i);
  assert.equal(stderr.includes(original), false);
});

test("compiled Pino paths contain no obsolete build-directory override", async () => {
  for (const script of ["index.mjs", "scripts/sabito-supervisor.mjs", "scripts/check-sabito-connection.mjs"]) {
    const contents = await readFile(path.join(deployed, script), "utf8");
    assert.ok(!contents.includes("function pinoBundlerAbsolutePath"));
    assert.ok(contents.includes("globalThis.__bundlerPathsOverrides"));
    assert.ok(contents.includes("import.meta.url"));
  }
});
