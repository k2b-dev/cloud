import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { appStatusIssues, type CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { adminAuthority } from "../../../scripts/fixtures/app-status";
import { forgetGatewayAppStatus, readGatewayAppStatusDetail, readGatewayAppStatusSummary } from "./app-status";
import { gatewayOpsCapabilities } from "./capabilities";

const context = (): CapabilityExecutionContext => {
  const authority = adminAuthority();
  return {
    authority,
    actor: authority.actor,
    accessSubject: authority.accessSubject,
    user: authority.actor.kind === "user" ? authority.actor.user : null,
    requestId: "test",
    locale: "de",
    origin: "app",
    signal: new AbortController().signal,
  };
};
test("Gateway implements the same public app-status contract as third-party providers", () => {
  const manifest = compileCapabilityManifest("monitor", gatewayOpsCapabilities);
  expect(appStatusIssues(manifest)).toEqual([]);
  expect(manifest.actions.find((action) => action.localId === "app-status.forget")?.code).toBe(false);
  expect(manifest.appStatus).toEqual({ summary: "app-status.summary", detail: "app-status.detail", forget: "app-status.forget" });
});
test("all Gateway operations reject missing or non-admin authority before reading data", async () => {
  const missing = { ...context(), authority: undefined };
  const denied = context();
  if (denied.authority?.actor.kind === "user") denied.authority.actor.user.roles = [];
  for (const caller of [missing, denied]) {
    expect((await readGatewayAppStatusSummary({ appIds: ["mail"], window: "24h" }, caller)).ok).toBe(false);
    expect((await readGatewayAppStatusDetail({ appId: "mail", window: "24h" }, caller)).ok).toBe(false);
    expect((await forgetGatewayAppStatus({ appId: "mail" }, caller)).ok).toBe(false);
  }
});
test("Gateway forget rejects an administrator's read-only OAuth authority", async () => {
  const caller = context();
  if (!caller.authority) throw new Error("Missing fixture authority");
  caller.authority.credentialKind = "oauth";
  caller.authority.scopes = ["read"];
  expect((await forgetGatewayAppStatus({ appId: "mail" }, caller)).ok).toBe(false);
  caller.authority.credentialKind = "invocation";
  caller.authority.actor.delegation = { kind: "invocation", callingAppId: "core", credentialKind: "oauth", invocationId: "test" };
  expect((await forgetGatewayAppStatus({ appId: "mail" }, caller)).ok).toBe(false);
});
