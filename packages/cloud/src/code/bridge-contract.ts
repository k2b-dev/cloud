import type { CapabilityDispatchDependencies } from "../api/capabilities";
import type { CapabilityActionPolicy, NormalizedCapabilityCall } from "../contracts/capabilities";
import type { CodeRunTokenClaims } from "./run-token";

/** Payload-free bridge denial. A stale/expired lease uses HTTP 409 so the supervisor stops that attempt. */
export class CodeBridgeRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: 200 | 400 | 403 | 409 | 503 = 200,
    readonly origin?: string,
  ) {
    super(code);
  }
}
/** Live registry metadata for one ACTUAL schema-checked call, never the version's static permission list. */
export type CodeBridgeCall = {
  claims: CodeRunTokenClaims;
  call: NormalizedCapabilityCall;
  kind: "query" | "action" | "internet";
  policy?: CapabilityActionPolicy;
};
/** Core's admitted version mandate; the target app still resolves current resource rights. */
export type CodeBridgeAuthority = {
  mandateId: string;
  mandateRevision: number;
  ownerAppId: "core";
  /** Rechecks the current lease/policy and mandate binding inside the invocation issuance transaction. */
  withMandateIssueAuthority: NonNullable<CapabilityDispatchDependencies["withMandateIssueAuthority"]>;
};
/**
 * C4/C11/C13 host seam. Persist a bounded call reservation BEFORE execute; finish it for both
 * refusals and results. Reject stale generations before reserving. No in-memory run state.
 * The host checks admin budgets. Every effect MUST use the returned mandate authority wrapper,
 * which checks current policy/approval, exact version mandate/subject and actual C2 grant.
 * Internet calls use kind="internet" for policy and retain Action observations to prevent automatic effect retries.
 */
export interface CodeBridgeHost {
  withCall(call: CodeBridgeCall, execute: (authority: CodeBridgeAuthority) => Promise<Response>): Promise<Response>;
}
