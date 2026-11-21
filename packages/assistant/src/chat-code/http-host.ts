import type { HttpReview, HttpScope, SecretMetadata } from "./http-contracts";
export type HttpApproval = HttpReview & { type: "http"; name: string };
export type HttpHost = {
  approve: (request: HttpApproval, signal: AbortSignal) => Promise<boolean>;
  /** Whether a remembered website approval already allows the request; checked before `approve` asks. */
  allowed?: (request: HttpApproval, signal: AbortSignal) => Promise<boolean>;
  secret?: (scope: HttpScope, input: SecretMetadata, signal: AbortSignal) => Promise<{ configured: boolean; name: string }>;
};
