import { afterAll } from "bun:test";
import { bindProcessApplicationId } from "../../packages/cloud/src/_internal/process-identity";
import { startProcessSync } from "../../packages/cloud/src/_internal/process-sync";
import { createIdentityPublicRoutes, initializeIdentityAuthority } from "../../packages/cloud/src/services/identity";
import { requireInfra, testInfra } from "./test-infra";

/**
 * Starts a real Core identity authority (identity routes, OAuth issuance, process
 * Sync) for test files that exercise sessions, tokens, or access against it.
 * Import it from those files after `test-infra`; without configured database and
 * NATS targets it does nothing, so the same files stay green in unit runs.
 */
type Routes = ReturnType<typeof createIdentityPublicRoutes>;
type IssuanceModule = { createIdentityOAuthIssuanceRoutes: () => Routes };
type OAuthModule = { default: Routes };

if (testInfra.database && testInfra.nats) {
  await requireInfra("database", "nats");
  // Loaded through computed specifiers so a test in one package does not pull the
  // Core and OAuth programs into that package's typecheck.
  const issuancePath = "../../packages/core/src/api/identity-oauth-issuance";
  const oauthPath = "../../packages/oauth/src/oauth";
  const { createIdentityOAuthIssuanceRoutes } = (await import(issuancePath)) as IssuanceModule;
  const { default: oauthRoutes } = (await import(oauthPath)) as OAuthModule;
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
}
