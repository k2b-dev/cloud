import type { z } from "zod";
import type { CapabilityActionReviewData, CapabilityCatalog, CapabilityErrorSchema, CapabilityResult } from "../contracts/capabilities";

export type CapabilityKind = "query" | "action";
export type CapabilityClientError = z.infer<typeof CapabilityErrorSchema> & { status: number };
export type CapabilityResultState<T> = { ok: true; data: T } | { ok: false; error: CapabilityClientError };
export type CapabilityClientResult<T> = CapabilityResultState<CapabilityResult<T>>;
export type CapabilityReviewClientResult = CapabilityResultState<CapabilityActionReviewData>;
export type CapabilityCatalogClientResult = CapabilityResultState<CapabilityCatalog>;
export type CapabilityCatalogApp = CapabilityCatalog["apps"][number];
export type CapabilityCatalogAppClientResult = CapabilityResultState<CapabilityCatalogApp | null>;

export type CapabilityInvocation<TInput = unknown> = {
  appId: string;
  capabilityId: string;
  kind: CapabilityKind;
  input: TInput;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type CapabilityHttpOptions = {
  baseUrl?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  headers?: HeadersInit;
};

export type CapabilityCatalogOptions = CapabilityHttpOptions & {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
};
