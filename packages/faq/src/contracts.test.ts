import { describe, expect, test } from "bun:test";
import { CreateFaqSchema, ReorderFaqSchema, UpdateFaqSchema } from "./contracts";

describe("FAQ contracts", () => {
  test("rejects empty update payloads", () => {
    expect(UpdateFaqSchema.safeParse({}).success).toBe(false);
  });

  test("accepts partial update payloads", () => {
    expect(UpdateFaqSchema.safeParse({ audience: ["user"] }).success).toBe(true);
  });

  test("requires a complete English base translation", () => {
    expect(
      CreateFaqSchema.safeParse({
        translations: { de: { question: "Wie melde ich mich an?", answer: "Öffne die Anmeldeseite." } },
        audience: ["anonymous"],
      }).success,
    ).toBe(false);
    expect(
      CreateFaqSchema.safeParse({
        translations: { en: { question: "How do I sign in?", answer: "Open the sign-in page." } },
        audience: ["anonymous"],
      }).success,
    ).toBe(true);
  });

  test("rejects invalid and duplicate canonical locale tags", () => {
    const entry = { question: "Question", answer: "Answer" };
    expect(CreateFaqSchema.safeParse({ translations: { en: entry, "not a locale": entry }, audience: ["user"] }).success).toBe(false);
    expect(CreateFaqSchema.safeParse({ translations: { en: entry, DE: entry, de: entry }, audience: ["user"] }).success).toBe(false);
  });

  test("rejects duplicate reorder ids", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(ReorderFaqSchema.safeParse({ ids: [id, id] }).success).toBe(false);
  });
});
