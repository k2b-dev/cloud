import { describe, expect, test } from "bun:test";
import { collectConversationResourceObservations, isConversationResourceCursor } from "./resource-refs";

describe("collectConversationResourceObservations", () => {
  test("collects and deduplicates only structured resource refs", () => {
    expect(
      collectConversationResourceObservations(
        { query: "look at notebooks.note/nT1234 and contacts.contact/cT1234" },
        {
          refs: [
            {
              type: "contacts.contact",
              id: "cT1234",
              title: "Ada Lovelace",
              preview: "Analytical Engines Ltd.",
              icon: "ti ti-user",
            },
          ],
          data: [
            { type: "notebooks.note", id: "nT1234" },
            {
              ref: { type: "notebooks.note", id: "nT1234" },
              title: "Release notes",
              preview: "Current plan",
              icon: "ti ti-note",
              links: [{ rel: "open", href: "/app/notebooks/nB1234/nT1234" }],
            },
            { ref: { type: "contacts.contact", id: "cT1234" } },
          ],
        },
      ),
    ).toEqual([
      {
        ref: { type: "contacts.contact", id: "cT1234" },
        title: "Ada Lovelace",
        preview: "Analytical Engines Ltd.",
        icon: "ti ti-user",
      },
      {
        ref: { type: "notebooks.note", id: "nT1234" },
        title: "Release notes",
        preview: "Current plan",
        icon: "ti ti-note",
        href: "/app/notebooks/nB1234/nT1234",
      },
    ]);
  });

  test("ignores malformed objects and resource-looking prose", () => {
    expect(
      collectConversationResourceObservations(
        "notebooks.note/nT1234",
        { type: "notebooks.note" },
        { type: "notebooks.note", id: "" },
        { ref: { type: "", id: "nT1234" } },
      ),
    ).toEqual([]);
  });
});

test("validates opaque resource cursors before they reach PostgreSQL", () => {
  const local = encodeURIComponent(JSON.stringify({ at: new Date().toISOString(), type: "mail.message", id: "eM1234" }));
  const user = encodeURIComponent(JSON.stringify({ at: new Date().toISOString(), type: "mail.message", id: "eM1234", chat: "cHt234" }));
  expect(isConversationResourceCursor(local, "conversation")).toBe(true);
  expect(isConversationResourceCursor(local, "user")).toBe(false);
  expect(isConversationResourceCursor(user, "conversation")).toBe(false);
  expect(isConversationResourceCursor(user, "user")).toBe(true);
  expect(
    isConversationResourceCursor(
      encodeURIComponent(JSON.stringify({ at: "not-a-date", type: "mail.message", id: "eM1234" })),
      "conversation",
    ),
  ).toBe(false);
  expect(isConversationResourceCursor("not-json", "conversation")).toBe(false);
});
