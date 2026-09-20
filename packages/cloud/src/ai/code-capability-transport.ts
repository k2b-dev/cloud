import type { CapabilityCaller } from "../capabilities/server";

export const CODE_CAPABILITY_TOKEN_HEADER = "x-cloud-code-capability-token";
export const codeCapabilityOperation = (conversationId: string, turnId: string) => `code-capabilities:${conversationId}:${turnId}`;
export const codeCapabilityPath = (conversationId: string, turnId: string) => `/api/_internal/ai/code/${conversationId}/${turnId}`;

/** Framework-owned callback; tokens stay in the host, never the sandbox or tool arguments. */
export function createCodeCapabilityTransport(
  current: () => { conversationId: string; turnId: string; token: string },
): NonNullable<CapabilityCaller["transport"]> {
  const configured = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  if (!configured) throw new Error("CLOUD_CORE_INTERNAL_ORIGIN is required for the code host");
  const origin = new URL(configured);
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("Invalid Core origin");
  return async (request) => {
    const target = new URL(origin);
    const context = current();
    if (!context.token) throw new Error("Code capability authority is unavailable");
    const source = new URL(request.url);
    if (!source.pathname.startsWith("/api/capabilities/v1/")) throw new Error("Invalid code capability route");
    target.pathname = codeCapabilityPath(context.conversationId, context.turnId) + source.pathname.slice("/api".length);
    target.search = "";
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.set("authorization", `Bearer ${context.token}`);
    return fetch(
      new Request(target, {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        redirect: "error",
        // @ts-expect-error Streaming server request bodies require duplex.
        duplex: request.body ? "half" : undefined,
      }),
    );
  };
}
