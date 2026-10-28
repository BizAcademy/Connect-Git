import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../../bizpanel/src/lib/sabito-widget.ts", import.meta.url))],
  bundle: true, write: false, format: "iife", globalName: "widget", platform: "browser",
  plugins: [{
    name: "mock-auth",
    setup(build) {
      build.onResolve({ filter: /^@\/lib\/authFetch$/ }, () => ({ path: "auth", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `export const AUTH_ENDING_EVENT="ending", AUTH_CHANGED_EVENT="changed";
          export async function authedFetch() { return new Response(null, {status:200}); }`,
      }));
    },
  }],
});

function fixture() {
  const scripts = [];
  const hosts = [];
  const calls = { logout: 0, login: 0, reload: 0 };
  const listeners = {};
  const window = {
    addEventListener(name, handler) { listeners[name] = handler; },
    location: { reload() { calls.reload++; } },
  };
  const document = {
    querySelectorAll() { return hosts.filter(host => !host.removed); },
    querySelector() { return null; },
    getElementById(id) { return scripts.find(script => script.id === id); },
    createElement() {
      return { dataset: {}, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } };
    },
    body: { appendChild(script) { scripts.push(script); } },
  };
  const context = vm.createContext({ window, document, console, Response });
  vm.runInContext(compiled.outputFiles[0].text, context);
  function load() {
    const style = new Map();
    const host = {
      hidden: false, removed: false,
      style: { setProperty: (key, value) => style.set(key, value), removeProperty: key => style.delete(key) },
      remove() { this.removed = true; },
      styleValues: style,
    };
    hosts.push(host);
    window.SabitoWidget = {
      logout() { calls.logout++; }, login() { calls.login++; },
    };
    scripts[0].listeners.load();
    return host;
  }
  return { api: context.widget, window, scripts, hosts, calls, load };
}

test("disabling hides the existing official host and reactivation reuses it without reloading forms", async () => {
  const f = fixture();
  f.api.syncSabitoWidget("member-A");
  assert.equal(f.scripts.length, 1);
  assert.equal(f.scripts[0].dataset.projectId, undefined);
  const host = f.load();
  f.api.disableSabitoWidget();
  assert.equal(host.hidden, true);
  assert.equal(host.styleValues.get("display"), "none");
  assert.equal(host.removed, false);
  assert.equal(f.calls.logout, 1);
  assert.equal((await f.window.SabitoWidgetSession({ signal: new AbortController().signal })).status, 503);
  f.api.disableSabitoWidget();
  assert.equal(f.calls.logout, 1, "Repeated polls must not repeatedly log out");
  f.api.syncSabitoWidget("member-A");
  assert.equal(host.hidden, false);
  assert.equal(host.styleValues.has("display"), false);
  assert.equal(f.calls.login, 1);
  assert.equal(f.scripts.length, 1);
  assert.equal(f.calls.reload, 0);
  assert.equal((await f.window.SabitoWidgetSession({ signal: new AbortController().signal })).status, 200);
  f.api.syncSabitoWidget("member-B");
  assert.equal(f.calls.reload, 1, "Account isolation still requires a fresh document");
  assert.equal(host.removed, true);
});

test("visitor disable during loader download hides the late host; reactivation restores visitor mode", () => {
  const f = fixture();
  f.api.disableSabitoWidget();
  assert.equal(f.scripts.length, 0, "Disabled startup must not load Sabito");
  f.api.syncSabitoWidget(null);
  assert.ok(f.scripts[0].dataset.projectId);
  f.api.disableSabitoWidget();
  const host = f.load();
  assert.equal(host.hidden, true);
  assert.equal(f.calls.logout, 1);
  f.api.syncSabitoWidget(null);
  assert.equal(host.hidden, false);
  assert.equal(f.calls.reload, 0);
  assert.equal(f.scripts.length, 1);
});
