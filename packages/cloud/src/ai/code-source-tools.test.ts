import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { sql } from "bun";
import type { User } from "../contracts/shared";
import * as registry from "../_internal/registry";
import * as identity from "../services/identity/key-ring";
import * as execution from "./capability-execution";
import * as claims from "../capabilities/claims";
import { createCodeSourceTool } from "./code-source-tools";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111", uid: "test", roles: [], provider: "local", profile: "user",
  givenname: "Test", sn: "User", displayName: "Test User", mail: null, avatarHash: null, ipa: null,
  accountExpires: null, lastLoginLocal: null, memberofGroup: [], memberofGroupIds: [], manages: [], managesGroupIds: [],
};
afterEach(() => mock.restore());

for (const name of ["code_access_change", "code_write"] as const) for (const approved of [false, true]) test(`${name} ${approved ? "approval" : "denial"} gates the actual write`, async () => {
  const actor = { kind: "user" as const, user };
  spyOn(execution, "resolveAiCapabilityActor").mockResolvedValue({ actor, accessSubject: { type: "user", userId: user.id } });
  spyOn(registry, "getApp").mockResolvedValue({ id: "assistant", name: "Assistant", icon: "", description: "", baseUrl: "http://assistant.test", routes: [] });
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  spyOn(identity, "withActiveIdentitySigner").mockImplementation(async (_purpose, callback) => callback({
    kid: "test-key", key: keys.privateKey, signUntil: new Date(Date.now() + 60000), issuer: "https://cloud.test",
  }, sql));
  const claim = spyOn(claims, "claimCapabilityIdempotency").mockResolvedValue({ state: "claimed" });
  const complete = spyOn(claims, "completeCapabilityClaim").mockResolvedValue();
  const requests: unknown[] = [];
  const events: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    events.push(body.review ? "preview" : "write");
    return Response.json({ ok: true, data: { data: body.review ? { message: "Share App AbC234 with Test User: none → read" } : { changed: true } } });
  }, { preconnect: fetch.preconnect }));
  const tool = createCodeSourceTool(name);
  if (tool.location !== "server") throw new Error("Expected server tool");
  const input = name === "code_write" ? { id: "AbC234", expectedRevision: 1, files: [{ path: "data.json", fromFile: { scope: "app" as const, id: "AbC345", path: "data.json", version: "1" } }] } : { id: "AbC234", expectedAccessRevision: "a".repeat(64), principal: { type: "user" as const, userId: user.id }, permission: "read" as const };
  const operation = tool.run(input, {
    actor, conversationId: "chat-test", callId: "change-1", signal: new AbortController().signal,
    requestClientTool: async () => { throw new Error("Unexpected client tool"); },
    requestApproval: async message => { expect(message).toContain("none → read"); events.push("approval"); return approved; },
  });
  if (approved) {
    expect(await operation).toEqual({ data: { changed: true } });
    expect(events).toEqual(["preview", "approval", "write"]);
    expect(requests[1]).toEqual({ input, conversationId: "chat-test" });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  } else {
    await expect(operation).rejects.toThrow("No mutation was sent");
    expect(events).toEqual(["preview", "approval"]);
    expect(claim).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  }
});
