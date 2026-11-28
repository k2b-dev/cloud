import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { mailCodeHistoryRedirect, opensMailCodeHistory } from "./mail-code-history-address";

// The retired Mail rules' history, a step of the mailbox's Code page: readable lines instead of raw JSON, one entry
// opened with its reasons, the earlier runs with their technical details folded away; every choice is an address.
const root = mkdtempSync(join(tmpdir(), "mail-code-history-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: MailCodeHistory } = await import("./MailCodeHistory");
const { MAIL_CODE_HISTORY_STATES, mailCodeHistoryFixture } = await import("./MailCodeHistory.fixture");
const { logFixtureItems } = await import("./_components/mail-rule-history-fixtures");
const { LocaleProvider } = await import("@k2b/ui");

type Data = ReturnType<typeof mailCodeHistoryFixture>;
const renderData = (data: Data, locale: "de" | "en" = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MailCodeHistory, { data });
      },
    }),
  );
const render = (state: (typeof MAIL_CODE_HISTORY_STATES)[number], locale: "de" | "en" = "de") =>
  renderData(mailCodeHistoryFixture(state), locale);
const text = (html: string) =>
  html
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

for (const state of MAIL_CODE_HISTORY_STATES)
  for (const locale of ["de", "en"] as const)
    test(`${state} (${locale}) renders lines a person reads, never the raw entry`, () => {
      const html = render(state, locale);
      expect(html).not.toContain('"outcome"');
      expect(html).not.toContain('"effects"');
      expect(html).not.toContain("<pre");
      expect(text(html)).toContain(locale === "de" ? "Frühere Mail-Regeln" : "Retired Mail rules");
    });

test("each entry shows its time, rule, subject, outcome and what it did; an older page has its address", () => {
  const html = render("tag");
  const first = logFixtureItems[0]!;
  expect(text(html)).toContain(first.conversation.subject);
  expect(text(html)).toContain(first.by.name);
  expect(html).toContain('href="/app/mail/Mb4kd2/code?history=1&amp;day=2026-10-26&amp;before=older-entries-cursor"');
  expect(html).toContain(`href="/app/mail/Mb4kd2/code?history=1&amp;day=2026-10-26&amp;entry=${first.id}"`);
  expect(text(html)).toContain("Was die Regeln am 26. Okt. 2026 getan haben");
});

test("the opened entry says why and leads to its conversation; opening it again closes it", () => {
  const html = render("eintrag");
  const open = logFixtureItems[3]!;
  expect(text(html)).toContain("Warum");
  expect(html).toContain(`href="${open.conversation.href}"`);
  // its own line now closes it: the address drops the entry
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('href="/app/mail/Mb4kd2/code?history=1&amp;day=2026-10-26"');
});

test("a day without entries says so; a run opens with its steps, their states and error text in words", () => {
  expect(text(render("leer"))).toContain("An diesem Tag haben die Regeln nichts getan.");
  const run = text(render("lauf"));
  expect(run).toContain("2 Schritte");
  expect(run).toContain("assign Erledigt");
  expect(run).toContain("move Fehlgeschlagen Den Ordner „Rechnungen 2025“ gibt es nicht mehr.");
  expect(run).not.toContain("failed");
  expect(run).not.toContain("succeeded");
  expect(render("lauf")).toMatch(/data-tone="error"[^>]*>(?:(?!<\/span>).)*Fehlgeschlagen/s);
});

test("on an older page, opening an entry or a run keeps both pages' cursors", () => {
  const data = { ...mailCodeHistoryFixture("tag"), before: "page-2", runAfter: "runs-2" };
  const html = renderData(data);
  const first = logFixtureItems[0]!;
  expect(html).toContain(
    `href="/app/mail/Mb4kd2/code?history=1&amp;day=2026-10-26&amp;before=page-2&amp;entry=${first.id}&amp;runAfter=runs-2"`,
  );
  const run = data.runs!.items[0]!;
  expect(html).toContain(
    `href="/app/mail/Mb4kd2/code?history=1&amp;day=2026-10-26&amp;before=page-2&amp;runAfter=runs-2&amp;run=${run.id}"`,
  );
  // an open entry closes on its own line and keeps the page it is on
  const open = renderData({ ...data, entry: first.id });
  expect(open).toContain('href="/app/mail/Mb4kd2/code?history=1&amp;day=2026-10-26&amp;before=page-2&amp;runAfter=runs-2"');
});

test("a day that is not a date asks for a day in its field; runs that cannot be read say so with a way to try again", () => {
  const html = render("fehler");
  expect(text(html)).toContain("Wähle einen Tag im Kalender.");
  expect(text(html)).toContain("Die früheren Läufe konnten nicht gelesen werden.");
  expect(text(html)).toContain("Erneut versuchen");
  const missing = renderData({ ...mailCodeHistoryFixture("tag"), run: { id: "gone", failed: true } });
  expect(text(missing)).toContain("Dieser Lauf konnte nicht gelesen werden.");
});

test("a reader who may not read the runs is told so, with no retry that cannot succeed", () => {
  const html = renderData({ ...mailCodeHistoryFixture("tag"), runs: null, runsForbidden: true, run: { id: "other", failed: true } });
  expect(text(html)).toContain("Frühere Läufe sieht nur, wer das ganze Postfach lesen darf.");
  expect(text(html)).not.toContain("Erneut versuchen");
  expect(text(html)).not.toContain("konnte nicht gelesen werden");
});

test("only history=1 opens the step; the former page leads there and keeps day, entry and runs", () => {
  expect(opensMailCodeHistory(new URL("https://cloud.test/app/mail/Mb4kd2/code?history=1"))).toBe(true);
  expect(opensMailCodeHistory(new URL("https://cloud.test/app/mail/Mb4kd2/code"))).toBe(false);
  expect(mailCodeHistoryRedirect(new URL("https://cloud.test/app/mail/Mb4kd2/automations/log"))).toBe("/app/mail/Mb4kd2/code?history=1");
  expect(mailCodeHistoryRedirect(new URL("https://cloud.test/app/mail/Mb4kd2/automations/log?day=2026-10-26&entry=x&runAfter=y"))).toBe(
    "/app/mail/Mb4kd2/code?history=1&day=2026-10-26&entry=x&runAfter=y",
  );
});
