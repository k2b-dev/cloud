import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-cloud-descriptions-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { DescriptionPanel, resolveDescription } = await import("./index");
const { LocaleProvider } = await import("@k2b/ui");
type Props = Parameters<typeof DescriptionPanel>[0];
const panel = (props: Props, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(DescriptionPanel, props);
      },
    }),
  );

test("a table block draws in the dashboard frame with search in its head and every row reserved", () => {
  const html = panel({
    spec: { block: "table", title: "Campaigns", search: true, columns: [{ id: "name", label: "Campaign" }], rows: [{ name: "Weekly" }] },
    title: "Campaigns",
    height: 260,
    width: "full",
  });
  expect(html).toContain("k2b-dashboard-frame");
  expect(html).toContain('data-width="full"');
  expect(html).toContain("k2b-dashboard-frame__reserve");
  expect(html).toContain('aria-label="Search Campaigns"');
});

test("a table without rows keeps the read's state in its head and says why below", () => {
  const html = panel({
    spec: { block: "table", title: "Payments", columns: [{ id: "due", label: "Due" }], rows: [] },
    title: "Payments",
    height: 260,
    state: "stale",
    asOf: "09:12",
    onRetry: () => {},
    empty: "No payments are planned.",
  });
  expect(html).toContain("As of 09:12");
  expect(html).toContain("No payments are planned.");
});

test("key figures name the time of a stale read, in the reader's language", () => {
  const spec = { block: "stats", items: [{ label: "Subscribers", value: 48210 }] };
  expect(panel({ spec, title: "Key figures", height: 0, state: "stale", asOf: "09:12" })).toContain("As of 09:12 · not current");
  expect(panel({ spec, title: "Key figures", height: 0, state: "stale", asOf: "09:12" }, "de")).toContain("Stand 09:12 · nicht aktuell");
});

test("tables of charts only the Solid component draws follow the requested locale", () => {
  const map = resolveDescription(
    { kind: "map", series: [{ data: [{ label: "Berlin", latitude: 52.52, longitude: 13.405, size: 1200.5 }] }] },
    "de",
  );
  if (map.mode !== "live") throw new Error(`expected a live drawing, got ${map.mode}`);
  expect(map.columns.map((column) => column.label)).toEqual(["Ort", "Breite", "Länge", "Größe"]);
  expect(map.rows[0]!.cells.latitude).toBe("52,52°");
  expect(map.rows[0]!.cells.size).toBe("1.200,5");
});
