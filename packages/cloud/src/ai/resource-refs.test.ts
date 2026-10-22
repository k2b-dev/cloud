import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { cloudResourceHref, defineCapabilities } from "../contracts/capabilities";
import { addCloudResourceHrefs, collectConversationResourceObservations, isConversationResourceCursor } from "./resource-refs";

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

test("observations accept only validated hrefs and otherwise keep strict reference parsing", () => {
  expect(
    collectConversationResourceObservations({
      refs: [
        { type: "mail.draft", id: "one", title: "Draft", href: "/open/mail.draft/~one" },
        { type: "mail.draft", id: "two", href: "https://foreign.example" },
        { type: "mail.draft", id: "three", href: "//foreign.example" },
        { type: "mail.draft", id: "four", href: "/open/mail.draft/~four", extra: true },
      ],
    }),
  ).toEqual([{ ref: { type: "mail.draft", id: "one" }, title: "Draft", href: "/open/mail.draft/~one" }]);
});

test("enriches only top-level refs with live readers, preserving existing hrefs and all data", () => {
  const manifest = compileCapabilities(
    "demo",
    defineCapabilities({
      protocolVersion: 2,
      types: { item: { title: "Item", description: "An item.", reader: "read" }, other: { title: "Other", description: "No reader." } },
      queries: {
        read: {
          title: "Read",
          description: "Read an item.",
          input: z.object({ id: z.string().describe("Stable resource id.") }).strict(),
          data: z.unknown(),
          openWorld: false,
          run: async () => ok({ data: {} }),
        },
      },
    }),
  ).manifest;
  const apps = [{ appId: "demo", manifest }];
  const data = { refs: [{ type: "demo.item", id: "nested" }] };
  const view = {
    ref: { type: "demo.item", id: "view" },
    title: "View",
    preview: "",
    icon: "ti ti-box",
    links: [{ rel: "open", href: "/view" }],
  };
  const existing = { type: "demo.item", id: "existing", href: "/existing" };
  const noReader = { type: "demo.other", id: "other" };
  const offline = { type: "offline.item", id: "offline" };
  const malformed = { type: "demo.item", id: "bad", extra: true };
  const illFormed = { type: "demo.item", id: "\ud800" };
  // A maximum-length id stays linked even when URL encoding expands it.
  const overlong = { type: "demo.item", id: "ü".repeat(512) };
  const result = {
    data,
    refs: [{ type: "demo.item", id: "a/b", title: "Item" }, existing, noReader, offline, malformed, overlong, illFormed],
    view,
  };
  const enriched: unknown = addCloudResourceHrefs(result, apps);
  expect(enriched).toEqual({
    ...result,
    refs: [
      { type: "demo.item", id: "a/b", title: "Item", href: "/open/demo.item/~a%2Fb" },
      existing,
      noReader,
      offline,
      malformed,
      { ...overlong, href: cloudResourceHref(overlong) },
      illFormed,
    ],
  });
  const absolute: unknown = addCloudResourceHrefs(result, apps, "https://cloud.example");
  expect(absolute).toEqual({
    ...result,
    refs: [
      { type: "demo.item", id: "a/b", title: "Item", href: "https://cloud.example/open/demo.item/~a%2Fb" },
      existing,
      noReader,
      offline,
      malformed,
      { ...overlong, href: new URL(cloudResourceHref(overlong), "https://cloud.example").href },
      illFormed,
    ],
  });
  expect(result.refs[0]).not.toHaveProperty("href");
  expect(addCloudResourceHrefs(view, apps)).toBe(view);
  expect(addCloudResourceHrefs(result, [])).toEqual(result);
});
