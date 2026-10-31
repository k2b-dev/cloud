import { getAppWorkloadCredential } from "../../_internal/workload-credential";
import { parseAppKey } from "../../app-key";
import { env } from "../../config/env";
import { CapabilityAppIdSchema } from "../../contracts/capabilities";
import { signAppProof } from "../../runtime/bootstrap-protocol";

/** Send only to Core. Call for every transmission, including safe caller-owned retries. */
export const sendAppRequest = async (
  request: Request,
  options: {
    appId: string;
    transport?: (request: Request) => Promise<Response>;
    /** Release N legacy authority; evaluated only when no app key is configured. */
    bearer?: () => string | undefined;
  },
): Promise<Response> => {
  const appId = CapabilityAppIdSchema.parse(options.appId);
  const headers = new Headers(request.headers);
  const declaredApp = headers.get("X-Cloud-App-Id");
  if (declaredApp !== null && declaredApp !== appId) throw new Error("App identity header does not match the calling application");
  headers.set("X-Cloud-App-Id", appId);
  const keyValue = env.CLOUD_APP_KEY;
  if (keyValue) {
    const key = parseAppKey(keyValue);
    if (key.appId !== options.appId) throw new Error("App-key appId does not match the calling application");
    const url = new URL(request.url);
    const proof = await signAppProof(key, {
      method: request.method,
      path: url.pathname + url.search,
      body: new Uint8Array(await request.clone().arrayBuffer()),
    });
    headers.set("authorization", `Bearer ${proof}`);
  } else if (!headers.has("authorization")) {
    const token = (options.bearer ?? getAppWorkloadCredential)();
    if (!token) throw new Error("App workload authorization is unavailable");
    headers.set("authorization", `Bearer ${token}`);
  }
  // A proof is bound to this target; redirects must never carry it elsewhere.
  return (options.transport ?? fetch)(new Request(request, { headers, redirect: "error" }));
};

/** Legacy workload tokens and the OAuth secret never contain JWT separators. */
export const isAppRequestProof = (authorization: string | undefined): boolean =>
  authorization?.startsWith("Bearer ") === true && authorization.slice(7).includes(".");
