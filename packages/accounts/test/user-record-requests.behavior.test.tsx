import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

// The deeds of a user's record against the API: each targets the person's own entry, and a refusal carries the
// server's message or the deed's own sentence. The question before each deed and the page shown again after it are
// covered by `users/detail/user-screen.browser.test.ts`.
const requests: Array<{ kind: string; param: Record<string, string>; json?: unknown }> = [];
let answers: Response[] = [];
const answer = (kind: string) => async (input: { param: Record<string, string>; json?: unknown }) => {
  requests.push({ kind, ...input });
  return answers.shift() ?? Response.json({ message: "ok" });
};
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      users: {
        ":id": { devices: { ":deviceId": { $delete: answer("device") } }, "app-devices": { ":deviceId": { $delete: answer("app") } } },
      },
      "service-accounts": { credentials: { ":id": { $delete: answer("key") } } },
      groups: { ":id": { members: { $delete: answer("remove"), $post: answer("add") } } },
    },
  }));
  mock.module("../src/frontend/action-notice", () => ({ showAccountActionNotice: async () => {} }));
}

describe("revoking and removing on a user's record", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let dom: ReturnType<typeof createDomTestHarness>;
  beforeEach(() => {
    dom = createDomTestHarness();
  });
  afterEach(() => {
    dom.cleanup();
    requests.length = 0;
    answers = [];
  });
  const load = async () => {
    const [requestsModule, { accountsMessages }] = await Promise.all([
      import("../src/frontend/users/detail/user-requests"),
      import("../src/frontend/messages"),
    ]);
    return { ...requestsModule, t: accountsMessages.resolve(["en"]).t };
  };

  test("a sign-in device is revoked for its person; a refusal says the server's words, a proxy page the fallback", async () => {
    const { revokeSignInDevice, t } = await load();
    answers = [
      Response.json({ message: "Admin access required" }, { status: 403 }),
      new Response("Bad gateway", { status: 502, headers: { "content-type": "text/plain" } }),
    ];
    await expect(revokeSignInDevice("user-id", "device-id", t)).rejects.toThrow("Admin access required");
    await expect(revokeSignInDevice("user-id", "device-id", t)).rejects.toThrow("The device could not be revoked.");
    await revokeSignInDevice("user-id", "device-id", t);
    expect(requests.map((entry) => entry.param)).toEqual(Array(3).fill({ id: "user-id", deviceId: "device-id" }));
  });

  test("a phone already removed counts as removed; a failure gets the removal's own sentence", async () => {
    const { removeAppDevice, t } = await load();
    answers = [new Response("Bad gateway", { status: 502, headers: { "content-type": "text/plain" } }), Response.json({ revoked: false })];
    await expect(removeAppDevice("user-id", "phone-id", t)).rejects.toThrow("The device could not be removed.");
    await removeAppDevice("user-id", "phone-id", t);
    expect(requests).toEqual([
      { kind: "app", param: { id: "user-id", deviceId: "phone-id" } },
      { kind: "app", param: { id: "user-id", deviceId: "phone-id" } },
    ]);
  });

  test("an API key is revoked by its id, and memberships change for this person only", async () => {
    const { revokeApiKey, removeMembership, addMembership, t } = await load();
    await revokeApiKey("key-id", t);
    await removeMembership("group-a", "user-id", t);
    await addMembership("group-b", "user-id", t);
    expect(requests).toEqual([
      { kind: "key", param: { id: "key-id" } },
      { kind: "remove", param: { id: "group-a" }, json: { type: "user", id: "user-id" } },
      { kind: "add", param: { id: "group-b" }, json: { type: "user", id: "user-id" } },
    ]);
    answers = [new Response(null, { status: 500 })];
    await expect(revokeApiKey("key-id", t)).rejects.toThrow(t.revokeApiKeyFailed);
  });
});
