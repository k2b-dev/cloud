import type { CloudResourceRef, NormalizedCapabilityCall } from "../contracts/capabilities";

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

/** Runner-compatible object capability. Resolves domain data; the host throws on bridge refusals. No tokens enter the SDK. */
export type CodeSdkBridge = { call(operation: string, input: CodeSdkInvocation): Promise<unknown> };

/** One named export and its originating manifest hash; export names replace hyphens with underscores. */
export type CodeSdkApp = { appId: string; exportName: string; manifestHash: string };

/** Factory and method paths are literal property segments, for the checker's handle/permission analysis. Null type means app-wide. */
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
};

/** Eligible future event, including its fixed place type. No event handler executes in Phase 1. */
export type CodeSdkEvent = { type: string; place: string | null; dataSchema: Record<string, unknown>; schemaHash: string };

/** Excluded entries remain visible to the checker so it can explain a forbidden call instead of suggesting a spelling fix. */
export type CodeSdkOmission = { capability: string; reason: "stream" | "code_false" | "app_only" };

/** Phase marker consumed by the checker. Later methods exist in types, but check and runtime refuse them in Phase 1. */
export const CODE_SDK_APP_PHASES = {
  schedule: 1,
  on: 3,
  get: 2,
  post: 2,
  put: 2,
  delete: 2,
  all: 2,
  nav: 2,
  webhook: 3,
  fetch: 2,
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

/** Visible phase diagnostic; source locations are attached by the checker, which analyzes the user's module. */
export type CodeSdkPhaseDiagnostic = { code: "code_phase_unavailable"; method: string; phase: 2 | 3; message: string };

/** Returns the Phase 1 diagnostic for a recognized app method, or null for schedule/unknown methods. */
export function codeSdkPhaseDiagnostic(method: string): CodeSdkPhaseDiagnostic | null {
  const phase = Object.entries(CODE_SDK_APP_PHASES).find(([name]) => name === method)?.[1];
  return phase === 2 || phase === 3
    ? { code: "code_phase_unavailable", method, phase, message: `app.${method} kommt in Phase ${phase}` }
    : null;
}
