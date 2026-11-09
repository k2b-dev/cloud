import type { CapabilityDispatchDependencies } from "../api/capabilities";
import { CAPABILITY_FRAMEWORK_ERROR_CODES, type CapabilityActionPolicy, type NormalizedCapabilityCall } from "../contracts/capabilities";
import type { CodeBridgeRefusalKind } from "../contracts/code-call";

export { CODE_BRIDGE_REFUSAL_KINDS, type CodeBridgeRefusalKind } from "../contracts/code-call";

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
  get errorStatus(): number {
    if (this.status !== 200) return this.status;
    if (this.code === "code_operation_not_found") return 404;
    if (
      [
        "code_rate_limited",
        "code_call_limit",
        "code_wall_clock_limit",
        "code_ai_budget_limit",
        "code_ai_daily_budget_limit",
        "code_ai_owner_daily_budget_limit",
      ].includes(this.code)
    )
      return 429;
    if (
      [
        "code_ai_budget_reserved",
        "code_file_spent",
        "code_file_mismatch",
        "code_not_active",
        "code_bundle_mismatch",
        "code_version_mismatch",
        "code_mandate_mismatch",
        "code_hash_mismatch",
      ].includes(this.code)
    )
      return 409;
    if (["code_bridge_unavailable", "code_file_unavailable"].includes(this.code)) return 503;
    if (
      ["code_invalid_call", "code_http_invalid_call", "code_file_invalid", "code_input_limit", "code_file_size_limit"].includes(this.code)
    )
      return 400;
    if (
      codeBridgeLocalRefusalKind(this.code) !== "bridge" ||
      ["code_access_removed", "code_file_source_refused", "code_file_target_refused"].includes(this.code)
    )
      return 403;
    return 503;
  }
}
/** Live registry metadata for one ACTUAL schema-checked call, never the version's static permission list. */
export type CodeBridgeCall = {
  claims: CodeRunTokenClaims;
  call: NormalizedCapabilityCall;
  kind: "query" | "action" | "internet";
  policy?: CapabilityActionPolicy;
};
/** Local policy/approval refusals must never be mistaken for a target application's 403. */
export const codeBridgeLocalRefusalKind = (code: string): CodeBridgeRefusalKind => {
  if (["code_approval_required", "code_approval_revoked", "code_hash_mismatch"].includes(code)) return "approval";
  return [
    "code_access_forbidden",
    "code_stream_forbidden",
    "code_disabled",
    "code_policy_never",
    "code_ai_budget_limit",
    "code_ai_daily_budget_limit",
    "code_ai_owner_daily_budget_limit",
    "code_sends_not_yet",
    "code_unattended_forbidden",
    "code_http_origin_forbidden",
    "code_http_origin_undeclared",
    "code_http_path_forbidden",
    "code_http_secret_forbidden",
    "code_http_forbidden",
  ].includes(code)
    ? "policy"
    : "bridge";
};
/** The provider status is observed before response validation; a bridge/broker 403 is not a target refusal. */
const frameworkCodes = new Set<string>(Object.values(CAPABILITY_FRAMEWORK_ERROR_CODES).map((code) => code.toLowerCase()));
export const codeBridgeDispatchRefusalKind = (code: string, targetStatus?: number): CodeBridgeRefusalKind => {
  if (code === "app_access_denied") return "app_not_allowed";
  // A provider's review can require confirmation even for a nominally silent Action.
  const localKind = codeBridgeLocalRefusalKind(code);
  if (localKind !== "bridge") return localKind;
  if (code === "mandate_forbidden" || code === "mandate_policy_denied") return "policy";
  if (frameworkCodes.has(code)) return "bridge";
  return targetStatus === 403 || targetStatus === 404 ? "target_refused" : "bridge";
};
/** Core's admitted version mandate; the target app still resolves current resource rights. */
export type CodeBridgeAuthority = {
  /** Atomically spends a run-bound file reference before any target effect. False means already spent. */
  consumeFileRef?: (digest: string) => Promise<boolean>;
  /** Internal observation only. Core persists this reason with the call result; never grants authority. */
  onRefusal?: (kind: CodeBridgeRefusalKind) => void;
  /** Original capability error for Core accounting, before the runner's payload-free error projection. */
  onFailure?: (error: unknown) => void;
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
