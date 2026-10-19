import { expect, spyOn, test } from "bun:test";
import { CLOUD_INVOCATION_JWKS_PATH, CLOUD_SESSION_JWKS_PATH } from "./constants";
import * as keyRing from "./key-ring";
import { createIdentityPublicRoutes } from "./routes";

test.each([CLOUD_SESSION_JWKS_PATH, CLOUD_INVOCATION_JWKS_PATH])("%s revalidates strong, weak and listed ETags", async (path) => {
  const etag = '"fixed-jwks"';
  const jwks = spyOn(keyRing, "listIdentityJwks").mockResolvedValue({ keys: [], etag });
  try {
    const routes = createIdentityPublicRoutes();
    for (const header of [etag, `W/${etag}`, `"different", W/${etag}`, "*"]) {
      const response = await routes.request(path, { headers: { "If-None-Match": header } });
      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe(etag);
      expect(await response.text()).toBe("");
    }
    for (const header of [undefined, 'W/"different"', '"prefix-fixed-jwks"']) {
      const response = await routes.request(path, { headers: header ? { "If-None-Match": header } : {} });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ keys: [] });
    }
    expect(jwks).toHaveBeenCalledWith(path === CLOUD_SESSION_JWKS_PATH ? "session" : "invocation");
  } finally {
    jwks.mockRestore();
  }
});
