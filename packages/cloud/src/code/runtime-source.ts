/** The generated module has no package, network, database, credential or environment imports. */
export const CODE_SDK_RUNTIME = String.raw`
const handles = new WeakMap();
let bridge;
const schedules = [];
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
      const refs = node();
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
app.schedule = (cron, fn, options) => {
  if (typeof cron !== "string" || !cron.trim() || typeof fn !== "function") throw new Error("code_sdk_invalid_schedule");
  const name = options?.name;
  if (options !== undefined && (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))) throw new Error("code_sdk_invalid_schedule_name");
  const entrypoint = name ?? "schedule:" + schedules.length;
  if (schedules.some(value => value.entrypoint === entrypoint)) throw new Error("code_sdk_duplicate_schedule_name");
  schedules.push({ entrypoint, cron, handler: fn });
  return app;
};
for (const method of Object.keys(manifest.appMethods).filter(name => name !== "schedule")) app[method] = () => unavailable(method);
Object.freeze(app);
const __codeSdk = Object.freeze({
  namespaces, owner, app,
  bind(cloud) {
    if (bridge || !cloud || typeof cloud.call !== "function") throw new Error("code_sdk_invalid_bridge");
    bridge = cloud;
  },
  entries: () => schedules.map(({ entrypoint, cron }) => ({ kind: "schedule", entrypoint, cron })),
  diagnostics: () => diagnostics.map(value => ({ ...value })),
  async run(entrypoint) {
    const schedule = schedules.find(value => value.entrypoint === entrypoint);
    if (!schedule) throw new Error("code_sdk_missing_entrypoint");
    return schedule.handler();
  },
});
`;
