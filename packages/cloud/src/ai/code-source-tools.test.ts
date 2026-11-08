import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import * as registry from "../_internal/registry";
import * as claims from "../capabilities/claims";
import type { User } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { signInvocationToken } from "../services/identity/invocation-token";
import * as issuer from "../services/identity/issue-invocation";
import * as identity from "../services/identity/key-ring";
import * as execution from "./capability-execution";
import { CODE_SOURCE_TOOLS } from "./code-source-contracts";
import { createCodeSourceTool } from "./code-source-tools";

useUnitClients();

// Broker authorization is covered at its own seam; these tests exercise host protocol and retries.
beforeEach(() => {
  spyOn(issuer, "issueInvocationToken").mockImplementation(signInvocationToken);
});

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "test",
  roles: [],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "User",
  displayName: "Test User",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
afterEach(() => mock.restore());

for (const name of ["code_file_copy"] as const)
  for (const approved of [false, true])
    test(`${name} ${approved ? "approval" : "denial"} gates the actual write`, async () => {
      const actor = { kind: "user" as const, user, sessionKind: "app" as const };
      spyOn(execution, "resolveAiCapabilityActor").mockResolvedValue({
        actor,
        accessSubject: { type: "user", userId: user.id },
        credentialKind: "session",
        scopes: [],
      });
      spyOn(registry, "getApp").mockResolvedValue({
        id: "assistant",
        name: "Assistant",
        icon: "",
        description: "",
        baseUrl: "http://assistant.test",
        routes: [],
      });
      const keys = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      );
      spyOn(identity, "withActiveIdentitySigner").mockImplementation(async (_purpose, callback) =>
        callback(
          {
            kid: "test-key",
            key: keys.privateKey,
            signUntil: new Date(Date.now() + 60000),
            issuer: "https://cloud.test",
          },
          sql,
        ),
      );
      const claim = spyOn(claims, "claimCapabilityIdempotency").mockResolvedValue({ state: "claimed" });
      const complete = spyOn(claims, "completeCapabilityClaim").mockResolvedValue();
      const requests: unknown[] = [];
      const events: string[] = [];
      spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            requests.push(body);
            events.push(body.review ? "preview" : "write");
            return Response.json({
              ok: true,
              data: { data: body.review ? { message: "Copy input.csv into Project: no file → copy.csv" } : { changed: true } },
            });
          },
          { preconnect: fetch.preconnect },
        ),
      );
      const tool = createCodeSourceTool(name);
      if (tool.location !== "server") throw new Error("Expected server tool");
      const input = {
        source: { scope: "chat" as const, id: "chat-test", path: "/input.csv", version: "1" },
        destination: { scope: "project" as const, id: "project-test", path: "/copy.csv" },
        expectedVersion: null,
      };
      const operation = tool.run(input, {
        actor,
        conversationId: "chat-test",
        callId: "change-1",
        signal: new AbortController().signal,
        requestClientTool: async () => {
          throw new Error("Unexpected client tool");
        },
        requestApproval: async (message) => {
          expect(message).toContain("no file → copy.csv");
          events.push("approval");
          return approved;
        },
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
      const calls = spyOn(issuer, "issueInvocationToken").mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const [params] of calls) expect(params.authority).toMatchObject({ session_kind: "app", scopes: [] });
    });

test("source discovery retains chat and Project files and rejects retired app scopes", () => {
  expect(Object.keys(CODE_SOURCE_TOOLS)).toEqual(["code_files", "code_file_stat", "code_file_copy"]);
  expect(CODE_SOURCE_TOOLS.code_file_stat.input.safeParse({ file: { scope: "app", id: "AbC234", path: "x" } }).success).toBe(false);
});
