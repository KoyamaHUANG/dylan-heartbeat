const fs = require("fs");
const path = require("path");
const { runtimeFile } = require("./runtime_paths");
const { validateKelivoSyncContext } = require("./kelivo_sync_context");

const DEFAULT_FILE_PATH = runtimeFile("proactive_target_routes.json");

function routeError(code) {
  return Object.assign(new Error(code), { code });
}

function bindingKey(binding) {
  return JSON.stringify([binding.assistant_id, binding.conversation_id]);
}

function normalizeBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError("PROACTIVE_TARGET_ROUTES_INVALID");
  }
  const normalized = validateKelivoSyncContext({ ...value, latest_user_fingerprint: "route-validation" });
  return { assistant_id: normalized.assistant_id, conversation_id: normalized.conversation_id };
}

function normalizeRoutes(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.routes)) {
    throw routeError("PROACTIVE_TARGET_ROUTES_INVALID");
  }
  const names = new Set();
  const managed = new Set();
  const routes = value.routes.map(route => {
    if (!route || typeof route.name !== "string" || !route.name.trim() ||
        names.has(route.name.trim()) || !Array.isArray(route.retired_bindings) ||
        route.retired_bindings.length === 0) throw routeError("PROACTIVE_TARGET_ROUTES_INVALID");
    names.add(route.name.trim());
    const target = normalizeBinding(route.target);
    const retired_bindings = route.retired_bindings.map(normalizeBinding);
    for (const binding of [target, ...retired_bindings]) {
      const key = bindingKey(binding);
      if (managed.has(key)) throw routeError("PROACTIVE_TARGET_ROUTES_OVERLAP");
      managed.add(key);
    }
    return { name: route.name.trim(), retired_bindings, target };
  });
  return { version: 1, routes };
}

function parseRoutes(raw) {
  try { return normalizeRoutes(JSON.parse(raw)); }
  catch (error) {
    if (error.code === "PROACTIVE_TARGET_ROUTES_OVERLAP") throw error;
    throw routeError("PROACTIVE_TARGET_ROUTES_INVALID");
  }
}

function selectProactiveTargets(contexts, configuration) {
  const routes = normalizeRoutes(configuration).routes;
  const managed = new Set(routes.flatMap(route => [route.target, ...route.retired_bindings]).map(bindingKey));
  const targets = contexts.filter(context => !managed.has(bindingKey(context)));
  const route_status = routes.map(route => {
    const target = contexts.find(context => bindingKey(context) === bindingKey(route.target));
    if (target) targets.push(target);
    return {
      name: route.name,
      target_bound: Boolean(target),
      target: route.target,
      target_updated_at: target?.updated_at || null,
      retired: route.retired_bindings.map(binding => ({
        ...binding,
        bound: contexts.some(context => bindingKey(context) === bindingKey(binding))
      }))
    };
  });
  return { targets, route_status };
}

// The environment value bootstraps the volume file once. Existing different
// configuration is never replaced. No conversation registry/state is written.
function resolveProactiveTargets(contexts, { filePath = DEFAULT_FILE_PATH, env = process.env } = {}) {
  const raw = String(env.PROACTIVE_TARGET_ROUTES_JSON || "").trim();
  const configured = raw ? parseRoutes(raw) : null;
  let stored = null;
  try { stored = parseRoutes(fs.readFileSync(filePath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stored && configured && JSON.stringify(stored) !== JSON.stringify(configured)) {
    throw routeError("PROACTIVE_TARGET_ROUTES_CONFLICT");
  }
  const configuration = stored || configured || { version: 1, routes: [] };
  const selection = selectProactiveTargets(contexts, configuration);
  let created = false;
  if (!stored && configured && selection.route_status.every(route => route.target_bound)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(configured, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      // link is atomic and fails if another writer has created the destination.
      fs.linkSync(temporary, filePath);
      created = true;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return { ...selection, configured: Boolean(stored || configured), created };
}

module.exports = { DEFAULT_FILE_PATH, normalizeRoutes, resolveProactiveTargets, selectProactiveTargets };
