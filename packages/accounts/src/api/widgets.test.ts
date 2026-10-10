import { describe, expect, test } from "bun:test";
import { adminQueueWidgetBody } from "./widgets";

const summary = (overrides: Partial<Parameters<typeof adminQueueWidgetBody>[0]> = {}) =>
  ({
    openRequests: 0,
    ipaExpiring30d: 0,
    localUserExpiring30d: 0,
    localGuestExpiring30d: 0,
    ipaAccountsTotal: 40,
    localAccountsTotal: 2,
    groupsTotal: 7,
    ...overrides,
  }) as Parameters<typeof adminQueueWidgetBody>[0];

describe("admin queue widget", () => {
  test("shows what needs action first in the small frame, without totals", () => {
    expect(adminQueueWidgetBody(summary({ openRequests: 3, ipaExpiring30d: 2 }), "small", "en").blocks.map((block) => block.kind)).toEqual([
      "stat",
    ]);
    expect(adminQueueWidgetBody(summary({ ipaExpiring30d: 2 }), "small", "de").blocks).toMatchObject([
      { kind: "status", title: "2 Konten laufen innerhalb von 30 Tagen ab" },
    ]);
    expect(adminQueueWidgetBody(summary(), "small", "en").blocks).toEqual([
      { kind: "hero", icon: "ti ti-circle-check", tone: "emerald", title: "All clear", subtitle: undefined },
    ]);
  });

  test("adds the totals in medium and every detail in large", () => {
    expect(adminQueueWidgetBody(summary({ openRequests: 1, ipaExpiring30d: 2 }), "medium", "en").blocks.map((block) => block.kind)).toEqual(
      ["stat", "pills"],
    );
    const large = adminQueueWidgetBody(summary({ openRequests: 1, ipaExpiring30d: 2 }), "large", "en");
    expect(large.blocks.map((block) => block.kind)).toEqual(["stat", "status", "pills"]);
    expect(large.blocks[1]).toMatchObject({ message: "2 FreeIPA · 0 local · 0 guest" });
    expect(adminQueueWidgetBody(summary(), "large", "en").blocks[0]).toMatchObject({
      subtitle: "No pending requests and no credentials are about to expire",
    });
  });
});
