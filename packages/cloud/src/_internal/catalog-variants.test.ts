import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { i18n } from "@k2b/stdlib";
import { toJSON } from "seroval";
import { catalogIslandVariants, catalogVariant, catalogVariantSource } from "./catalog-variants";

const requests = ["en", "de", "de-CH", "DE-at", "fr", "en-GB"];

const catalogs = `
import { i18n as intl, type Message } from "@k2b/stdlib";
import { defineCatalog } from "@k2b/stdlib";
const shared = { b: "B" };
export const full = intl.define({
  baseLocale: "en",
  messages: {
    en: {
      hello: "Hello",
      count: ({ n }: { n: number }) => \`\${n} items\`,
      onlyEnglish: "Only English",
      "quoted-key": "Quoted",
      shout({ n }: { n: number }) { return "#" + n; },
    },
    de: { hello: "Hallo", count: ({ n }) => \`\${n} Einträge\`, "quoted-key": "Zitiert" },
  },
});
export const direct = defineCatalog({ baseLocale: "en", messages: { en: { a: "A", b: "B" }, DE: { a: "Ä" } } });
export const englishOnly = intl.define({ baseLocale: "en", messages: { en: { a: "A" } } });
export const french = intl.define({ baseLocale: "en", messages: { en: { a: "A" }, fr: { a: "À" } } });
export const germanBase = intl.define({ baseLocale: "de", messages: { de: { a: "Ä" }, en: { a: "A" } } });
export const regional = intl.define({ baseLocale: "en", messages: { en: { a: "A" }, de: { a: "Ä" }, "de-CH": { a: "Ä CH" } } });
export const spread = intl.define({ baseLocale: "en", messages: { en: { ...shared, a: "A" }, de: { a: "Ä" } } });
export const getter = intl.define({ baseLocale: "en", messages: { en: { get a() { return "A"; } }, de: { a: "Ä" } } });
const variable = { en: { a: "A" }, de: { a: "Ä" } };
export const fromVariable = intl.define({ baseLocale: "en", messages: variable });
export const marked = intl.define(/* @i18n-all-locales */ { baseLocale: "en", messages: { en: { a: "A" }, de: { a: "Ä" } } });
`;
const rewritten = ["full", "direct", "englishOnly"];
const keptWhole = ["french", "germanBase", "regional", "spread", "getter", "fromVariable", "marked"];

type Catalog = { locales: string[]; resolve: (requested?: readonly string[]) => { locale: string; t: Record<string, unknown> } };

/** Evaluates the fixture module: transpiled, with its `@k2b/stdlib` imports bound to the real `i18n`. */
const evaluate = (source: string): Record<string, Catalog> => {
  const code = new Bun.Transpiler({ loader: "ts" })
    .transformSync(source)
    .replace(/import\s*\{[^}]*\}\s*from\s*"@k2b\/stdlib";?/g, "")
    .replace(/export const (\w+) =/g, "exports.$1 =");
  const exports: Record<string, Catalog> = {};
  new Function("intl", "defineCatalog", "exports", code)(i18n, i18n.define, exports);
  return exports;
};

/** A translator as comparable data: strings as they are, functions by what they return for a sample argument. */
const comparable = ({ locale, t }: { locale: string; t: Record<string, unknown> }) => ({
  locale,
  t: Object.fromEntries(Object.entries(t).map(([key, value]) => [key, typeof value === "function" ? value({ n: 2 }) : value])),
});

