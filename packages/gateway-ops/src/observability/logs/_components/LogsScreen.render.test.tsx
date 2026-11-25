import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "gateway-ops-logs-screen-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { LogsScreenFixture } = await import("./logs-screen.fixture");
const { default: LogEntryPane } = await import("./LogEntryPane");
const { LocaleProvider } = await import("@k2b/ui");

/** The open entry alone, as the detail beside the list renders it. */
const renderEntry = (entry: { message: string; metadata: Record<string, unknown> | null }) => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(LogEntryPane, {
          selected: { entry: { id: "77", level: "error", source: "mail", createdAt: "2026-11-24T09:43:35.992Z", ...entry }, error: null },
          timeZone: "Europe/Berlin",
          closeHref: "/admin/observability/logs",
          listLabel: "Protokolle",
          onRequest: () => {},
        });
      },
    }),
  );
  return parser.parseFromString(html, "text/html").body;
};

const dom = createDomTestHarness();
dom.cleanup();
const parser = new dom.window.DOMParser();

/** The text a person reads: the server HTML parsed as a document, each element followed by a space, as layout would. */
const render = (search: string, state?: "loadfail") => {
  const html = renderToString(() => createComponent(LogsScreenFixture, { search, state }));
  const body = parser.parseFromString(html, "text/html").body;
  for (const element of body.querySelectorAll("*")) element.after(" ");
  return { html, text: body.textContent?.replace(/\s+/g, " ") ?? "" };
};

describe("the log list on the server", () => {
  test("the first picture shows the filter statements, the result and the rows of the address", () => {
    const { text } = render("time=last-15m&level=error,warn&source=mail,gateway");
    expect(text).toContain("Zeitraum letzte 15 Minuten");
    expect(text).toContain("Stufe ist Warnung oder Fehler");
    expect(text).toContain("Quelle ist mail oder gateway");
    expect(text).toContain("11 von 11 Einträgen");
    expect(text).toContain("6 Fehler");
    expect(text).toContain("5 Warnungen");
    expect(text).toContain("Upstream mail: Zeitüberschreitung nach 30 s");
    expect(text).toContain("10:43:48,377");
    expect(text).toContain("Neueste zuerst");
    expect(text).not.toContain("Anmeldung mit Passkey");
  });

  test("grouped by minute, each minute is a group row with its errors and warnings", () => {
    const { text } = render("time=last-15m&group=minute");
    expect(text).toContain("10:43 Uhr");
    expect(text).toContain("3 Fehler");
    expect(text).toContain("10:42 Uhr");
    expect(text).toContain("1 Fehler · 2 Warnungen");
  });

  test("no match offers to reset the filters; a store that does not answer keeps the bar and offers a retry", () => {
    const empty = render("time=last-15m&q=nichtda");
    expect(empty.text).toContain("Keine Einträge passen zu diesen Filtern.");
    expect(empty.text).toContain("Filter zurücksetzen");
    // the status row says there is nothing, not "0 von 0 Einträgen"
    expect(empty.text).toContain("Keine Einträge");
    expect(empty.text).not.toContain("0 von 0");
    const failed = render("time=last-15m&level=error", "loadfail");
    expect(failed.text).toContain("Stufe ist Fehler");
    expect(failed.text).toContain("Der Protokollspeicher war nicht lesbar.");
  });

  test("a range that has ended turns live off and says why; parts that did not apply are named", () => {
    const { text } = render("time=2026-11-24T08:00Z..2026-11-24T09:30Z&colour=red");
    expect(text).toContain("nur mit Zeitraum bis jetzt");
    expect(text).toContain("Ein Teil der Adresse galt nicht");
    expect(text).toContain("colour=red");
  });

  test("an open entry stands beside the list with its fields", () => {
    const { text } = render("time=last-15m&entry=9001");
    expect(text).toContain("Fehler · mail");
    expect(text).toContain("smtp.example.org");
  });

  test("a stack trace keeps its lines in the open entry, in the message and in the metadata", () => {
    const stack = "Error: SMTP timeout\n    at send (mail/smtp.ts:41:11)\n    at deliver (mail/queue.ts:88:5)";
    const body = renderEntry({ message: stack, metadata: { stack, requestId: "7f3a9c" } });
    const blocks = [...body.querySelectorAll("pre")].map((block) => block.textContent?.trim());
    expect(blocks).toEqual([stack, stack]);
    expect(body.textContent).toContain("7f3a9c");
  });

  test("an entry without a message says so instead of leaving a blank", () => {
    const body = renderEntry({ message: "   ", metadata: null });
    expect(body.textContent).toContain("(ohne Text)");
  });
});
