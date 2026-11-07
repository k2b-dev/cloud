import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { assertAdminReadAuthorization, assertAdminWriteAuthorization } from "../../../../scripts/fixtures/admin-read";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import * as registry from "../_internal/registry";
import { appDomains } from "../services/app-domains";
import { appEventBroker } from "../services/app-events";
import * as gateway from "../services/gateway";
import * as catalog from "../services/settings/admin-catalog";
import * as diagnostics from "../services/settings/env-status";
import { createAdminAppDomainRoutes } from "./admin-app-domains";
import { adminSettingsEnvRoutes } from "./admin-settings-env";
import { createAppEventRoutes } from "./app-events";
import { createSyncOpsProxyRoutes } from "./sync-ops";

useUnitClients();
afterEach(() => mock.restore());

test("settings diagnostics accept ordinary admin login and recheck the person on every request", async () => {
  const read = spyOn(diagnostics, "readEnvSettingsStatus").mockResolvedValue([]);
  spyOn(gateway, "listGatewayRouteSnapshots").mockResolvedValue([]);
  spyOn(registry, "listApps").mockResolvedValue([]);
  await assertAdminReadAuthorization(
    (headers) => adminSettingsEnvRoutes.request("/status", { headers }),
    () => read.mock.calls.length,
  );
});
test("app events accept ordinary admin reads without admitting other OAuth principals", async () => {
  const read = spyOn(appEventBroker, "status").mockRejectedValue(new Error("fixture reader"));
  const routes = createAppEventRoutes().onError((_error, c) => c.json({ fixture: true }, 503));
  await assertAdminReadAuthorization(
    (headers) => routes.request("/status", { headers }),
    () => read.mock.calls.length,
  );
});
test("Core Sync reads use the live administrator role before looking up any target", async () => {
  let reads = 0;
  const routes = createSyncOpsProxyRoutes({
    listApps: async () => {
      reads++;
      return [];
    },
  });
  await assertAdminReadAuthorization(
    (headers) => routes.request("/", { headers }),
    () => reads,
  );
  expect(reads).toBe(3);
});

test("the value-free setting catalog uses read plus the live administrator role", async () => {
  const read = spyOn(catalog, "readAdminSettingsCatalog").mockResolvedValue([]);
  await assertAdminReadAuthorization(
    (headers) => adminSettingsEnvRoutes.request("/catalog", { headers }),
    () => read.mock.calls.length,
  );
});

test("application setting writes require write and the current person role before selecting a target", async () => {
  const target = spyOn(registry, "getApp").mockResolvedValue(null);
  await assertAdminWriteAuthorization(
    (headers) =>
      adminSettingsEnvRoutes.request("/demo/test.setting", {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: '{"value":true}',
      }),
    () => target.mock.calls.length,
  );
});

test("domain configuration accepts normal write-scoped administrators and denies other principals", async () => {
  const update = spyOn(appDomains, "set").mockResolvedValue({
    ok: true,
    data: { host: "site.example.test", redirectTo: null, active: true, status: null, createdAt: "2026-01-01T00:00:00Z" },
  });
  const routes = createAdminAppDomainRoutes();
  await assertAdminWriteAuthorization(
    (headers) =>
      routes.request("/demo/domains/site.example.test", {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: '{"redirectTo":null}',
      }),
    () => update.mock.calls.length,
  );
});
