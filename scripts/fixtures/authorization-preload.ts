import { afterAll } from "bun:test";
import { bindProcessApplicationId } from "../../packages/cloud/src/_internal/process-identity";
import { startProcessSync } from "../../packages/cloud/src/_internal/process-sync";
import { createIdentityPublicRoutes, initializeIdentityAuthority } from "../../packages/cloud/src/services/identity";
import { createIdentityOAuthIssuanceRoutes } from "../../packages/core/src/api/identity-oauth-issuance";
import oauthRoutes from "../../packages/oauth/src/oauth";

bindProcessApplicationId("core");
const runtime = await startProcessSync({ application: "core" });
const routes = createIdentityPublicRoutes()
  .route("/api/_internal/identity/v1", createIdentityOAuthIssuanceRoutes())
  .route("/", oauthRoutes);
const authority = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routes.fetch });
process.env.CLOUD_CORE_INTERNAL_ORIGIN = authority.url.origin;
process.env.CLOUD_IDENTITY_JWKS_ORIGIN = authority.url.origin;
process.env.CLOUD_OAUTH_JWKS_ORIGIN = authority.url.origin;
afterAll(async () => {
  await authority.stop(true);
  await runtime.stop();
});
await initializeIdentityAuthority();
