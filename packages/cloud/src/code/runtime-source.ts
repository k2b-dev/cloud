/** The generated module has no package, network, database, credential or environment imports. */
export const CODE_SDK_RUNTIME = String.raw`
class CodeError extends Error {
  constructor(code, status = 400, message = code, details = null) {
    super(message);
    this.name = "CodeError";
    this.code = code.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    this.status = status;
    this.details = details;
  }
}
async function invoke(operation, input) {
  try { return await bridge.call(operation, input); }
  catch (error) {
    if (error instanceof CodeError) throw error;
    const code = typeof error?.code === "string" ? error.code : "code_bridge_unavailable";
    throw new CodeError(code, error?.status ?? 503, error?.message ?? "The Code call failed.", error?.details ?? (error?.origin ? { origin: error.origin } : null));
  }
}
const handles = new WeakMap();
const aiTools = new WeakMap();
let bridge;
const schedules = [];
const routes = [];
const middleware = [];
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
  if (!ref || ref.type !== type) throw new CodeError("code_sdk_invalid_handle");
  return { type: ref.type, id: ref.id };
}
function handle(appId, type, id) {
  if (typeof id !== "string" || id.length === 0 || id.length > RESOURCE_ID_MAX) throw new CodeError("code_sdk_invalid_id");
  const result = node();
  const ref = Object.freeze({ type: type ?? "cloud.app", id });
  handles.set(result, ref);
  Object.defineProperties(result, { type: { value: ref.type, enumerable: true }, id: { value: ref.id, enumerable: true } });
  for (const op of manifest.operations.filter(op => op.appId === appId && op.target === type)) {
    const method = async (args) => {
      if (!bridge) throw new CodeError("code_sdk_bridge_unbound");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new CodeError("code_sdk_invalid_input");
      const input = { ...args };
      if (op.capability === "core.ai.generate" || op.capability === "core.ai.decide") {
        if (input.tools !== undefined) {
          if (!Array.isArray(input.tools)) throw new CodeError("code_ai_tool_invalid");
          input.tools = input.tools.map(tool => {
            const binding = aiTools.get(tool);
            if (!binding) throw new CodeError("code_ai_tool_invalid");
            return binding;
          });
        }
      }
      const refs = {};
      for (const [field, refType] of Object.entries(op.refs)) {
        refs[field] = coordinate(input[field], refType);
        delete input[field];
      }
      const metadata = {};
      if (op.kind === "action") {
        const key = input.idempotencyKey;
        if (op.idempotency === "required" && (typeof key !== "string" || key.trim().length === 0)) throw new CodeError("code_sdk_idempotency_required");
        if (op.idempotency === "none" && key !== undefined) throw new CodeError("code_sdk_idempotency_not_allowed");
        if (key !== undefined && (typeof key !== "string" || key.trim().length > 200 || !/^[\x21-\x7e]+$/.test(key.trim()))) throw new CodeError("code_sdk_invalid_idempotency_key");
        if (key !== undefined) metadata.idempotencyKey = key.trim();
        delete input.idempotencyKey;
      }
      const call = { capability: op.capability, target: type === null ? null : coordinate(result, type), refs, input };
      return invoke(op.capability, { call, metadata });
    };
    if (Object.keys(op.refs).length === 0) aiTools.set(method, Object.freeze({ capability: op.capability,
      target: type === null ? null : Object.freeze(coordinate(result, type)) }));
    setPath(result, op.methodPath, method);
  }
  return result;
}
const namespaces = node();
for (const spec of manifest.handles.filter(value => value.type === null))
  namespaces[spec.exportName] = handle(spec.appId, null, spec.appId);
for (const spec of manifest.handles.filter(value => value.type !== null)) {
  setPath(namespaces[spec.exportName], spec.factoryPath, (...args) => {
    if (args.length !== 1) throw new CodeError("code_sdk_invalid_id");
    return Object.freeze(handle(spec.appId, spec.type, args[0]));
  });
}
for (const app of manifest.apps) Object.freeze(namespaces[app.exportName]);
let owner;
if (manifest.owner) {
  const value = manifest.owner;
  owner = Object.freeze(value.kind === "app" ? handle(value.appId, null, value.appId)
    : handle(value.ref.type.slice(0, value.ref.type.indexOf(".")), value.ref.type, value.ref.id));
}
const app = node();
app.use = (...args) => {
  const [path, handler] = args.length === 1 ? ["/", args[0]] : args;
  if (args.length < 1 || args.length > 2 || typeof path !== "string" ||
      !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?)?$/.test(path) || path.length > 200 || typeof handler !== "function")
    throw new CodeError("code_sdk_invalid_middleware");
  middleware.push({ path: path === "/" ? "/" : path.replace(/\/$/, ""), handler });
  return app;
};
app.schedule = (...args) => {
  const [when, fn] = args;
  const object = when && typeof when === "object" && !Array.isArray(when);
  const once = object && "at" in when;
  const recurring = object && !once;
  if (args.length !== 2 || !object || typeof fn !== "function") throw new CodeError("code_sdk_invalid_schedule");
  if (once) {
    if (Object.keys(when).some(key => !["at", "timeZone", "name", "title"].includes(key)) || typeof when.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(when.at) || !Number.isFinite(Date.parse(when.at))) throw new CodeError("code_sdk_invalid_schedule");
    const date = when.at.slice(0, 10);
    if (new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date || Number(when.at.slice(11, 13)) > 23) throw new CodeError("code_sdk_invalid_schedule");
    if (when.timeZone !== undefined) {
      if (typeof when.timeZone !== "string" || !when.timeZone) throw new CodeError("code_sdk_invalid_schedule");
      try { new Intl.DateTimeFormat("en", { timeZone: when.timeZone }); } catch { throw new CodeError("code_sdk_invalid_schedule"); }
    }
  }
  if (recurring) {
    if (Object.keys(when).some(key => !["cron", "timeZone", "name", "title"].includes(key)) || typeof when.cron !== "string" || !when.cron.trim()) throw new CodeError("code_sdk_invalid_schedule");
    if (when.timeZone !== undefined) {
      if (typeof when.timeZone !== "string" || !when.timeZone) throw new CodeError("code_sdk_invalid_schedule");
      try { new Intl.DateTimeFormat("en", { timeZone: when.timeZone }); } catch { throw new CodeError("code_sdk_invalid_schedule"); }
    }
  }
  const timing = { ...(once ? { cron: null, at: when.at } : { cron: when.cron }), ...(when.timeZone === undefined ? {} : { timeZone: when.timeZone }) };
  const name = when.name;
  if ((name !== undefined) && (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))) throw new CodeError("code_sdk_invalid_schedule_name");
  const entrypoint = name ?? "schedule:" + schedules.filter(value => value.kind === "schedule").length;
  if (schedules.some(value => value.entrypoint === entrypoint)) throw new CodeError("code_sdk_duplicate_schedule_name");
  const title = typeof when.title === "string" ? when.title.trim() : when.title;
  if (when.title !== undefined && (typeof title !== "string" || !title || title.length > 200 || /[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title))) throw new CodeError("code_sdk_invalid_schedule_title");
  schedules.push({ kind: "schedule", entrypoint, ...timing, ...(title === undefined ? {} : { title }), handler: fn });
  return app;
};
app.on = (...args) => {
  const explicit = args.length === 3;
  const eventType = args[explicit ? 1 : 0];
  const fn = args[explicit ? 2 : 1];
  const place = explicit ? handles.get(args[0]) : manifest.owner?.kind === "resource" ? manifest.owner.ref : undefined;
  const spec = manifest.events.find(event => event.type === eventType);
  if (![2, 3].includes(args.length) || typeof fn !== "function" || !spec || !place || spec.place !== place.type)
    throw new CodeError("code_event_owner");
  const own = manifest.owner?.kind === "resource" && place.type === manifest.owner.ref.type && place.id === manifest.owner.ref.id;
  const entrypoint = "event:" + eventType + "@" + spec.version + (own ? "" : ":place:" + schedules.filter(value => value.kind === "event").length);
  if (schedules.some(value => value.kind === "event" && value.event.type === eventType &&
      value.event.version === spec.version && value.event.place.type === place.type && value.event.place.id === place.id))
    throw new CodeError("code_duplicate_on");
  schedules.push({ kind: "event", entrypoint, cron: null, event: { type: eventType, version: spec.version, place: { type: place.type, id: place.id } }, handler: fn });
  return app;
};
for (const method of ["get", "post", "put", "delete", "all"]) app[method] = (path, handler, options) => {
  if (typeof path !== "string" || typeof handler !== "function") throw new CodeError("code_sdk_invalid_route");
  const route = { method: method.toUpperCase(), path, public: options?.public === true, ...(options?.layout === "plain" ? { layout: "plain" } : {}) };
  const entrypoint = "route:" + route.method + ":" + path;
  if (routes.some(value => value.entrypoint === entrypoint)) throw new CodeError("code_sdk_duplicate_route");
  routes.push({ entrypoint, route, handler, middleware: [...middleware] });
  return app;
};
Object.freeze(app);
const secrets = new Proxy(node(), {
  get(_target, name) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new CodeError("code_sdk_invalid_secret_name");
    return "[secret:" + name + "]";
  },
  set() { throw new CodeError("code_sdk_readonly_secrets"); },
});
const http = Object.freeze({
  allow(_origins) {},
  async fetch(url, options = {}) {
    if (!bridge) throw new CodeError("code_sdk_bridge_unbound");
    if (typeof url !== "string" || !options || typeof options !== "object" || Array.isArray(options)) throw new CodeError("code_sdk_invalid_input");
    return invoke("http.fetch", { method: "GET", headers: {}, ...options, url });
  },
});
// Pages that the SDK's blocks built; c.page draws only these, never a hand-written description.
const builtPages = new WeakSet();
const __codeSdk = Object.freeze({
  markPage: page => { builtPages.add(page); return page; },
  namespaces, owner, app, secrets, http, CodeError,
  bind(cloud) {
    if (bridge || !cloud || typeof cloud.call !== "function") throw new CodeError("code_sdk_invalid_bridge");
    bridge = cloud;
  },
  entries: () => [...schedules.map(({ kind, entrypoint, cron, at, timeZone, title, event }) => ({ kind, entrypoint, cron, ...(at === undefined ? {} : { at }), ...(timeZone === undefined ? {} : { timeZone }), ...(event === undefined ? {} : { event }), ...(title === undefined ? {} : { title }) })),
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
      const status = (value) => { if (!Number.isInteger(value) || value < 200 || value > 599) throw new CodeError("code_invalid_response"); return value; };
      const variables = new Map();
      const c = {
        set: (key, value) => { variables.set(key, value); },
        get: key => variables.get(key),
        user: registered.route.public || !input.user ? null : {
          id: input.user.id, username: input.user.username, groupIds: [...input.user.groupIds], groupNames: [...input.user.groupNames], kind: input.user.kind,
          name: input.user.name,
        },
        req: { raw, param: name => input.params[name] ?? "", query: name => new URL(raw.url).searchParams.get(name) ?? undefined,
          json: () => raw.json(), text: () => raw.text(), formData: () => raw.formData() },
        json: (value, code = 200) => output({ kind: "json", status: status(code), body: JSON.stringify(value) }),
        text: (value, code = 200) => output({ kind: "text", status: status(code), body: String(value) }),
        page: tree => {
          const ancestors = new Set(); let count = 0; let bytes = 0;
          const visit = (value, depth) => {
            if (++count > manifest.pageLimits.bytes || depth > manifest.pageLimits.depth * 3) throw new CodeError("code_page_limit");
            if (typeof value === "string") { bytes += new TextEncoder().encode(value).byteLength; if (bytes > manifest.pageLimits.bytes) throw new CodeError("code_page_limit"); return; }
            if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
            if (typeof value !== "object" || ancestors.has(value)) throw new CodeError("code_page_data_only");
            if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null && !Array.isArray(value)) throw new CodeError("code_page_data_only");
            ancestors.add(value);
            for (const key of Reflect.ownKeys(value)) {
              if (Array.isArray(value) && key === "length") continue;
              const descriptor = Object.getOwnPropertyDescriptor(value, key);
              if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new CodeError("code_page_data_only");
              // An optional prop set to undefined is absent, as in JSON; a hole in a list stays an error.
              if (descriptor.value === undefined && !Array.isArray(value)) continue;
              bytes += new TextEncoder().encode(key).byteLength;
              if (bytes > manifest.pageLimits.bytes) throw new CodeError("code_page_limit");
              visit(descriptor.value, depth + 1);
            }
            ancestors.delete(value);
          };
          if (!builtPages.has(tree)) throw new CodeError("code_page_blocks");
          visit(tree, 0);
          if (tree.kind !== "Page" || tree.version !== 1) throw new CodeError("code_page_root");
          if (new TextEncoder().encode(JSON.stringify(tree)).byteLength > manifest.pageLimits.bytes) throw new CodeError("code_page_limit");
          return output({ kind: "page", status: 200, tree });
        },
        redirect: (location, code = 303) => output({ kind: "redirect", status: code, location }),
      };
      const path = input.path.split("/").map(segment => decodeURIComponent(segment)).join("/");
      const chain = registered.middleware.filter(value => value.path === "/" || path === value.path || path.startsWith(value.path + "/"));
      let last = -1;
      const dispatch = async index => {
        if (index <= last) throw new CodeError("code_middleware_next_called_twice");
        last = index;
        if (index === chain.length) return registered.handler(c);
        let following;
        let settled;
        let finished = false;
        const next = () => {
          if (finished || following) return Promise.reject(new CodeError("code_middleware_next_called_twice"));
          following = dispatch(index + 1);
          // Observe rejection immediately; the middleware may catch it or finish other work first.
          settled = following.catch(() => {});
          return following;
        };
        try {
          const response = await chain[index].handler(c, next);
          return response === undefined && following ? await following : response;
        } finally {
          finished = true;
          // Drain work already started by next(), preserving a middleware's own response or error.
          if (settled) await settled;
        }
      };
      const response = await dispatch(0);
      const result = routeResponses.get(response);
      if (!result) throw new CodeError("code_invalid_response");
      return result;
    }
    const schedule = schedules.find(value => value.entrypoint === entrypoint);
    if (!schedule) throw new CodeError("code_sdk_missing_entrypoint");
    if (schedule.kind === "event") {
      if (!input || input.type !== schedule.event.type || input.version !== schedule.event.version ||
          input.place?.type !== schedule.event.place.type || input.place.id !== schedule.event.place.id || typeof input.id !== "string")
        throw new CodeError("code_event_input");
      return schedule.handler(input);
    }
    return schedule.handler(input);
  },
});
`;
