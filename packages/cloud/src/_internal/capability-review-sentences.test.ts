import { describe, expect, spyOn, test } from "bun:test";
import { CAPABILITY_ASK_REASONS, type CapabilitySlot } from "../contracts/capabilities";
import { reviewFixture } from "./capability-review.test-fixture";
import {
  capabilityAskReasonText,
  capabilityOutcomeSentence,
  capabilityReviewSentence,
  capabilitySentenceParts,
  capabilitySentenceText,
  checkCapabilitySentenceMessages,
} from "./capability-sentences";

for (const locale of ["de", "en"])
  describe(`typed sentence renderer ${locale}`, () => {
    const context = { locale, timeZone: "UTC" };
    const slots = {
      object: { kind: "object", title: "Report.pdf" },
      place: { kind: "place", title: "Team Ops" },
      person: { kind: "person", people: [{ name: "Lea", address: "lea@example.com" }] },
      time: { kind: "time", start: "2026-10-17", end: "2026-10-18", format: "date" },
      count: { kind: "count", value: 1, noun: locale === "de" ? { one: "Datei", other: "Dateien" } : { one: "file", other: "files" } },
      text: { kind: "text", value: "ready" },
    } satisfies Record<string, CapabilitySlot>;
    test("every slot kind has parts and plain text", () => {
      const text = "{object} {place} {person} {time} {count} {text}";
      const parts = capabilitySentenceParts(text, slots, context);
      expect(parts.filter((p) => p.kind === "chip")).toHaveLength(4);
      expect(
        parts
          .filter((p) => p.kind === "text")
          .map((p) => p.text)
          .join(""),
      ).toContain(locale === "de" ? "1 Datei" : "1 file");
      const plain = capabilitySentenceText(text, slots, context);
      expect(plain).toContain(locale === "de" ? "„Report.pdf“" : "“Report.pdf”");
      expect(plain).toContain(locale === "de" ? "„Team Ops“" : "“Team Ops”");
      expect(plain).toContain("Lea <lea@example.com>");
      expect(plain).toContain("ready");
    });
    test("lists join once, with three names plus the remaining count", () => {
      const people = {
        p: { kind: "person", people: ["Lea Berg", "Tom Weber", "Mira Hoffmann", "A", "B", "C"].map((name) => ({ name })) },
      } satisfies Record<string, CapabilitySlot>;
      expect(capabilitySentenceText("{p}", people, context)).toBe(
        locale === "de" ? "Lea Berg, Tom Weber, Mira Hoffmann und 3 weitere" : "Lea Berg, Tom Weber, Mira Hoffmann, and 3 more",
      );
      expect(capabilitySentenceText("{p}", { p: { kind: "person", people: people.p.people.slice(0, 3), total: 6 } }, context)).toBe(
        locale === "de" ? "Lea Berg, Tom Weber, Mira Hoffmann und 3 weitere" : "Lea Berg, Tom Weber, Mira Hoffmann, and 3 more",
      );
      const parts = capabilitySentenceParts("{p}", { p: { kind: "person", people: [{ address: "lea@example.com" }] } }, context);
      expect(parts[0]).toMatchObject({ kind: "chip", label: "lea@example.com" });
    });
    test("plural rules choose one and other, and number formatting uses the review locale", () => {
      for (const value of [1, 2, 1000]) {
        const count = { ...slots.count, value };
        expect(capabilitySentenceText("{n}", { n: count }, context)).toBe(
          `${new Intl.NumberFormat(locale).format(value)} ${value === 1 ? count.noun.one : count.noun.other}`,
        );
      }
    });
    test("person chips cut each long name or address before joining the list", () => {
      const people = ["Lea", "Tom", "Mira"].map((name) => ({ name: `${name}${"x".repeat(50)}${name}` }));
      const shortened = people.map(({ name }) => `${name.slice(0, 20)}…${name.slice(-19)}`);
      const [part] = capabilitySentenceParts("{p}", { p: { kind: "person", people, total: 6 } }, context);
      expect(part).toMatchObject({
        kind: "chip",
        label: new Intl.ListFormat(locale, { type: "conjunction" }).format([...shortened, locale === "de" ? "3 weitere" : "3 more"]),
      });
      if (locale === "de" && part?.kind === "chip") expect(part.label).toEndWith("und 3 weitere");
      const address = `${"a".repeat(50)}@example.com`;
      expect(capabilitySentenceParts("{p}", { p: { kind: "person", people: [{ address }] } }, context)[0]).toMatchObject({
        kind: "chip",
        label: `${address.slice(0, 20)}…${address.slice(-19)}`,
        full: address,
      });
    });
    test("middle cuts preserve file extensions and surrogate pairs", () => {
      const parts = capabilitySentenceParts("{file}", { file: { kind: "object", title: "😀".repeat(60) + ".pdf" } }, context);
      const part = parts[0];
      if (part?.kind !== "chip") throw new Error("Expected chip");
      expect(Array.from(part.label)).toHaveLength(40);
      expect(part.label.endsWith(".pdf")).toBe(true);
      expect(part.label).toContain("…");
      expect(part.full).toBe("😀".repeat(60) + ".pdf");
      expect(part.label.isWellFormed()).toBe(true);
    });
    test("dates stay calendar days; instants use the reader zone and invalid zones use UTC", () => {
      const instant = { kind: "time", start: "2026-10-17T01:00:00Z", format: "date-time" } as const;
      const day = { kind: "time", start: "2026-10-17", format: "date" } as const;
      const ny = { locale, timeZone: "America/New_York" },
        berlin = { locale, timeZone: "Europe/Berlin" };
      expect(capabilitySentenceText("{at}", { at: instant }, ny)).not.toBe(capabilitySentenceText("{at}", { at: instant }, berlin));
      expect(capabilitySentenceText("{at}", { at: day }, ny)).toBe(capabilitySentenceText("{at}", { at: day }, berlin));
      expect(capabilitySentenceText("{at}", { at: instant }, { locale, timeZone: "invalid" })).toBe(
        capabilitySentenceText("{at}", { at: instant }, context),
      );
      const before = process.env.TZ;
      const now = spyOn(Date, "now").mockReturnValue(0);
      try {
        process.env.TZ = "Pacific/Honolulu";
        const server = capabilitySentenceParts("{at}", { at: instant }, berlin);
        process.env.TZ = "Asia/Tokyo";
        now.mockReturnValue(4_102_444_800_000);
        expect(capabilitySentenceParts("{at}", { at: instant }, berlin)).toEqual(server);
      } finally {
        now.mockRestore();
        if (before === undefined) delete process.env.TZ;
        else process.env.TZ = before;
      }
    });
    test("plain text is bounded after reducing slot values first", () => {
      const long = { a: { kind: "text", value: "😀".repeat(200) }, b: { kind: "text", value: "x".repeat(200) } } satisfies Record<
        string,
        CapabilitySlot
      >;
      const rendered = capabilitySentenceText(`Start {a} middle {b} end`, long, context);
      expect(rendered.endsWith(" end")).toBe(true);
      expect(Array.from(rendered).length).toBeLessThanOrEqual(400);
      expect(Array.from(capabilitySentenceText("x".repeat(401), {}, context))).toHaveLength(400);
    });
    test("buttons use names, totals, 24-character titles and no quotes", () => {
      const review = reviewFixture();
      review.locale = locale;
      expect(capabilityReviewSentence(review, "confirm", context)).toBe("Send to Lea");
      review.slots = { ...review.slots, to: { kind: "person", people: [{ name: "Lea" }], total: 6 } };
      expect(capabilityReviewSentence(review, "confirm", context)).toBe(locale === "de" ? "Send to 6 Personen" : "Send to 6 people");
      review.sentence.confirm = "{subject}";
      review.slots = { ...review.slots, subject: { kind: "object", title: "a".repeat(60) + ".pdf" } };
      const button = capabilityReviewSentence(review, "confirm", context);
      expect(Array.from(button)).toHaveLength(24);
      expect(button.endsWith(".pdf")).toBe(true);
      expect(button).not.toMatch(/[„“”]/);
    });
    test("defaults and each outcome use the stored review language", () => {
      const review = reviewFixture();
      review.locale = locale;
      const action = capabilitySentenceText(review.sentence.action, review.slots, context);
      expect(capabilityReviewSentence(review, "question", context)).toBe(`${action}?`);
      expect(capabilityReviewSentence(review, "short", context)).toBe(action);
      expect(capabilityReviewSentence(review, "rejected", context)).toBe(
        locale === "de" ? `Nicht ausgeführt: ${action}` : `Not done: ${action}`,
      );
      expect(capabilityReviewSentence(review, "notRun", context)).toBe(capabilityReviewSentence(review, "rejected", context));
      expect(capabilityReviewSentence(review, "unknown", context)).toBe(
        locale === "de" ? `Ob ${action} passiert ist, weiß ich noch nicht.` : `Not known yet whether this happened: ${action}`,
      );
      for (const outcome of ["running", "done", "rejected", "not_run", "unknown"] as const)
        expect(capabilityOutcomeSentence(review, outcome, undefined, context)).toBe(
          capabilityReviewSentence(review, outcome === "not_run" ? "notRun" : outcome, context),
        );
      expect(
        capabilityOutcomeSentence(review, "done", { text: "Receipt {n}", slots: { n: { kind: "text", value: "saved" } } }, context),
      ).toBe("Receipt saved");
      review.sentence.rejected = "Kept {subject}";
      review.sentence.notRun = "Not run {subject}";
      expect(capabilityReviewSentence(review, "rejected", context)).toContain("Kept");
      expect(capabilityReviewSentence(review, "notRun", context)).toContain("Not run");
    });
  });

