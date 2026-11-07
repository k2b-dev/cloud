import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-flow-amount-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { FlowAmount, flowDirection } = await import("./FlowAmount");
const { LocaleProvider } = await import("../intl/locale");

const flow = (props: Record<string, unknown>, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(FlowAmount, { currency: "EUR", value: 0, ...props } as never);
      },
    }),
  );

test("money in, out and zero carry an arrow and a spoken direction, never a sign", () => {
  const incoming = flow({ value: 31240.5 });
  expect(incoming).toContain('data-direction="in"');
  expect(incoming).toContain("ti-arrow-down-left");
  expect(incoming).toMatch(/31\.240,50\s€/);
  expect(incoming).toContain('<span class="k2b-sr-only">, Eingang</span>');
  expect(incoming).toContain('title="Eingang"');

  const outgoing = flow({ value: -30500 });
  expect(outgoing).toContain('data-direction="out"');
  expect(outgoing).toContain("ti-arrow-up-right");
  expect(outgoing).toMatch(/30\.500,00\s€/);
  expect(outgoing).not.toMatch(/[-−]30/);
  expect(outgoing).toContain(", Ausgang<");

  const zero = flow({ value: -0 }, "en");
  expect(zero).toContain('data-direction="none"');
  expect(zero).toContain("ti-equal");
  expect(zero).toContain("€0.00");
  expect(zero).toContain(", no amount<");
});

test("a broken amount shows a dash, never a believable zero", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const html = flow({ value });
    expect(html).toContain('data-direction="none"');
    expect(html).toContain(">—<");
    expect(html).not.toContain("0,00");
    expect(html).toContain(", Betrag unbekannt<");
  }
});

test("an explicit locale also sets the spoken words", () => {
  expect(flow({ value: 12, locale: "en-US" }, "de")).toContain(", incoming<");
  expect(flow({ value: -12, locale: "de-DE" }, "en")).toContain(", Ausgang<");
});

test("labels, decimals, locale and size are the host's to choose", () => {
  const html = flow({ value: -1204.8, decimals: 0, labels: { out: "Ausgabe" }, size: "lg", locale: "en-US", currency: "USD" });
  expect(html).toContain("$1,205");
  expect(html).toContain(", Ausgabe<");
  expect(html).toContain('data-size="lg"');
  expect(flowDirection(Number.NaN)).toBe("none");
  expect(flowDirection(Number.POSITIVE_INFINITY)).toBe("none");
});

test("flow tokens exist in light and dark", () => {
  const css = readFileSync(resolve(import.meta.dir, "../styles/index.css"), "utf8");
  for (const token of ["in-text", "in-surface", "in-ring", "in-mark", "out-text", "out-surface", "out-mark"]) {
    expect(css.match(new RegExp(`--k2b-flow-${token}:`, "g"))?.length, token).toBe(2);
  }
});
