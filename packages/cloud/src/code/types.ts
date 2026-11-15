import type { CloudResourceRef, NormalizedCapabilityCall } from "../contracts/capabilities";
import type { CodeHttpRequest } from "../contracts/code-secrets";

/** Resource/app Code has statically enumerable targets; personal Code and code_run may use dynamic IDs. */
export type CodeSdkMode = "resource" | "personal" | "code_run";

/** The fixed owner is supplied by Core, never inferred from a caller's source code. */
export type CodeSdkOwner = { kind: "resource"; ref: CloudResourceRef } | { kind: "app"; appId: string };

/** Resource Code requires an owner. One-shot code_run has neither owner nor app registrations. */
export type CodeSdkOptions =
  | { mode: "resource"; owner: CodeSdkOwner }
  | { mode: "personal"; owner?: never }
  | { mode: "code_run"; owner?: never };

/** Transport metadata is separate from the canonical call and its approval/idempotency digest. */
export type CodeSdkCallMetadata = { idempotencyKey?: string };

/** Payload sent through cloud.call(operation, input); operation equals call.capability. */
export type CodeSdkInvocation = { call: NormalizedCapabilityCall; metadata: CodeSdkCallMetadata };

/** Runner-compatible object capability. Resolves query data/page envelopes, streaming FileRefs or Action domain data; the host throws on bridge refusals. No tokens enter the SDK. */
export type CodeSdkBridge = {
  call(operation: string, input: CodeSdkInvocation): Promise<unknown>;
  call(operation: "http.fetch", input: CodeHttpRequest): Promise<unknown>;
};

/** One named export and its originating manifest hash; an optional manifest name overrides the app-ID default. */
export type CodeSdkApp = { appId: string; exportName: string; manifestHash: string };

/** Factory and method paths are literal property segments, for the checker's handle/permission analysis. Null type means app-wide: an empty factoryPath binds methods directly to the export; only non-null types have factories. */
export type CodeSdkHandle = { appId: string; exportName: string; type: string | null; factoryPath: string[] };

/** An offered Query or Action. Types, refs and schema hashes come exclusively from the app's manifest. */
export type CodeSdkOperation = {
  capability: string;
  appId: string;
  localId: string;
  kind: "query" | "action";
  target: string | null;
  refs: Record<string, string>;
  methodPath: string[];
  inputSchema: Record<string, unknown>;
  dataSchema: Record<string, unknown>;
  schemaHash: string;
  idempotency: "required" | "none";
  stream?: { direction: "read" | "write"; maxBytes: number };
};

/** Discovered event contract; registrations bind an exact readable place. */
export type CodeSdkEvent = {
  type: string;
  version: number;
  subject: string;
  place: string | null;
  dataSchema: Record<string, unknown>;
  schemaHash: string;
};

/** Excluded entries remain visible to the checker so it can explain a forbidden call instead of suggesting a spelling fix. */
export type CodeSdkOmission = {
  capability: string;
  target: string | null;
  methodPath: string[];
  reason: "stream" | "code_false" | "app_only";
};

/** Supported app registration methods, consumed by generation and analysis. */
export const CODE_SDK_APP_PHASES = {
  schedule: 1,
  on: 1,
  get: 1,
  post: 1,
  put: 1,
  delete: 1,
  all: 1,
} as const;

/** Generation manifest for checker, test kit, CLI and chat hosts. It describes the SDK, not a checked Code version or an authorization grant. */
export type CodeSdkManifest = {
  version: 1;
  mode: CodeSdkMode;
  owner?: CodeSdkOwner;
  apps: CodeSdkApp[];
  handles: CodeSdkHandle[];
  operations: CodeSdkOperation[];
  events: CodeSdkEvent[];
  omitted: CodeSdkOmission[];
  appMethods: typeof CODE_SDK_APP_PHASES;
};

/** Standalone @sdk module pair plus checker metadata. Write declarations as sdk.d.ts and runtime as sdk.js. */
export type GeneratedCodeSdk = { declarations: string; runtime: string; manifest: CodeSdkManifest };
