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

/**
 * The server picture of an address: its document and the text a person reads. A chart's drawing is no text, and its
 * inline style stops the test parser, so it leaves before parsing.
 */
const render = (search: string) => {
  const html = renderToString(() => createComponent(RunsScreenFixture, { search })).replace(/<svg[\s\S]*?<\/svg>/g, "");
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
    expect(body.querySelector('[data-name="player-play"]')).not.toBeNull();
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
    const statuses = [...failed.body.querySelectorAll('[data-k2-part="Table"] tbody tr')].map((row) => row.textContent ?? "");
    expect(statuses.length).toBe(7);
    expect(statuses.every((row) => row.includes("Fehlgeschlagen"))).toBe(true);
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

  test("a workflow filter from a link names the definition, not its ID", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const { text } = render(`kind=workflow&workflow=${id}`);
    expect(text).toContain("Workflow-Definition ist Neue Anfrage zuordnen");
    expect(text).not.toContain(`ist ${id}`);
  });

  test("the first row says what matters in the window: jobs and deliveries beside each other, four figures for one kind", () => {
    const mixed = render("").text;
    expect(mixed).toContain("Erfolgreiche Jobs 1.284");
    expect(mixed).toContain("Fehlgeschlagene Jobs 7 1 nie beendet");
    expect(mixed).toContain("Zugestellt 97,7 % von 1.502 Zustellungen");
    expect(mixed).toContain("Fehlgeschlagene Zustellungen 3 2 offen");
    expect(mixed).not.toContain("Zeitleiste");
    const jobs = render("kind=job").text;
    expect(jobs).toContain("Laufende Jobs 1");
    expect(jobs).toContain("Dauer (P95) 12,4 Sek.");
    expect(jobs).not.toContain("Zustellungen");
    const deliveries = render("kind=delivery").text;
    expect(deliveries).toContain("Offene Zustellungen 2");
    expect(deliveries).toContain("Unterdrückt 29");
    expect(deliveries).not.toContain("Erfolgreiche Jobs");
  });

  test("only jobs: their lanes stand above the list, a mark opens its run; an open run takes the room", () => {
    const { body, text } = render("kind=job");
    expect(text).toContain("Zeitleiste");
    expect(body.querySelector('[data-k2-part="Canvas"]')).not.toBeNull();
    const open = render(`kind=job&run=job:${"0".repeat(32)}:${"3".repeat(16)}`).text;
    expect(open).not.toContain("Zeitleiste");
  });

  test("per minute: the successful runs the list cannot show one by one, counted per minute and job", () => {
    const { body, text } = render("tab=minutes");
    expect(text).toContain("Kurze erfolgreiche Läufe werden nur je Minute gezählt");
    expect(text).toMatch(/[\d.]+ erfolgreiche Läufe/);
    expect(text).toContain("Postfach abgleichen");
    expect(body.querySelectorAll('[data-k2-part="Table"] tbody tr').length).toBe(100);
    expect(text).toContain("Seite 1 von 3");
    const tab = [...body.querySelectorAll("a")].find((link) => link.textContent?.includes("Je Minute"));
    expect(tab?.getAttribute("aria-current")).toBe("page");
  });

  test("a delivered notification whose mail bounced afterwards says so beside its delivery", () => {
    const { text } = render("kind=delivery");
    expect(text).toContain("Mia Muster · E-Mail · E-Mail: unzustellbar");
  });

  test("a parameter the list cannot apply is named, not dropped", () => {
    expect(render("window=2d").text).toContain("window=2d");
  });
});