describe("catalog language builds", () => {
  test("a request locale loads its most specific catalog language, otherwise English", () => {
    expect(requests.map(catalogVariant)).toEqual(["en", "de", "de", "de", "en", "en"]);
    expect([undefined, "", "DE", "zh-Hant-TW"].map(catalogVariant)).toEqual(["en", "en", "de", "en"]);
  });

  test("each build resolves its requests exactly like the full catalogs, and only rewritable catalogs shrink", async () => {
    const original = evaluate(catalogs);
    for (const variant of ["en", "de"]) {
      const source = await catalogVariantSource(catalogs, "/app/catalogs.ts", variant);
      const built = evaluate(source);
      for (const request of requests.filter((locale) => catalogVariant(locale) === variant))
        for (const name of Object.keys(original))
          expect([name, request, comparable(built[name]!.resolve([request]))]).toEqual([
            name,
            request,
            comparable(original[name]!.resolve([request])),
          ]);
      for (const name of rewritten) expect(built[name]!.locales).toHaveLength(1);
      for (const name of keptWhole) expect(built[name]!.locales).toEqual(original[name]!.locales);
      const strings = variant === "en" ? ["Hallo", "Einträge", "Zitiert", '"Ä"'] : ["Hello", "items", "Quoted"];
      const rewrittenSource = source.slice(0, source.indexOf("export const french"));
      for (const text of strings) expect(rewrittenSource).not.toContain(text);
    }
    expect(await catalogVariantSource(catalogs, "/app/catalogs.ts", "de")).toContain('"Only English"');
  });

  test("other modules stay byte for byte", async () => {
    const local = `import type { Message } from "@k2b/stdlib";
const i18n = { define: (value: unknown) => value };
export const local = i18n.define({ baseLocale: "en", messages: { en: { a: "A" }, de: { a: "Ä" } } });`;
    for (const [path, source] of [
      ["/app/plain.ts", 'export const define = () => "no catalog";'],
      ["/app/local.ts", local],
      ["/app/broken.ts", 'import { i18n } from "@k2b/stdlib"; i18n.define({'],
      [
        "/app/namespace.js",
        'import * as stdlib from "@k2b/stdlib"; stdlib.i18n.define({ baseLocale: "en", messages: { en: {}, de: {} } });',
      ],
    ] as const)
      expect(await catalogVariantSource(source, path, "de")).toBe(source);
  });

  test("a German page renders German before and after its island mounts, an English page English", async () => {
    const root = mkdtempSync(join(resolve(import.meta.dir, "../../node_modules"), ".catalog-variants-test-"));
    try {
      const errorMessages = resolve(import.meta.dir, "../ssr/page-error-messages.ts");
      writeFileSync(
        join(root, "probe.ts"),
        `import { i18n } from "@k2b/stdlib";
        import { pageErrorMessages } from ${JSON.stringify(errorMessages)};
        import { reviewActionCard } from ${JSON.stringify(resolve(import.meta.dir, "../ai/chat/action-card.ts"))};
        import { actionCardText } from ${JSON.stringify(resolve(import.meta.dir, "../ai/chat/action-text.ts"))};
        // A review stored in German: its card follows the reader's language, its sentence stays German.
        const review = {
          locale: "de",
          slots: {},
          ask: "sends",
          sentence: { action: "Nachricht senden", running: "Wird gesendet …", done: "Gesendet.", confirm: "Senden", decline: "Nicht senden" },
          preview: { kind: "message", from: { name: "Team Ops", address: "ops@example.com" }, to: [{ name: "Lea Berg", address: "lea@example.com" }], subject: "Wartung", body: "Hallo", format: "plain" },
        } as const;
        const cardText = (locale: string) => {
          const text = actionCardText(reviewActionCard(review, { locale, timeZone: "UTC", app: { name: "Mail", icon: "ti ti-mail" } }));
          return [text.question, ...text.rows.map((row) => row.label + ": " + row.value)].join(" / ");
        };
        const fixture = i18n.define({
          baseLocale: "en",
          messages: {
            en: { hello: "Hello", count: ({ n }: { n: number }) => \`\${n} items\`, onlyEnglish: "Only English" },
            de: { hello: "Hallo", count: ({ n }) => \`\${n} Einträge\` },
          },
        });
        export const probeText = (locale: string) => {
          const platform = pageErrorMessages.resolve([locale]).t;
          const own = fixture.resolve([locale]).t;
          return [platform.notFound, own.hello, own.count({ n: 2 }), own.onlyEnglish, cardText(locale)].join(" | ");
        };`,
      );
      writeFileSync(
        join(root, "Probe.island.tsx"),
        'import { probeText } from "./probe"; export default function Probe() { return <p>{probeText(document.documentElement.lang)}</p>; }',
      );
      writeFileSync(join(root, "server.ts"), "export {};");
      const { plugin } = createConfig({ rootDir: root, verbose: false, variants: catalogIslandVariants() });
      const build = await Bun.build({
        entrypoints: [join(root, "server.ts")],
        outdir: join(root, "dist"),
        target: "bun",
        plugins: [plugin()],
      });
      expect(build.success).toBe(true);
      const ssr = join(root, "dist", "_ssr");
      const manifest = JSON.parse(readFileSync(join(ssr, "manifest.json"), "utf8"));
      const [id] = Object.keys(manifest.entries);
      const directory = (variant: string) => (variant === "en" ? ssr : join(ssr, variant));
      const bundle = (variant: string) =>
        [...new Bun.Glob("*.js").scanSync(directory(variant))]
          .map((file) => readFileSync(join(directory(variant), file), "utf8"))
          .join("\n");
      // Each build ships its own language and no other one.
      expect(bundle("en")).toContain("Page not found");
      expect(bundle("en")).not.toContain("Seite nicht gefunden");
      expect(bundle("en")).not.toContain("Hallo");
      expect(bundle("de")).toContain("Seite nicht gefunden");
      expect(bundle("de")).not.toContain("Page not found");
      expect(bundle("de")).toContain("Only English");

      const client = join(root, "client.ts");
      writeFileSync(
        client,
        `import { createDomTestHarness } from ${JSON.stringify(resolve(import.meta.dir, "../../../ui/test/dom.ts"))};
        const [entry, id, lang, props] = Bun.argv.slice(2);
        const dom = createDomTestHarness();
        dom.document.documentElement.lang = lang;
        dom.document.body.innerHTML = '<solid-island data-id="' + id + '" data-props="' + props + '"><p>SSR</p></solid-island>';
        await import(entry);
        console.log(JSON.stringify(dom.document.querySelector("solid-island").textContent));
        process.exit(0);`,
      );
      const props = JSON.stringify(toJSON({})).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      // Server rendering resolves the full catalogs, as \`probeText\` does here.
      const { probeText } = await import(join(root, "probe.ts"));
      for (const lang of ["en", "de", "de-CH", "fr", "en-GB"]) {
        const entry = join(directory(catalogVariant(lang)), `${id}.js`);
        const child = Bun.spawn([process.execPath, client, entry, id!, lang, props], { stdout: "pipe", stderr: "pipe" });
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ lang, status, stderr }).toEqual({ lang, status: 0, stderr: "" });
        expect([lang, JSON.parse(stdout)]).toEqual([lang, probeText(lang)]);
      }
      expect(probeText("de")).toStartWith("Seite nicht gefunden | Hallo | 2 Einträge | Only English | ");
      expect(probeText("fr")).toStartWith("Page not found | Hello | 2 items | Only English | ");
      expect(probeText("en")).toContain("Nachricht senden");
      expect(probeText("en")).toContain(" / To: Lea Berg");
      expect(probeText("de")).toContain(" / An: Lea Berg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
