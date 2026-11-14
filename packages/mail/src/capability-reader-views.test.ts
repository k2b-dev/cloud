import { expect, test } from "bun:test";
import { validateBlocks } from "@k2b/cloud/blocks";
import { conversationReaderView, messageReaderView, READER_VIEW_TEXT_BYTES } from "./capability-reader-views";

const ruth = { name: "Ruth Albers", address: "r.albers@example.org" };
const lea = { name: null, address: "lea@example.org" };
const check = (view: ReturnType<typeof messageReaderView>) =>
  validateBlocks(view.blocks, "preview", { appId: "mail", appPrefixes: ["/app/mail", "/api/mail"], envelope: { data: {} } });

for (const [locale, from, date, more] of [
  ["de", "Von", "Datum", "Gekürzt."],
  ["en", "From", "Date", "Shortened."],
] as const)
  test(`a message preview shows its people, date, attachments and the whole text in ${locale}`, () => {
    const view = messageReaderView({
      locale,
      timeZone: "Europe/Berlin",
      from: [ruth],
      to: [lea],
      cc: [],
      sentAt: "2026-11-13T09:12:00Z",
      internalDate: "2026-11-13T09:12:05Z",
      attachments: [{ filename: "Vase_Albers_Boden.jpg" }],
      text: "Guten Tag,\n\nanbei das Foto der Vase.\n\nViele Grüße\nRuth Albers",
      textTruncated: false,
    });
    check(view);
    const [detail, text, ...rest] = view.blocks;
    expect(detail).toMatchObject({
      kind: "Detail",
      items: [{ label: from, value: "Ruth Albers <r.albers@example.org>" }, {}, { label: date }, {}],
    });
    expect(JSON.stringify(detail)).toContain("10:12");
    expect(text).toEqual({ kind: "Text", text: "Guten Tag,\n\nanbei das Foto der Vase.\n\nViele Grüße\nRuth Albers" });
    expect(rest).toEqual([]);
    const long = messageReaderView({
      ...{ locale, timeZone: "UTC", from: [ruth], to: [], cc: [], sentAt: null },
      internalDate: "2026-11-13T09:12:05Z",
      attachments: [],
      text: "ä".repeat(READER_VIEW_TEXT_BYTES),
      textTruncated: false,
    });
    check(long);
    const bounded = long.blocks[1];
    expect(bounded?.kind === "Text" && new TextEncoder().encode(bounded.text).byteLength).toBeLessThanOrEqual(READER_VIEW_TEXT_BYTES);
    expect(JSON.stringify(long.blocks[2])).toContain(more);
  });

test("a message without loaded text says so instead of showing nothing", () => {
  const view = messageReaderView({
    locale: "de",
    timeZone: "UTC",
    from: [ruth],
    to: [lea],
    cc: [lea],
    sentAt: null,
    internalDate: "2026-11-13T09:12:05Z",
    attachments: [],
    text: null,
    textTruncated: false,
  });
  check(view);
  expect(view.blocks.map((block) => block.kind)).toEqual(["Detail", "Notice"]);
  expect(JSON.stringify(view.blocks[0])).toContain("Cc");
});

test("a conversation preview shows its state, summary and latest messages", () => {
  const view = conversationReaderView({
    locale: "de",
    timeZone: "Europe/Berlin",
    summary: "Ruth Albers bietet eine Jugendstil-Vase an.",
    workStatus: "needs_action",
    assignees: [{ displayName: "Tim Brandt" }],
    tags: [{ name: "Ankauf" }],
    messages: [
      {
        from: [ruth],
        subject: "Nachlass – Vase",
        sentAt: "2026-11-13T09:12:00Z",
        internalDate: "2026-11-13T09:12:00Z",
        preview: "Anbei das Foto",
      },
    ],
    more: true,
  });
  check(view);
  expect(view.blocks.map((block) => block.kind)).toEqual(["Detail", "Section", "Table"]);
  expect(JSON.stringify(view)).toContain("Zu bearbeiten");
  expect(view.blocks[2]).toMatchObject({ subtitle: "Weitere in Mail", rows: [{ from: "Ruth Albers", subject: "Anbei das Foto" }] });
});
