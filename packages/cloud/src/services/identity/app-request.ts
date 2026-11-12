import { CapabilityAppIdSchema } from "../../contracts/capabilities";
import { requireAppKey } from "../../runtime/app-identity";
import { signAppProof } from "../../runtime/bootstrap-protocol";

/** Send only to Core. Call for every transmission, including safe caller-owned retries. */
export const sendAppRequest = async (
  request: Request,
  options: {
    appId: string;
    transport?: (request: Request) => Promise<Response>;
  },
): Promise<Response> => {
  const appId = CapabilityAppIdSchema.parse(options.appId);
  const headers = new Headers(request.headers);
  const declaredApp = headers.get("X-Cloud-App-Id");
  if (declaredApp !== null && declaredApp !== appId) throw new Error("App identity header does not match the calling application");
  headers.set("X-Cloud-App-Id", appId);
  const key = requireAppKey(appId);
  const url = new URL(request.url);
  const proof = await signAppProof(key, {
    method: request.method,
    path: url.pathname + url.search,
    body: new Uint8Array(await request.clone().arrayBuffer()),
  });
  headers.set("authorization", `Bearer ${proof}`);
  // A proof is bound to this target; redirects must never carry it elsewhere.
  return (options.transport ?? fetch)(new Request(request, { headers, redirect: "error" }));
};
