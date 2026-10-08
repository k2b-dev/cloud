import { describe, expect, test } from "bun:test";
import { renderLiquidPlainText, renderLiquidText } from "./document-liquid";

describe("Grids Liquid render limits", () => {
  for (const render of [renderLiquidPlainText, renderLiquidText]) {
    test(`${render.name} enforces its byte cap during rendering`, async () => {
      let reads = 0;
      const result = await render(
        "{% for i in (1..1000) %}{{ chunk }}{% endfor %}",
        {
          get chunk() {
            reads++;
            return "é".repeat(50);
          },
        },
        250,
      );
      expect(result).toMatchObject({ ok: false, error: { message: "The rendered template is too large." } });
      expect(reads).toBe(3);
    });
  }

  test("keeps the localized size error and allows output at the cap", async () => {
    expect(await renderLiquidPlainText("{{ value }}", { value: "é😀" }, 5, "de-CH")).toMatchObject({
      ok: false,
      error: { message: "Die gerenderte Vorlage ist zu groß." },
    });
    expect(await renderLiquidPlainText("{{ value }}", { value: "é😀" }, 6)).toEqual({ ok: true, data: "é😀" });
  });
});
