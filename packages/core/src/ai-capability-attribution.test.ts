import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { RequestActor } from "@k2b/cloud/server";
import { nestedInvocationLeases } from "@k2b/cloud/services/identity";
import { aiCapabilityTurnAttribution } from "./ai-capability-attribution";

const actor: Extract<RequestActor, { kind: "user" }> = {
  kind: "user",
  user: {
    id: "5a000000-0000-4000-8000-000000000001",
    uid: "budget-owner",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Budget",
    sn: "Owner",
    displayName: "Budget Owner",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  },
  delegation: { kind: "invocation", credentialKind: "session", callingAppId: "core", invocationId: "fixture" },
};
afterEach(() => mock.restore());
test("Gustav and code_run inference keep the framework source turn", async () => {
  const assistantTurn = { conversationId: "5a000000-0000-4000-8000-000000000002", turnId: "5a000000-0000-4000-8000-000000000003" };
  spyOn(nestedInvocationLeases, "read").mockResolvedValue({ appId: "core", deadline: 1794744000000, origin: "assistant", assistantTurn });
  expect(await aiCapabilityTurnAttribution({ actor, origin: "assistant" })).toEqual(assistantTurn);
});
test("an expired invocation cannot drop attribution and escape a turn allowance", async () => {
  spyOn(nestedInvocationLeases, "read").mockResolvedValue(null);
  await expect(aiCapabilityTurnAttribution({ actor, origin: "assistant" })).rejects.toThrow("lease");
});
test("ordinary requests and independently budgeted stored Code do not read a source-turn lease", async () => {
  const read = spyOn(nestedInvocationLeases, "read").mockResolvedValue(null);
  expect(await aiCapabilityTurnAttribution({ actor: { kind: "user", user: actor.user }, origin: "http" })).toBeUndefined();
  expect(
    await aiCapabilityTurnAttribution({
      actor: { ...actor, delegation: { ...actor.delegation!, credentialKind: "mandate" } },
      origin: "http",
    }),
  ).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

test("a missing optional lease preserves ordinary browser and app AI calls", async () => {
  spyOn(nestedInvocationLeases, "read").mockResolvedValue(null);
  for (const origin of ["http", "app"] as const) expect(await aiCapabilityTurnAttribution({ actor, origin })).toBeUndefined();
  await expect(aiCapabilityTurnAttribution({ actor, origin: "choice" })).rejects.toThrow("lease");
});
