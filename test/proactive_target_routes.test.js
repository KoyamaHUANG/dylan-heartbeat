const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRoutes, resolveProactiveTargets, selectProactiveTargets } = require("../proactive_target_routes");

const old = { assistant_id: "old-assistant", conversation_id: "old-conversation" };
const restored = { assistant_id: "restored-assistant", conversation_id: "restored-conversation" };
const unrelated = { assistant_id: "old-assistant", conversation_id: "other-conversation" };
const configuration = { version: 1, routes: [{ name: "primary", retired_bindings: [old], target: restored }] };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-target-routes-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "proactive_target_routes.json");
}

test("retire only exact old pair, preserve unrelated target and restored state reference", () => {
  const state = { ...restored, updated_at: "2026-10-05T10:17:30Z", latest_user_fingerprint: "existing" };
  const contexts = [old, unrelated, state];
  const before = JSON.stringify(contexts);
  const selected = selectProactiveTargets(contexts, configuration);
  assert.deepEqual(selected.targets, [unrelated, state]);
  assert.equal(selected.targets[1], state);
  assert.equal(JSON.stringify(contexts), before);
  assert.equal(selected.route_status[0].target_updated_at, state.updated_at);
});

test("missing restored binding suppresses retired pair without fallback or fabrication", () => {
  const selected = selectProactiveTargets([old, unrelated], configuration);
  assert.deepEqual(selected.targets, [unrelated]);
  assert.equal(selected.route_status[0].target_bound, false);
});

test("old chat registration cannot reenable retired target and restored target is deduped", () => {
  assert.deepEqual(selectProactiveTargets([{ ...old, updated_at: "newer" }, restored, { ...restored }], configuration).targets, [restored]);
});

test("reject overlapping routes, missing assistant identity and malformed configuration", () => {
  assert.throws(() => normalizeRoutes({ version: 1, routes: [...configuration.routes, { ...configuration.routes[0], name: "second" }] }));
  assert.throws(() => normalizeRoutes({ version: 1, routes: [{ ...configuration.routes[0], target: { conversation_id: "partial" } }] }));
  assert.throws(() => normalizeRoutes({ version: 2, routes: [] }));
});

test("no configuration preserves targets and writes no file", t => {
  const filePath = fixture(t);
  const selected = resolveProactiveTargets([old, restored], { filePath, env: {} });
  assert.deepEqual(selected.targets, [old, restored]);
  assert.equal(fs.existsSync(filePath), false);
});

test("bootstrap only when restored target is bound, persist route once and preserve registry", t => {
  const filePath = fixture(t);
  const registry = path.join(path.dirname(filePath), "kelivo_sync_context_v2.json");
  const bytes = JSON.stringify({ version: 2, contexts: [old, restored] });
  fs.writeFileSync(registry, bytes);
  const options = { filePath, env: { PROACTIVE_TARGET_ROUTES_JSON: JSON.stringify(configuration) } };
  assert.equal(resolveProactiveTargets([old], options).created, false);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(resolveProactiveTargets([old, restored], options).created, true);
  const before = fs.statSync(filePath).mtimeMs;
  assert.equal(resolveProactiveTargets([old, restored], options).created, false);
  assert.equal(fs.statSync(filePath).mtimeMs, before);
  assert.equal(fs.readFileSync(registry, "utf8"), bytes);
  assert.deepEqual(resolveProactiveTargets([old, restored], { filePath, env: {} }).targets, [restored]);
});

test("existing conflicting or corrupt route file is preserved and blocks wake selection", t => {
  const filePath = fixture(t);
  const existing = JSON.stringify({ version: 1, routes: [] });
  fs.writeFileSync(filePath, existing);
  const options = { filePath, env: { PROACTIVE_TARGET_ROUTES_JSON: JSON.stringify(configuration) } };
  assert.throws(() => resolveProactiveTargets([old, restored], options), { code: "PROACTIVE_TARGET_ROUTES_CONFLICT" });
  assert.equal(fs.readFileSync(filePath, "utf8"), existing);
  fs.writeFileSync(filePath, "{broken");
  assert.throws(() => resolveProactiveTargets([old, restored], { filePath, env: {} }), { code: "PROACTIVE_TARGET_ROUTES_INVALID" });
  assert.equal(fs.readFileSync(filePath, "utf8"), "{broken");
});
