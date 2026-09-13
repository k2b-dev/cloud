import { artifactClient } from "./client";
import { HttpRequest, type HttpScope, type HttpReview, type SecretMetadata } from "./http-contracts";

export type HttpApproval = HttpReview & { type: "http"; name: string };
export type HttpHost = {
  approve: (request: HttpApproval, signal: AbortSignal) => Promise<boolean>;
  secret?: (scope: HttpScope, input: SecretMetadata, signal: AbortSignal) => Promise<{ configured: boolean; name: string }>;
};
export async function runHttp(request: unknown, scope: HttpScope, host: HttpHost, signal: AbortSignal) {
  signal.throwIfAborted();
  const call = { id: crypto.randomUUID(), createdAt: Date.now(), scope, request: HttpRequest.parse(request) };
  const review = await artifactClient.httpPrepare(call, signal);
  try {
    const approved = await host.approve({ ...review, type: "http", name: `http.fetch:${new URL(review.url).origin}` }, signal);
    signal.throwIfAborted();
    if (!approved) throw new Error("HTTP_DENIED");
    return await artifactClient.httpExecute(call.id, true, signal);
  } catch (error) {
    // Resolve unsent pending calls on cancellation or validation failure. A sent
    // call can no longer become pending and is never replayed by this cleanup.
    await artifactClient.httpExecute(call.id, false, AbortSignal.timeout(10000)).catch(() => {});
    throw error;
  }
}
