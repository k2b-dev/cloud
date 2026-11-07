/** The generated module has no package, network, database, credential or environment imports. */
export const CODE_SDK_RUNTIME = String.raw`
const handles = new WeakMap();
let bridge;
const schedules = [];
const routes = [];
const routeResponses = new WeakMap();
const diagnostics = [];
const node = () => Object.create(null);
function setPath(root, path, value) {
  for (const key of path.slice(0, -1)) {
    let child = Object.hasOwn(root, key) ? root[key] : undefined;
    if (!child || (typeof child !== "object" && typeof child !== "function")) {
      child = node();
      Object.defineProperty(root, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    root = child;
  }
  const key = path[path.length - 1];
  const previous = root[key];
  if (previous && (typeof previous === "object" || typeof previous === "function")) Object.defineProperties(value, Object.getOwnPropertyDescriptors(previous));
  Object.defineProperty(root, key, { value, enumerable: true, writable: true, configurable: true });
}
function coordinate(handle, type) {
  const ref = handles.get(handle);
  if (!ref || ref.type !== type) throw new Error("code_sdk_invalid_handle");
  return { type: ref.type, id: ref.id };
}
function handle(appId, type, id) {
  if (typeof id !== "string" || id.length === 0 || id.length > RESOURCE_ID_MAX) throw new Error("code_sdk_invalid_id");
  const result = node();
  const ref = Object.freeze({ type: type ?? "cloud.app", id });
  handles.set(result, ref);
  Object.defineProperties(result, { type: { value: ref.type, enumerable: true }, id: { value: ref.id, enumerable: true } });
  for (const op of manifest.operations.filter(op => op.appId === appId && op.target === type)) {
    setPath(result, op.methodPath, async (args) => {
      if (!bridge) throw new Error("code_sdk_bridge_unbound");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("code_sdk_invalid_input");
      const input = { ...args };
      const refs = {};
      for (const [field, refType] of Object.entries(op.refs)) {
        refs[field] = coordinate(input[field], refType);
        delete input[field];
      }
      const metadata = {};
      if (op.kind === "action") {
        const key = input.idempotencyKey;
        if (op.idempotency === "required" && (typeof key !== "string" || key.trim().length === 0)) throw new Error("code_sdk_idempotency_required");
        if (op.idempotency === "none" && key !== undefined) throw new Error("code_sdk_idempotency_not_allowed");
        if (key !== undefined && (typeof key !== "string" || key.trim().length > 200 || !/^[\x21-\x7e]+$/.test(key.trim()))) throw new Error("code_sdk_invalid_idempotency_key");
        if (key !== undefined) metadata.idempotencyKey = key.trim();
        delete input.idempotencyKey;
      }
      const call = { capability: op.capability, target: type === null ? null : coordinate(result, type), refs, input };
      return bridge.call(op.capability, { call, metadata });
    });
  }
  return Object.freeze(result);
}
const namespaces = node();
for (const app of manifest.apps) namespaces[app.exportName] = node();
for (const spec of manifest.handles) {
  // The app-wide factory and a resource Type named "app" share one overloaded callable.
  const peers = manifest.handles.filter(value => value.appId === spec.appId && JSON.stringify(value.factoryPath) === JSON.stringify(spec.factoryPath));
  setPath(namespaces[spec.exportName], spec.factoryPath, (...args) => {
    const selected = peers.find(value => args.length === (value.type === null ? 0 : 1));
    if (!selected) throw new Error("code_sdk_invalid_id");
    return handle(selected.appId, selected.type, selected.type === null ? selected.appId : args[0]);
  });
}
let owner;
if (manifest.owner) {
  const value = manifest.owner;
  owner = value.kind === "app" ? handle(value.appId, null, value.appId)
    : handle(value.ref.type.slice(0, value.ref.type.indexOf(".")), value.ref.type, value.ref.id);
}
const app = node();
function unavailable(method) {
  const phase = manifest.appMethods[method];
  const diagnostic = { code: "code_phase_unavailable", method, phase, message: "app." + method + " kommt in Phase " + phase };
  diagnostics.push(diagnostic);
  throw Object.assign(new Error(diagnostic.message), { code: diagnostic.code });
}
app.schedule = (when, fn, options) => {
  const object = when && typeof when === "object" && !Array.isArray(when);
  const once = object && "at" in when;
  const recurring = object && !once;
  if (typeof fn !== "function" || (!object && (typeof when !== "string" || !when.trim()))) throw new Error("code_sdk_invalid_schedule");
  if (once) {
    if (Object.keys(when).some(key => key !== "at" && key !== "timeZone") || typeof when.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(when.at) || !Number.isFinite(Date.parse(when.at)) || typeof when.timeZone !== "string" || !when.timeZone) throw new Error("code_sdk_invalid_schedule");
    const date = when.at.slice(0, 10);
    if (new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date || Number(when.at.slice(11, 13)) > 23) throw new Error("code_sdk_invalid_schedule");
    try { new Intl.DateTimeFormat("en", { timeZone: when.timeZone }); } catch { throw new Error("code_sdk_invalid_schedule"); }
  }
  if (recurring) {
    if (Object.keys(when).some(key => !["cron", "timeZone", "name"].includes(key)) || typeof when.cron !== "string" || !when.cron.trim()) throw new Error("code_sdk_invalid_schedule");
    if (when.timeZone !== undefined) {
      if (typeof when.timeZone !== "string" || !when.timeZone) throw new Error("code_sdk_invalid_schedule");
      try { new Intl.DateTimeFormat("en", { timeZone: when.timeZone }); } catch { throw new Error("code_sdk_invalid_schedule"); }
    }
  }
  const timing = once ? { cron: null, at: when.at, timeZone: when.timeZone } : recurring ? { cron: when.cron, ...(when.timeZone === undefined ? {} : { timeZone: when.timeZone }) } : { cron: when };
  const name = recurring && when.name !== undefined ? when.name : options?.name;
  if ((options !== undefined || (recurring && when.name !== undefined)) && (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))) throw new Error("code_sdk_invalid_schedule_name");
  const entrypoint = name ?? "schedule:" + schedules.length;
  if (schedules.some(value => value.entrypoint === entrypoint)) throw new Error("code_sdk_duplicate_schedule_name");
  const title = typeof options?.title === "string" ? options.title.trim() : options?.title;
  if (options?.title !== undefined && (typeof title !== "string" || !title || title.length > 200 || /[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title))) throw new Error("code_sdk_invalid_schedule_title");
  schedules.push({ entrypoint, ...timing, ...(title === undefined ? {} : { title }), handler: fn });
  return app;
};
for (const method of Object.keys(manifest.appMethods).filter(name => manifest.appMethods[name] !== 1)) app[method] = () => unavailable(method);
for (const method of ["get", "post", "put", "delete", "all"]) app[method] = (path, handler, options) => {
  if (typeof path !== "string" || typeof handler !== "function") throw new Error("code_sdk_invalid_route");
  const route = { method: method.toUpperCase(), path, public: options?.public === true };
  const entrypoint = "route:" + route.method + ":" + path;
  if (routes.some(value => value.entrypoint === entrypoint)) throw new Error("code_sdk_duplicate_route");
  routes.push({ entrypoint, route, handler });
  return app;
};
Object.freeze(app);
const secrets = new Proxy(node(), {
  get(_target, name) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error("code_sdk_invalid_secret_name");
    return "[secret:" + name + "]";
  },
  set() { throw new Error("code_sdk_readonly_secrets"); },
});
const http = Object.freeze({
  allow(_origins) {},
  async fetch(url, options = {}) {
    if (!bridge) throw new Error("code_sdk_bridge_unbound");
    if (typeof url !== "string" || !options || typeof options !== "object" || Array.isArray(options)) throw new Error("code_sdk_invalid_input");
    return bridge.call("http.fetch", { method: "GET", headers: {}, ...options, url });
  },
});
const __codeSdk = Object.freeze({
  namespaces, owner, app, secrets, http,
  bind(cloud) {
    if (bridge || !cloud || typeof cloud.call !== "function") throw new Error("code_sdk_invalid_bridge");
    bridge = cloud;
  },
  entries: () => [...schedules.map(({ entrypoint, cron, at, timeZone, title }) => ({ kind: "schedule", entrypoint, cron, ...(at === undefined ? {} : { at }), ...(timeZone === undefined ? {} : { timeZone }), ...(title === undefined ? {} : { title }) })),
    ...routes.map(({ entrypoint, route }) => ({ kind: "route", entrypoint, route, cron: null }))],
  diagnostics: () => diagnostics.map(value => ({ ...value })),
  async run(entrypoint, input) {
    const registered = routes.find(value => value.entrypoint === entrypoint);
    if (registered) {
      const raw = new Request("https://code.invalid" + input.path + input.query, {
        method: input.method, headers: { "Content-Type": input.contentType },
        ...(input.method === "GET" || input.method === "HEAD" ? {} : { body: input.body }),
      });
      const output = (value) => { const response = new Response(null); routeResponses.set(response, value); return response; };
      const status = (value) => { if (!Number.isInteger(value) || value < 200 || value > 599) throw new Error("code_invalid_response"); return value; };
      const c = {
        user: registered.route.public ? null : input.user,
        req: { raw, param: name => input.params[name] ?? "", query: name => new URL(raw.url).searchParams.get(name) ?? undefined,
          json: () => raw.json(), text: () => raw.text(), formData: () => raw.formData() },
        json: (value, code = 200) => output({ kind: "json", status: status(code), body: JSON.stringify(value) }),
        text: (value, code = 200) => output({ kind: "text", status: status(code), body: String(value) }),
        page: tree => {
          const ancestors = new Set(); let count = 0; let bytes = 0;
          const visit = (value, depth) => {
            if (++count > manifest.pageLimits.bytes || depth > manifest.pageLimits.depth * 3) throw new Error("code_page_limit");
            if (typeof value === "string") { bytes += new TextEncoder().encode(value).byteLength; if (bytes > manifest.pageLimits.bytes) throw new Error("code_page_limit"); return; }
            if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
            if (typeof value !== "object" || ancestors.has(value)) throw new Error("code_page_data_only");
            if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null && !Array.isArray(value)) throw new Error("code_page_data_only");
            ancestors.add(value);
            for (const key of Reflect.ownKeys(value)) {
              if (Array.isArray(value) && key === "length") continue;
              const descriptor = Object.getOwnPropertyDescriptor(value, key);
              if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("code_page_data_only");
              bytes += new TextEncoder().encode(key).byteLength;
              if (bytes > manifest.pageLimits.bytes) throw new Error("code_page_limit");
              visit(descriptor.value, depth + 1);
            }
            ancestors.delete(value);
          };
          visit(tree, 0);
          if (tree.kind !== "Page" || tree.version !== 1) throw new Error("code_page_root");
          if (new TextEncoder().encode(JSON.stringify(tree)).byteLength > manifest.pageLimits.bytes) throw new Error("code_page_limit");
          return output({ kind: "page", status: 200, tree });
        },
        redirect: (location, code = 303) => output({ kind: "redirect", status: code, location }),
      };
      const response = await registered.handler(c);
      const result = routeResponses.get(response);
      if (!result) throw new Error("code_invalid_response");
      return result;
    }
    const schedule = schedules.find(value => value.entrypoint === entrypoint);
    if (!schedule) throw new Error("code_sdk_missing_entrypoint");
    return schedule.handler();
  },
});
`;
