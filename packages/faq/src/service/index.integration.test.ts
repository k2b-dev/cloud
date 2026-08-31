import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { faqService } from ".";

const suite = process.env.FAQ_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const createdIds: string[] = [];

suite("localized FAQ entries", () => {
  beforeAll(migrate);

  afterAll(async () => {
    for (const id of createdIds) await sql`DELETE FROM faq.entries WHERE id = ${id}::uuid`;
  });

  test("stores canonical translations and resolves request fallback", async () => {
    const created = await faqService.entry.create({
      data: {
        translations: {
          en: { question: "English question", answer: "English answer" },
          "DE-ch": { question: "Schweizer Frage", answer: "Schweizer Antwort" },
        },
        audience: ["anonymous"],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdIds.push(created.data.id);
    expect(Object.keys(created.data.translations)).toEqual(["en", "de-CH"]);

    const exact = await faqService.entry.listResolved({ filter: { audience: "anonymous" }, locale: "de-CH" });
    expect(exact.items.find((entry) => entry.id === created.data.id)).toMatchObject({
      locale: "de-CH",
      question: "Schweizer Frage",
    });

    const fallback = await faqService.entry.listResolved({ filter: { audience: "anonymous" }, locale: "fr" });
    expect(fallback.items.find((entry) => entry.id === created.data.id)).toMatchObject({
      locale: "en",
      question: "English question",
    });
  });
});
