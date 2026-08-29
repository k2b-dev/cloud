import { describe, expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { quoteWidgetBody } from "./widgets";

describe("Quotes widget localization", () => {
  test("localizes widget chrome while preserving provider content", () => {
    const body = quoteWidgetBody(ok({ text: "Stay curious.", author: "Ada" }), "de-CH");
    expect(body.title).toBe("Zitat der Stunde");
    expect(body.blocks[0]).toMatchObject({ title: "Stay curious.", subtitle: "— Ada" });
  });

  test("localizes provider failure guidance", () => {
    expect(quoteWidgetBody(fail(err.internal("provider failed")), "de-CH").blocks[0]).toMatchObject({
      title: "Derzeit kein Zitat",
      description: "Der Anbieter ist nicht erreichbar. Versuche es in einer Minute erneut.",
    });
    expect(quoteWidgetBody(fail(err.internal("provider failed")), "en").title).toBe("Quote of the hour");
  });
});
