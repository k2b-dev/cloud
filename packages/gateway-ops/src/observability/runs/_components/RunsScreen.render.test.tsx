import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "gateway-ops-runs-screen-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { RunsScreenFixture } = await import("./runs-fixture");

const dom = createDomTestHarness();
dom.cleanup();
const parser = new dom.window.DOMParser();

/** The server picture of an address: its document and the text a person reads. */
const render = (search: string) => {
  const html = renderToString(() => createComponent(RunsScreenFixture, { search }));
  const body = parser.parseFromString(html, "text/html").body;
  const copy = parser.parseFromString(html, "text/html").body;
  for (const element of copy.querySelectorAll("*")) element.after(" ");
  return { body, text: copy.textContent?.replace(/\s+/g, " ") ?? "" };
};

describe("the runs list on the server", () => {
  test("every kind stands in its own group with its newest runs and a way to all of them", () => {
    const { body, text } = render("");
    for (const kind of ["Jobs", "Workflows", "Zustellungen", "Dead Letters"]) expect(text).toContain(kind);
    expect(text).toContain("Alle 48 Jobs zeigen");
    expect(text).toContain("Alle 30 Zustellungen zeigen");
    expect(text).toContain("Postfach abgleichen");
    // a run's state in colour, symbol and word; its app with the app's symbol
    expect(text).toContain("Fehlgeschlagen");
    expect(body.querySelector('[data-name="alert-circle"]')).not.toBeNull();
    expect(text).toContain("Notizbücher");
    // workflow runs and dead letters open their own records
    const links = [...body.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toContain("/admin/observability/workflows?run=00000000-0000-4000-8000-000000000000");
    expect(links).toContain("/admin/observability/nats/sync?storeApp=mail&kind=queue&store=send&message=m-1");
    expect(text).not.toContain("Wird geladen");
  });

  test("one kind pages through all of its runs; a filter narrows them", () => {
    const one = render("kind=job");
    expect(one.text).toContain("48 von 48 Läufen");
    expect(one.text).not.toContain("Alle 48 Jobs zeigen");
    const failed = render("kind=job&status=failed");
    expect(failed.text).toContain("7 von 7 Läufen");
    expect(failed.text).not.toContain("Erfolgreich");
  });

  test("no match offers to reset; an open job run shows its record and events beside the list", () => {
    expect(render("q=gibtesnicht").text).toContain("Keine Läufe passen zu diesen Filtern.");
    const open = render(`kind=job&run=job:${"0".repeat(32)}:${"3".repeat(16)}`);
    expect(open.text).toContain("Zeitüberschreitung nach 30 s");
    expect(open.text).toContain("index.timeout");
    expect(open.text).toContain("notebooks:reindex");
  });

  test("the schedules tab lists schedules with their next run and a way to run them now", () => {
    const { text } = render("tab=schedules");
    expect(text).toContain("nightly-calendar-sync");
    expect(text).toContain("0 3 * * *");
    expect(text).toContain("Jetzt ausführen");
  });

  test("a parameter the list cannot apply is named, not dropped", () => {
    expect(render("window=2d").text).toContain("window=2d");
  });
});
