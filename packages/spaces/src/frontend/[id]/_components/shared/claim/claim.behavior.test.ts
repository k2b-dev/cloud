import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import type { SpaceItemClaim } from "@/contracts";
import { createDomTestHarness } from "../../../../../../../ui/test/dom";

// The prompts and their components load against a document.
const dom = createDomTestHarness();
afterAll(() => dom.cleanup());
const { prompts } = await import("@k2b/ui");
const { spaceMessages } = await import("../../../messages");
const { resolveAssigneeClaim } = await import("./claim");

const me = "33333333-3333-4333-8333-333333333333";
const jana = "44444444-4444-4444-8444-444444444444";
const kim = "66666666-6666-4666-8666-666666666666";
const claimOf = (actor: SpaceItemClaim["actor"], displayName: string): SpaceItemClaim => ({
  id: "55555555-5555-4555-8555-555555555555",
  actor,
  displayName,
  avatarHash: null,
  claimedAt: "2026-09-26T08:00:00.000Z",
});
const t = spaceMessages.resolve(["en"]).t;
const confirm = spyOn(prompts, "confirm");
afterEach(() => confirm.mockReset());

test("a list that keeps the person working on the task needs no claim fields and asks nothing", async () => {
  expect(await resolveAssigneeClaim(null, me, [], t)).toEqual({});
  expect(await resolveAssigneeClaim(claimOf({ kind: "user", id: jana }, "Jana Berger"), me, [jana, kim], t)).toEqual({});
  // Service accounts are never assignees, so no list drops them.
  expect(await resolveAssigneeClaim(claimOf({ kind: "service_account", id: jana }, "Task worker"), me, [], t)).toEqual({});
  expect(confirm).not.toHaveBeenCalled();
});

test("removing yourself ends your own claim without a question", async () => {
  const claim = claimOf({ kind: "user", id: me }, "Valentin Kolb");
  expect(await resolveAssigneeClaim(claim, me, [kim], t)).toEqual({ claimId: claim.id });
  expect(confirm).not.toHaveBeenCalled();
});

test("removing someone else who works on the task asks once and then ends their exact claim; cancel changes nothing", async () => {
  const claim = claimOf({ kind: "user", id: jana }, "Jana Berger");
  confirm.mockResolvedValueOnce(true);
  expect(await resolveAssigneeClaim(claim, me, [kim], t)).toEqual({ claimId: claim.id, force: true });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0]?.[0]).toBe("Jana Berger is working on this – remove them and end their claim?");
  expect(confirm.mock.calls[0]?.[1]).toMatchObject({ title: "Remove assignee", confirmText: "Remove and end claim" });

  confirm.mockResolvedValueOnce(false);
  expect(await resolveAssigneeClaim(claim, me, [], t)).toBeNull();
});

test("the confirmation speaks German for a German person", async () => {
  confirm.mockResolvedValueOnce(false);
  await resolveAssigneeClaim(claimOf({ kind: "user", id: jana }, "Jana Berger"), me, [], spaceMessages.resolve(["de"]).t);
  expect(confirm.mock.calls[0]?.[0]).toBe("Jana Berger arbeitet daran – entfernen und die Übernahme beenden?");
});