test("Cloud's EN/DE reason catalog has the exact contract texts", () => {
  const en = [
    "I'm asking because this leaves Cloud.",
    "I'm asking because you can't bring it back afterwards.",
    "I'm asking because you can't set this back.",
    "I'm asking because this involves or notifies other people.",
    "I'm asking because this changes who can see it.",
    "I'm asking because this keeps acting without you.",
    "I'm asking because this concerns payments, invoices, addresses, or sign-in data.",
    "I'm asking because Mail always asks for this.",
  ];
  const de = [
    "Ich frage, weil das Cloud verlässt.",
    "Ich frage, weil du das danach nicht zurückholen kannst.",
    "Ich frage, weil du das nicht zurückstellen kannst.",
    "Ich frage, weil das andere Personen einbindet oder benachrichtigt.",
    "Ich frage, weil sich ändert, wer das sehen kann.",
    "Ich frage, weil das ohne dich weiterwirkt.",
    "Ich frage, weil das Zahlungen, Rechnungen, Adressen oder Zugangsdaten betrifft.",
    "Ich frage, weil Mail hier jedes Mal fragt.",
  ];
  expect(CAPABILITY_ASK_REASONS.map((reason) => capabilityAskReasonText(reason, { locale: "en", appName: "Mail" }))).toEqual(en);
  expect(CAPABILITY_ASK_REASONS.map((reason) => capabilityAskReasonText(reason, { locale: "de", appName: "Mail" }))).toEqual(de);
  expect(capabilityAskReasonText("sends", { locale: "fr", appName: "Mail" })).toBe(en[0]!);
  expect(checkCapabilitySentenceMessages()).toEqual([]);
});
