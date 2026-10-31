import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { generateKeyPair } from "jose";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import * as registry from "../_internal/registry";
import type { EnvSettingStatus } from "../contracts/settings-env";
import { sql } from "../runtime/clients";
import * as gateways from "../services/gateway";
import { signInvocationToken } from "../services/identity/invocation-token";
import * as issuer from "../services/identity/issue-invocation";
import * as keyRing from "../services/identity/key-ring";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import * as diagnostics from "../services/settings/env-status";
import { adminSettingsEnvRoutes } from "./admin-settings-env";
import { settingsInvocationOperation } from "./settings-ops";

useUnitClients();

const now = Date.parse("2026-10-30T01:00:00Z");
const row: EnvSettingStatus = {
  key: "gotenberg.url",
  envVariable: "GOTENBERG_URL",
  storedValuePresent: true,
  envValuePresent: false,
  conflict: "none",
  unreadableStoredValue: false,
  invalidEnvValue: false,
  needsAttention: false,
};
const user = buildProjectedUser({ id: "00000000-0000-4000-8000-000000000003", provider: "local", profile: "user", effective_admin: true });
beforeEach(() => {
  spyOn(Date, "now").mockReturnValue(now);
  spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2026-10-31T00:00:00Z" },
  });
  spyOn(registry, "listApps").mockResolvedValue([]);
  spyOn(diagnostics, "readEnvSettingsStatus").mockResolvedValue([row]);
  spyOn(gateways, "listGatewayRouteSnapshots").mockResolvedValue([
    {
      instanceId: "gateway-one",
      baseUrl: "http://gateway:3000",
      startedAt: now,
      updatedAt: now,
      tableVersion: 1,
      tableBuiltAt: now,
      routeCount: 0,
      routeHash: "hash",
      routeWarnings: [],
      routes: [],
      stats: { totalRequests: 0, noRouteCount: 0, byApp: [], byRoute: [] },
      envSettings: [row],
    },
  ]);
});
afterEach(() => mock.restore());
const read = () => adminSettingsEnvRoutes.request("/status", { headers: { cookie: "session_token=test" } });

test("status requires an administrator before touching stored settings", async () => {
  spyOn(session, "authenticateRequest").mockResolvedValue(null);
  const response = await read();
  expect(response.status).toBe(401);
  expect(diagnostics.readEnvSettingsStatus).not.toHaveBeenCalled();
});
test("healthy gateway and Core diagnostics need no attention and return no values", async () => {
  const response = await read();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    needsAttention: false,
    processes: [
      { appId: "core", status: "ok", settings: [row] },
      { appId: "gateway", instanceId: "gateway-one", sampledAt: now, status: "ok", settings: [row] },
    ],
  });
});
test("a missing gateway snapshot never reports a healthy migration", async () => {
  spyOn(gateways, "listGatewayRouteSnapshots").mockResolvedValue([]);
  expect(await (await read()).json()).toMatchObject({
    needsAttention: true,
    processes: [{ appId: "core" }, { appId: "gateway", status: "unavailable" }],
  });
});
test("application checks use operation-bound invocations and sanitize remote fields", async () => {
  spyOn(registry, "listApps").mockResolvedValue([
    { id: "mail", name: "Mail", description: "", icon: "mail", baseUrl: "http://mail:3000", routes: [] },
  ]);
  const key = (await generateKeyPair("RS256")).privateKey;
  spyOn(keyRing, "withActiveIdentitySigner").mockImplementation(async (_purpose, callback) =>
    callback({ kid: "33333333-3333-4333-8333-333333333333", key, issuer: "https://cloud.test", signUntil: new Date(now + 60_000) }, sql),
  );
  const sign = spyOn(issuer, "issueInvocationToken").mockImplementation((params) =>
    signInvocationToken({ ...params, issuedAt: new Date(now), jti: "22222222-2222-4222-8222-222222222222" }),
  );
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
        const request = new Request(input, init);
        expect(request.url).toBe("http://mail:3000/_internal/settings/env");
        expect(request.headers.get("cookie")).toBeNull();
        expect(request.headers.get("authorization")).toStartWith("Bearer ");
        return Response.json({ settings: [{ ...row, conflict: "differs", needsAttention: true, value: "must-never-leak" }] });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const response = await read();
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({
    needsAttention: true,
    processes: [{ appId: "core" }, { appId: "mail", status: "ok" }, { appId: "gateway" }],
  });
  expect(text).not.toContain("must-never-leak");
  expect(sign.mock.calls[0]?.[0]).toMatchObject({
    targetAppId: "mail",
    callingAppId: "core",
    operation: settingsInvocationOperation("GET", "env"),
  });
  fetch.mockResolvedValue(Response.json({ message: "older app" }, { status: 404 }));
  expect(await (await read()).json()).toMatchObject({
    needsAttention: true,
    processes: [{ appId: "core" }, { appId: "mail", status: "unavailable", settings: [] }, { appId: "gateway" }],
  });
});
