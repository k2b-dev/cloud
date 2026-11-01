import { stableJsonValue } from "../_internal/capability-schemas";
import {
  type CapabilityManifest,
  CapabilityManifestSchema,
  CLOUD_RESOURCE_ID_MAX_LENGTH,
  CloudResourceRefSchema,
} from "../contracts/capabilities";
import * as authoringTypes from "./authoring-types.ts" with { type: "text" };
import { CODE_SDK_RUNTIME } from "./runtime-source";
import { schemaTypes } from "./schema-types";
import { CODE_SDK_APP_PHASES, type CodeSdkManifest, type CodeSdkOperation, type CodeSdkOptions, type GeneratedCodeSdk } from "./types";

type Tree = { values: string[]; children: Map<string, Tree> };
const tree = (): Tree => ({ values: [], children: new Map() });
const path = (value: string): string[] => value.split(".");
const quote = JSON.stringify;
const forbiddenProperties = new Set(["__proto__", "prototype", "constructor"]);
const reservedExports = new Set([
  "undefined",
  "eval",
  "arguments",
  "ai",
  "db",
  "secrets",
  "sheet",
  "app",
  "owner",
  "__codeSdk",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
const exportName = (appId: string): string => {
  const name = appId.replaceAll("-", "_");
  return reservedExports.has(name) ? `_${name}` : name;
};
const insert = (root: Tree, segments: string[], value: string, label: string): void => {
  let branch = root;
  for (const key of segments) {
    if (forbiddenProperties.has(key)) throw new Error(`${label}: SDK path collision at ${key}`);
    let child = branch.children.get(key);
    if (!child) {
      child = tree();
      branch.children.set(key, child);
    }
    branch = child;
  }
  branch.values.push(`(${value})`);
};
const render = (root: Tree): string => {
  const parts = [...root.values];
  if (root.children.size)
    parts.push(
      `{ ${[...root.children]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `readonly ${quote(key)}: ${render(child)}`)
        .join("; ")} }`,
    );
  return parts.join(" & ") || "{}";
};
const byId = <T extends { localId: string }>(entries: readonly T[]): T[] => [...entries].sort((a, b) => a.localId.localeCompare(b.localId));

/**
 * Generates a deterministic, standalone @sdk module from live capability manifests.
 * No app IDs or schemas are compiled into the generator. The checker consumes manifest.handles,
 * operations and appMethods; hosts bind the runtime to the trusted cloud object.
 */
export function generateCodeSdk(manifests: readonly CapabilityManifest[], options: CodeSdkOptions): GeneratedCodeSdk {
  if (
    !options ||
    !["resource", "personal", "code_run"].includes(options.mode) ||
    (options.mode === "resource" ? !options.owner : options.owner !== undefined)
  )
    throw new Error("Invalid SDK options");
  if (options.owner && options.owner.kind !== "resource" && options.owner.kind !== "app") throw new Error("Invalid SDK owner");
  const apps = manifests.map((value) => CapabilityManifestSchema.parse(value)).sort((a, b) => a.appId.localeCompare(b.appId));
  if (new Set(apps.map((app) => app.appId)).size !== apps.length) throw new Error("Duplicate SDK app ID");
  const manifest: CodeSdkManifest = {
    version: 1,
    mode: options.mode,
    ...(options.owner ? { owner: structuredClone(options.owner) } : {}),
    apps: [],
    handles: [],
    operations: [],
    events: [],
    omitted: [],
    appMethods: { ...CODE_SDK_APP_PHASES },
  };
  if (options.owner) {
    const owner = options.owner;
    if (owner.kind === "app") {
      if (!apps.some((app) => app.appId === owner.appId)) throw new Error("SDK owner app is not in the catalog");
    } else {
      CloudResourceRefSchema.parse(owner.ref);
      if (!apps.some((app) => app.types.some((type) => `${app.appId}.${type.localId}` === owner.ref.type)))
        throw new Error("SDK owner type is not in the catalog");
    }
  }
  for (const app of apps) {
    const name = exportName(app.appId);
    const ids = [...app.types, ...app.queries, ...app.actions, ...app.commands].map((entry) => entry.localId);
    if (new Set(ids).size !== ids.length) throw new Error(`${app.appId}: duplicate capability local ID`);
    manifest.apps.push({ appId: app.appId, exportName: name, manifestHash: app.manifestHash });
    manifest.handles.push({ appId: app.appId, exportName: name, type: null, factoryPath: ["app"] });
    for (const type of byId(app.types))
      manifest.handles.push({ appId: app.appId, exportName: name, type: `${app.appId}.${type.localId}`, factoryPath: path(type.localId) });
    for (const [kind, entries] of [
      ["query", app.queries],
      ["action", app.actions],
    ] as const) {
      for (const operation of byId(entries)) {
        const capability = `${app.appId}.${operation.localId}`;
        const reason = operation.stream
          ? "stream"
          : "code" in operation && operation.code === false
            ? "code_false"
            : "appOnly" in operation && operation.appOnly
              ? "app_only"
              : null;
        if (reason) {
          manifest.omitted.push({ capability, reason });
          continue;
        }
        const refs = Object.fromEntries(
          Object.entries(operation.refs ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([field, type]) => [field, `${app.appId}.${type}`]),
        );
        if (operation.inputSchema.type !== "object" || operation.inputSchema.additionalProperties !== false)
          throw new Error(`${capability}: SDK input must be a closed object`);
        const properties = operation.inputSchema.properties;
        for (const field of [...Object.keys(refs), ...(kind === "action" ? ["idempotencyKey"] : [])]) {
          if (forbiddenProperties.has(field) || (properties && typeof properties === "object" && Object.hasOwn(properties, field)))
            throw new Error(`${capability}: reserved SDK input field ${field}`);
        }
        manifest.operations.push({
          capability,
          appId: app.appId,
          localId: operation.localId,
          kind,
          target: operation.target ? `${app.appId}.${operation.target}` : null,
          refs,
          methodPath: path(operation.localId),
          inputSchema: structuredClone(operation.inputSchema),
          dataSchema: structuredClone(operation.dataSchema),
          schemaHash: operation.schemaHash,
          idempotency: "idempotency" in operation && operation.idempotency === "required" ? "required" : "none",
        });
      }
    }
    for (const event of byId(app.events ?? [])) {
      if (event.automation === false) continue;
      manifest.events.push({
        type: `${app.appId}.${event.localId}`,
        place: event.place ? `${app.appId}.${event.place}` : null,
        dataSchema: structuredClone(event.dataSchema),
        schemaHash: event.schemaHash,
      });
    }
  }
  if (!("default" in authoringTypes) || typeof authoringTypes.default !== "string")
    throw new Error("Expected Code SDK authoring type source");
  const declarations = ["// Generated from Cloud capability manifests. Do not edit.", authoringTypes.default.trim()];
  const methods = new Map<CodeSdkOperation, string>();
  for (const [index, op] of manifest.operations.entries()) {
    const fields = Object.entries(op.refs).map(([name, type]) => ({ name, type: `CodeHandle<${quote(type)}>`, required: true }));
    if (op.kind === "action")
      fields.push({
        name: "idempotencyKey",
        type: op.idempotency === "required" ? "string" : "never",
        required: op.idempotency === "required",
      });
    const input = schemaTypes(op.inputSchema, `Input${index}`, fields);
    const output = schemaTypes(op.dataSchema, `Data${index}`);
    declarations.push(
      ...input.declarations,
      ...output.declarations,
      `type Input${index} = ${input.type};`,
      `type Data${index} = ${output.type};`,
    );
    methods.set(op, `(input: Input${index}) => Promise<Data${index}>`);
  }
  const handleNames = new Map<string, string>();
  for (const [index, handle] of manifest.handles.entries()) {
    const name = `Handle${index}`;
    handleNames.set(handle.type ?? `app:${handle.appId}`, name);
    const body = tree();
    for (const op of manifest.operations.filter((op) => op.appId === handle.appId && op.target === handle.type)) {
      if (["id", "type"].includes(op.methodPath[0] ?? "")) throw new Error(`${op.capability}: SDK path collides with handle identity`);
      insert(body, op.methodPath, methods.get(op)!, op.capability);
    }
    declarations.push(`type ${name}<Id extends string = string> = CodeHandle<${quote(handle.type ?? "cloud.app")}, Id> & ${render(body)};`);
  }
  for (const app of manifest.apps) {
    const factories = tree();
    for (const handle of manifest.handles.filter((handle) => handle.appId === app.appId)) {
      const type = handleNames.get(handle.type ?? `app:${app.appId}`)!;
      insert(
        factories,
        handle.factoryPath,
        handle.type === null
          ? `() => ${type}<${quote(app.appId)}>`
          : `<const Id extends string>(id: ${options.mode === "resource" ? "CodeLiteralId<Id>" : "Id"}) => ${type}<Id>`,
        app.appId,
      );
    }
    declarations.push(`export declare const ${app.exportName}: ${render(factories)};`);
  }
  if (options.owner) {
    const owner = options.owner;
    const type = owner.kind === "app" ? handleNames.get(`app:${owner.appId}`) : handleNames.get(owner.ref.type);
    declarations.push(`export declare const owner: ${type}<${quote(owner.kind === "app" ? owner.appId : owner.ref.id)}>;`);
  }
  if (options.mode !== "code_run") {
    const events = manifest.events.map((event, index) => {
      const data = schemaTypes(event.dataSchema, `Event${index}`);
      declarations.push(...data.declarations);
      return `${quote(event.type)}: ${data.type}`;
    });
    declarations.push(
      `export type CodeEvents = { ${events.join("; ")} };`,
      `export type CodeApp = {
  schedule(cron: string, handler: CodeScheduleHandler, options?: { name: string }): CodeApp;
  /** Phase 3; check reports code_phase_unavailable. */
  on<Event extends keyof CodeEvents>(event: Event, handler: (data: CodeEvents[Event]) => void | Promise<void>): CodeApp;
  on<Event extends keyof CodeEvents>(handle: CodeHandle<string>, event: Event, handler: (data: CodeEvents[Event]) => void | Promise<void>): CodeApp;
  /** Phase 2; check reports code_phase_unavailable. */
  get(path: string, handler: (c: CodeContext) => Response | Promise<Response>): CodeApp;
  post(path: string, handler: (c: CodeContext) => Response | Promise<Response>): CodeApp;
  put(path: string, handler: (c: CodeContext) => Response | Promise<Response>): CodeApp;
  delete(path: string, handler: (c: CodeContext) => Response | Promise<Response>): CodeApp;
  all(path: string, handler: (c: CodeContext) => Response | Promise<Response>): CodeApp;
  nav(handler: (user: CodeUser) => CodeNavigationItem[] | Promise<CodeNavigationItem[]>): CodeApp;
  /** Phase 3; check reports code_phase_unavailable. */
  webhook(path: string, handler: (c: CodeWebhookContext) => Response | Promise<Response>): CodeApp;
  fetch(request: Request): Promise<Response>;
};`,
      "export declare const app: CodeApp;",
    );
  }
  declarations.push("export declare const secrets: Readonly<Record<string, CodeSecret>>;", "export declare const http: CodeHttp;");
  const runtimeExports = [
    "export const secrets = __codeSdk.secrets;",
    "export const http = __codeSdk.http;",
    "export { __codeSdk };",
    ...manifest.apps.map((app) => `export const ${app.exportName} = __codeSdk.namespaces[${quote(app.exportName)}];`),
    ...(options.owner ? ["export const owner = __codeSdk.owner;"] : []),
    ...(options.mode === "code_run" ? [] : ["export const app = __codeSdk.app;"]),
  ];
  const runtimeManifest = {
    apps: manifest.apps.map(({ exportName }) => ({ exportName })),
    handles: manifest.handles,
    operations: manifest.operations.map(({ capability, appId, kind, target, refs, methodPath, idempotency }) => ({
      capability,
      appId,
      kind,
      target,
      refs,
      methodPath,
      idempotency,
    })),
    ...(manifest.owner ? { owner: manifest.owner } : {}),
    appMethods: manifest.appMethods,
  };
  return {
    declarations: `${declarations.join("\n\n")}\n`,
    runtime: `// Generated from Cloud capability manifests. Do not edit.\nconst __codeSdk = (() => {\nconst manifest = ${JSON.stringify(stableJsonValue(runtimeManifest))};\nconst RESOURCE_ID_MAX = ${CLOUD_RESOURCE_ID_MAX_LENGTH};\n${CODE_SDK_RUNTIME}\nreturn __codeSdk;\n})();\n${runtimeExports.join("\n")}\n`,
    manifest,
  };
}
