import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicRecordHistoryEntry } from "../../../api/public-audit";
import type { PublicField } from "../../../api/public-dto";
import "../ssr-test-plugin";

const { RecordHistoryList } = await import("./RecordHistorySection");

// Thursday, 12 Nov 2026, 15:31 UTC; the record's events happened earlier that day.
const NOW = "2026-11-12T15:31:00.000Z";
beforeAll(() => setSystemTime(new Date(NOW)));
afterAll(() => setSystemTime());

const status = { id: "Fld001", name: "Status" } as PublicField;
const entry = (overrides: Partial<PublicRecordHistoryEntry>): PublicRecordHistoryEntry => ({
  id: crypto.randomUUID(),
  baseId: "Base01",
  tableId: "Tbl001",
  recordId: "Rec001",
  userId: "11111111-1111-4111-8111-111111111111",
  action: "updated",
  diff: null,
  ip: null,
  userAgent: null,
  createdAt: "2026-11-12T14:00:00.000Z",
  userDisplayName: "Mira Lang",
  userAvatarHash: null,
  context: null,
  ...overrides,
});
const history = [
  entry({ action: "finalized", userDisplayName: null, createdAt: "2026-11-12T15:00:00.000Z" }),
  entry({ diff: { Fld001: { old: "Open", new: "Done" } } }),
  entry({ action: "created", userId: null, userDisplayName: null, createdAt: "2026-11-12T09:00:00.000Z" }),
];

const render = (props: Partial<Parameters<typeof RecordHistoryList>[0]> = {}) =>
  renderToString(() =>
    createComponent(RecordHistoryList, { entries: history, fields: [status], dateConfig: { locale: "en", timeZone: "UTC" }, ...props }),
  );
// The rendered text as a parser reads it: text nodes only, without tags or hydration comments.
const textOf = (html: string) => {
  let plain = "";
  new HTMLRewriter()
    .onDocument({
      text(chunk) {
        plain += chunk.text;
      },
    })
    .transform(html);
  return plain.replace(/\s+/g, " ");
};

describe("Record history", () => {
  test("reads as the shared timeline: what happened, which fields changed, and who did it", () => {
    const html = render();
    expect(html).toContain('class="k2b-activity"');
    expect(html.match(/class="k2b-activity__entry ?"/g)).toHaveLength(3);
    const plain = textOf(html);
    expect(plain).toContain("Updated");
    expect(plain).toContain("Changed: Status");
    expect(plain).toContain("14:00 · 1 hr. ago · Mira Lang");
    // Without a person: the system or an anonymous actor; a deleted account keeps its own words.
    expect(plain).toContain("09:00 · 6 hr. ago · System or anonymous");
    expect(plain).toContain("15:00 · 31 min. ago · Deleted user");
    // One fixed icon per action; only a finalized record carries a tone.
    expect(html).toContain('<i class="ti ti-pencil"');
    expect(html).toContain('data-tone="success"');
    // The before and after of a field fold out from its row and are not rendered until then.
    expect(html).toMatch(/<button type="button" class="k2b-activity__text-button" aria-expanded="false"/);
    expect(plain).not.toContain("Open → Done");
  });

  test("offers Open record only where the caller may open records", () => {
    expect(textOf(render())).not.toContain("Open record");
    const opening = render({ onOpenRecord: () => {}, density: "wide", more: true });
    expect(opening.match(/class="k2b-activity__action"/g)).toHaveLength(3);
    expect(textOf(opening)).toContain("Open record");
    expect(opening).toContain('data-density="wide"');
    expect(opening).toContain('data-end="more"');
    const withoutRecord = render({ onOpenRecord: () => {}, entries: [entry({ recordId: null })] });
    expect(withoutRecord).not.toContain("k2b-activity__action");
  });

  test("an empty history says so in one sentence", () => {
    const html = render({ entries: [] });
    expect(textOf(html)).toContain("No history yet.");
    expect(html).not.toContain('class="k2b-activity"');
  });
});
