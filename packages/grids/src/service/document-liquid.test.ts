import { describe, expect, test } from "bun:test";
import { renderLiquidPlainText, renderLiquidText } from "./document-liquid";
import { renderDocumentPdfPreview } from "./document-rendering";

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

  for (const locale of ["en", "de-CH"]) {
    test(`names timeout and memory failures in ${locale}`, async () => {
      const timeout = await renderLiquidText(
        "{% for a in (1..1000) %}{% for b in (1..1000) %}{% for c in (1..1000) %}{% endfor %}{% endfor %}{% endfor %}",
        {},
        undefined,
        locale,
        20,
      );
      expect(timeout).toMatchObject({
        ok: false,
        error: {
          message:
            locale === "en"
              ? "The template took too long to render. Simplify it or use less data."
              : "Das Rendern der Vorlage hat zu lange gedauert. Vereinfache die Vorlage oder verwende weniger Daten.",
        },
      });
      const memory = await renderLiquidText("{% assign r = (1..1000000000) %}", {}, undefined, locale);
      expect(memory).toMatchObject({
        ok: false,
        error: {
          message:
            locale === "en"
              ? "The template needs too much memory to render. Simplify it or use less data."
              : "Die Vorlage braucht zum Rendern zu viel Speicher. Vereinfache die Vorlage oder verwende weniger Daten.",
        },
      });
    });
  }

  test("preserves and localizes all three template budget codes in PDF previews", async () => {
    for (const { body, code, message } of [
      { body: "{{ value }}", code: "render_too_large", message: "Die gerenderte Vorlage ist zu groß." },
      {
        body: "{% assign r = (1..1000000000) %}",
        code: "render_memory_limit",
        message: "Die Vorlage braucht zum Rendern zu viel Speicher. Vereinfache die Vorlage oder verwende weniger Daten.",
      },
      {
        body: "{% for a in rows %}{% for b in rows %}{% for c in rows %}{% endfor %}{% endfor %}{% endfor %}",
        code: "render_timeout",
        message: "Das Rendern der Vorlage hat zu lange gedauert. Vereinfache die Vorlage oder verwende weniger Daten.",
      },
    ]) {
      const result = await renderDocumentPdfPreview(
        { renderer: { kind: "html", body, numberTemplate: "", filenameTemplate: "" } },
        { value: "x".repeat(300_001), rows: Array.from({ length: 1_000 }, (_, i) => i) },
        undefined,
        undefined,
        "de-CH",
      );
      expect(result).toMatchObject({ ok: false, error: { phase: "template", code, message } });
    }
  });

  test("keeps the localized size error and allows output at the cap", async () => {
    expect(await renderLiquidPlainText("{{ value }}", { value: "é😀" }, 5, "de-CH")).toMatchObject({
      ok: false,
      error: { message: "Die gerenderte Vorlage ist zu groß." },
    });
    expect(await renderLiquidPlainText("{{ value }}", { value: "é😀" }, 6)).toEqual({ ok: true, data: "é😀" });
  });
});
