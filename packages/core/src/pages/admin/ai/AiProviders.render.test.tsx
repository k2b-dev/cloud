import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toJSON } from "seroval";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

// KI › Providers as the server renders it: a provider with a thousand models hands its island only what the view shows.
const root = mkdtempSync(join(tmpdir(), "core-ai-providers-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { LocaleProvider } = await import("@k2b/ui");
const { adminNavFixture } = await import("../admin-v2.fixture");
const { default: ProvidersScreen } = await import("./ProvidersScreen");
const { providersFixture } = await import("./fixture-catalog");

const nav = adminNavFixture("/admin/ai");
/** The island's props as the server serializes them into its props comment (`JSON.stringify(toJSON(props))`), in bytes. */
const islandBytes = (props: object) => Buffer.byteLength(JSON.stringify(toJSON(props)));
const render = (query: string) => {
  const data = providersFixture({ state: "worst", locale: "en", params: new URLSearchParams(query) });
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(ProvidersScreen, { nav, data });
      },
    }),
  );
  return { html, bytes: islandBytes({ nav, data }) };
};

test("a provider with 1,000 models hands its island its first 100 rows and the counts, within a measured budget", () => {
  const open = render("sec=providers&p=cortecs");
  const deep = render("sec=providers&p=cortecs&m=bulk-998");
  const found = render("sec=providers&p=cortecs&mq=Modell+999");
  const normal = providersFixture({ state: "normal", locale: "en", params: new URLSearchParams("sec=providers") });
  console.info(
    JSON.stringify({ islandBytes: { open: open.bytes, deep: deep.bytes, found: found.bytes, normal: islandBytes({ nav, data: normal }) } }),
  );
  // the counts come from the server, the rows are the first 100 matches, a model beyond them opens by its address
  expect(open.html).toContain("100 of 1,003 · Narrow the search");
  expect(open.html).toContain("1003 models");
  expect(open.html).toContain("m=bulk-96");
  expect(open.html).not.toContain("m=bulk-97");
  expect(deep.html).toContain("Modell 998");
  expect(found.html).toContain("m=bulk-999");
  expect(found.html).not.toContain("Narrow the search");
  // With the whole catalog the island carried 1,495 KB here (1,003 models with their variants, twice for the open
  // provider). Now it carries the 100 rows, the open model, the assigned models and the open provider's model ids
  // for the add dialog: 197 KB open, 201 KB with a model open, 109 KB with one match.
  for (const bytes of [open.bytes, deep.bytes, found.bytes]) expect(bytes).toBeLessThan(240_000);
});
