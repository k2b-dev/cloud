import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Context, Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { codeSurfaceFindings } from "../../../../../scripts/checks/code-no-source";
import { renderedText, withoutComments } from "../../../../../scripts/fixtures/rendered-markup";
import { currentLibrary } from "../../../test/future-capability-manifest";
import * as capabilityProvider from "../../capabilities/server";
import { capabilityResultSchema } from "../../contracts/capabilities";
import { cloudResourcePageHref } from "../../contracts/resource-pages";
import * as coreLocation from "../../services/identity/core-origin";
import { loadCodeRunCallsForDetail, summarizeCallResult } from "./calls";
import { CODE_PAGE_FIXTURE_STATES, type CodePageFixtureState, codePageFixture } from "./code-page.fixture";
import type { CodePageInvoke } from "./data";
import { codePageMessages } from "./messages";
import { nameRecentResults } from "./recent-names";
import { describeCodeSchedule } from "./schedule";

const root = mkdtempSync(resolve(tmpdir(), "cloud-code-page-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CodePage } = await import("./CodePage");
const { describeTarget, loadCodePage, permissionRef, visiblePersonIds } = await import("./load");
const capabilityServer = await import("../../capabilities/server");
const { loadCodeAttention } = await import("./attention");
const { codePageNeedsAttention } = await import("./CodePage");
const { LocaleProvider } = await import("@k2b/ui");

const renderMarkup = (render: Parameters<typeof renderToString>[0]) => withoutComments(renderToString(render));

const html = (state: CodePageFixtureState, locale = "de") =>
  renderMarkup(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodePage, { data: codePageFixture(state, locale) });
      },
    }),
  );
/** Visible text only: server scripts and the reserved widths of status words stay out. */
const text = (state: CodePageFixtureState, locale = "de") =>
  renderedText(
    new HTMLRewriter()
      .on("script", { element: (element) => void element.remove() })
      .on('[aria-hidden="true"]', { element: (element) => void element.remove() })
      .transform(html(state, locale)),
    " ",
  ).replaceAll(/\s+/g, " ");

describe("Code page: overview (Bild 19 to 21)", () => {
  test("the head says the state in one large word, the place and version in one quiet line, and offers Gustav and More", () => {
    const page = text("overview");
    expect(page).toContain("Eingeschaltet");
    expect(page).toContain("Postfach info@moebel-beispiel.de · Version 4, eingeschaltet am 28.10. von Ben Schulz");
    expect(page).toContain("Mit Gustav ändern");
    // "View code" and the account line with its handle are gone; the handle lives in the menu.
    expect(page).not.toContain("Code ansehen");
    expect(page).not.toContain("code-7k2q9m4xwt");
    expect(html("overview").match(/Kennung kopieren/g)).toHaveLength(1);
    expect(page).toContain("Quelltext lokal holen");
  });

  test("tabs in one row: overview, runs, secrets with a count, versions with a count, code only for editors", () => {
    const markup = html("overview");
    for (const tab of ["?tab=runs", "?tab=secrets", "?tab=versions", "?tab=code"]) expect(markup).toContain(`/app/mail/Mb4kd2/code${tab}`);
    const reader = html("reader");
    expect(reader).not.toContain("?tab=code");
    expect(reader).not.toContain("?tab=secrets");
  });

  test("the description is Gustav's one sentence with its plum mark; without one the line is gone", () => {
    expect(text("overview")).toContain("Trägt Lieferavise aus dem Postfach als Aufgaben im Space Logistik ein");
    expect(html("overview")).toContain('class="cloud-code__ai-mark" data-k2b-primary="ai"');
    expect(text("overview")).toContain("von Gustav beschrieben");
    const data = codePageFixture("overview");
    if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
    data.state.words!.current = { ...data.state.words!.current!, description: { state: "missing", text: null, modelLabel: "" } };
    const page = renderedText(
      renderMarkup(() =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(CodePage, { data });
          },
        }),
      ),
      " ",
    );
    expect(page).not.toContain("von Gustav beschrieben");
  });

  test("the situation: next run large, last run with its sign, and the last 30 runs as bars that each open their run", () => {
    const markup = html("overview");
    const page = text("overview");
    expect(page).toContain("Nächster Lauf");
    expect(page).toContain("in 11 Min.");
    expect(page).toContain("Zuletzt");
    expect(page).toContain("Letzte 30 Läufe · heute 30, davon 1 fehlgeschlagen");
    expect(page).toContain("Alle Läufe");
    expect(markup).toContain('data-variant="bar"');
    // Each of the 30 bars opens its run.
    expect(markup.match(/class="k2b-dot-strip__target" href="\/app\/mail\/Mb4kd2\/code\?tab=runs&amp;run=/g)).toHaveLength(30);
    expect(markup.match(/data-state="danger"/g)?.length).toBeGreaterThanOrEqual(1);
    for (const word of ["erfolgreich", "fehlgeschlagen", "übersprungen"]) expect(page).toContain(word);
  });

  test("what it did for you: two counted numbers and the latest effects, never for personal Code", () => {
    const page = text("overview");
    expect(page).toContain("Was sie für dich getan hat diese Woche");
    expect(page).toContain("41 Aufgaben angelegt");
    expect(page).toContain("44 Unterhaltungen sortiert");
    expect(html("overview")).toContain('<a href="/app/spaces/Lg8x2q">Aufgabe „Lieferung Polsterei Weber“ angelegt</a>');
    expect(text("personal")).not.toContain("Was sie für dich getan hat");
  });

  test("when it runs: schedule in words, what it does, last and next run, and run now", () => {
    const page = text("overview");
    expect(page).toContain("Wann sie läuft");
    expect(page).toContain("Alle 15 Minuten Trägt neue Lieferavise ein");
    expect(page).toContain("nächster Lauf in 11 Min.");
    expect(page).toContain("Montags um 07:00");
    expect(page).toContain("noch nie gelaufen");
    expect(page).toContain("Jetzt ausführen");
    expect(text("long")).toContain("4 weitere anzeigen");
  });

  test("what it may do: apps, the internet and its own data in one list, with the service account and no page", () => {
    const page = text("overview");
    expect(page).toContain("Was sie darf");
    expect(page).toContain("Aufgaben anlegen Spaces · Space Logistik");
    expect(page).toContain("bank.example und status.example aufrufen Internet · nur diese 2 Adressen, nur verschlüsselt");
    expect(page).toContain(
      "Läuft als Dienstkonto „Code von info@moebel-beispiel.de“. Ob sie ein Ziel wirklich erreicht, entscheidet, wer das Ziel verwaltet.",
    );
    expect(page).toContain("Sie hat keine eigene Seite und nimmt nichts von außen an.");
    expect(page).not.toContain("Seiten und Adressen");
    const pages = text("with-pages");
    expect(pages).toContain("Seiten und Adressen");
    expect(pages).toContain("Rückruf bestätigen");
    expect(pages).toContain("öffentlich");
    expect(pages).toContain("api.buchhaltung-beispiel.de aufrufen Internet · bekommt das Secret „BUCHHALTUNG_TOKEN“");
    expect(pages).toContain("Internet · ohne Secret");
    expect(pages).toContain("Eigene Daten merken Liest und schreibt nur in der eigenen Datenbank · 12 MB");
    expect(pages).not.toContain("Sie hat keine eigene Seite");
  });

  test("a new version: the approval card above the situation, its new trigger marked, Gustav no longer filled", () => {
    const page = text("new-version");
    expect(page).toContain("Version 5 von info@moebel-beispiel.de einschalten?");
    expect(page).toContain("Bis dahin bleibt Version 4 eingeschaltet.");
    expect(page).toContain("Läuft zusätzlich Mo–Fr um 08:00");
    expect(page).toContain("5 weitere bleiben gleich.");
    expect(page).toContain("3 von 3 Beispielen erfolgreich");
    expect(page).toContain("Version 5 einschalten");
    expect(page).toContain("ab Version 5, noch aus");
    const markup = html("new-version");
    expect(markup.indexOf("cloud-code__approval")).toBeLessThan(markup.indexOf("cloud-code__lage"));
  });

  test("changes requested: the administrator's message and Gustav's rework", () => {
    const page = text("changes-requested");
    expect(page).toContain("Version 5 braucht noch Änderungen.");
    expect(page).toContain("Jana Probe hat sie geprüft und noch nicht freigegeben. Version 4 bleibt eingeschaltet.");
    expect(page).toContain("Nachricht von Jana Probe");
    expect(page).toContain("Bitte so ändern, dass nur PDF-Anhänge im Ordner landen.");
    expect(page).toContain("Gustav überarbeiten lassen");
    expect(page).not.toContain("Version 5 einschalten");
  });

  test("needs you: the large state turns red, the notice says what happened with two next steps", () => {
    const page = text("needs-you");
    expect(page).toContain("Eingeschaltet, braucht dich");
    expect(page).toContain("Der Lauf ist fehlgeschlagen. Prüfe vor einer Wiederholung, was bis dahin passiert ist.");
    expect(page).toContain("Unterhaltungen lesen · 2 bestätigt · 1 Aufruf abgelehnt");
    expect(html("needs-you")).toContain('href="/app/spaces/Lg8x2q"');
    expect(page).toContain("Zugriff prüfen");
    expect(page).toContain("Lauf ansehen");
  });

  test("paused: brown state, resume in the head, no next run, every trigger paused, no host footer", () => {
    const page = text("paused");
    expect(page).toContain("Pausiert");
    expect(page).toContain("Version 4 · pausiert am 12.11.");
    expect(page).toContain("Fortsetzen");
    expect(page).toContain("Nächster Lauf pausiert");
    expect(page).toContain("Letzte 30 Läufe vor der Pause");
    expect(page).not.toContain("Jetzt ausführen");
    const data = codePageFixture("paused");
    const footer = () => "Vorhandene E-Mails nachholen";
    const paused = renderedText(
      renderMarkup(() => createComponent(CodePage, { data, footer: footer() })),
      " ",
    );
    expect(paused).not.toContain("Vorhandene E-Mails nachholen");
    const active = renderedText(
      renderMarkup(() => createComponent(CodePage, { data: codePageFixture("overview"), footer: footer() })),
      " ",
    );
    expect(active).toContain("Vorhandene E-Mails nachholen");
  });

  test("empty, loading and error keep the page's frame and say that nothing changed", () => {
    expect(text("empty")).toContain("Für info@moebel-beispiel.de gibt es noch keine Automation.");
    expect(text("empty")).toContain("Mit Gustav erstellen");
    expect(html("loading")).toContain('aria-busy="true"');
    expect(html("loading")).toContain("cloud-code__skel-strip");
    expect(text("error")).toContain("Die Code-Seite konnte nicht geladen werden.");
    expect(text("error")).toContain("Das Laden ändert nichts an der Automation.");
    expect(text("error")).toContain("Erneut versuchen");
  });
});

describe("Code page: runs (Bild 22)", () => {
  test("filters with counts, runs in words without numbers or code names, the selected run on the right", () => {
    const page = text("runs");
    expect(page).toContain("Alle 30");
    expect(page).toContain("Fehlgeschlagen 1");
    expect(page).toContain("Übersprungen 2");
    expect(page).toContain("Aufgaben anlegen · 3 bestätigt");
    expect(page).toContain("vor 4 Min. · nach Zeitplan");
    expect(page).toContain("Der vorige Lauf lief noch");
    expect(page).not.toContain("lieferungenEintragen");
    expect(page).not.toMatch(/#[0-9a-f]{6}/);
    expect(page).toContain("nach Zeitplan „Alle 15 Minuten“ · Version 4 · 2 Sekunden");
    expect(page).toContain("Was passiert ist");
    expect(html("runs")).toContain('data-phone="detail"');
    expect(html("runs-list")).toContain('data-phone="list"');
  });

  test("a failed run: notice with what happened, check access and run again, and the sentence about running again", () => {
    const page = text("run-failed");
    expect(page).toContain("Fehlgeschlagen");
    expect(page).toContain("Zugriff prüfen");
    expect(page).toContain("Lauf wiederholen …");
    expect(page).toContain("„Lauf wiederholen …“ startet einen neuen Lauf mit der Version, die dann eingeschaltet ist.");
  });

  test("empty, error and long", () => {
    expect(text("runs-empty")).toContain("Noch kein Lauf.");
    expect(text("runs-empty")).toContain("Der erste startet in 11 Min.");
    expect(text("runs-error")).toContain("Die Läufe konnten nicht geladen werden.");
    expect(text("runs-error")).toContain("Erneut versuchen");
    const long = text("runs-long");
    expect(long).toContain("Ältere Läufe laden");
    // Not every run is loaded, so the chips name their filter without a number.
    expect(long).not.toContain("Alle 30");
  });

  test("readers see that a run failed, never its calls", () => {
    const page = text("reader");
    expect(page).not.toContain("Lauf wiederholen");
    expect(page).not.toContain("Zugriff prüfen");
  });
});

describe("Code page: versions (Bilder 23, 24)", () => {
  test("the list: each version, who and when, its state in one word, and the hint to cld code pull", () => {
    const page = text("versions");
    for (const words of [
      "Version 5",
      "Bereit, noch aus",
      "Version 4",
      "Eingeschaltet",
      "Ersetzt",
      "Abgelehnt",
      "von Lea Muster · heute, 13:41",
    ])
      expect(page).toContain(words);
    expect(page).toContain("Den Code der eingeschalteten Version zeigt der Tab „Code“, nur zum Lesen.");
    expect(html("versions")).toContain("<code>cld code pull</code>");
  });

  test("a new version in words: approval card, Gustav's text marked, and examples with their result word; no code diff", () => {
    const page = text("versions");
    expect(page).toContain("Version 5 von info@moebel-beispiel.de einschalten?");
    expect(page).toContain("Was Gustav geändert hat");
    expect(page).toContain("von Gustav beschrieben, nicht von Cloud geprüft");
    expect(page).toContain("Beispiele 3 von 3 Beispielen erfolgreich");
    expect(page).toContain("Lieferavis ohne Anhang");
    expect(page).not.toContain("code.ts");
    expect(html("versions")).not.toContain("k2b-code-diff");
  });

  test("the running version, behaviour only, changes requested, rejected, first, error and long", () => {
    expect(text("versions-active")).toContain("Was sich an Zugriffen und Auslösern geändert hat");
    expect(text("versions-behavior")).toContain("Zugriffe gleich, Verhalten anders");
    expect(text("versions-changes")).toContain("Nachricht von Jana Probe");
    expect(text("versions-rejected")).toContain("Version 2 wurde abgelehnt.");
    expect(text("versions-rejected")).toContain("Begründung von Jana Probe");
    expect(text("versions-first")).toContain("Die erste Version. Es gibt nichts zu vergleichen.");
    expect(text("versions-list")).toContain("Wähle eine Version. Hier steht dann, was sie geändert hat.");
    expect(text("versions-error")).toContain("Diese Version konnte nicht geladen werden.");
    expect(text("versions-error")).toContain("Deine Auswahl bleibt.");
    expect(text("versions-long")).toContain("Ältere Versionen laden");
  });
});

describe("Code page: secrets (Bild 26)", () => {
  test("each secret with where it goes, whether a value is stored and what to do", () => {
    const page = text("secrets");
    expect(page).toContain("Ein Secret ist ein Passwort oder Schlüssel für einen fremden Dienst.");
    expect(page).toContain("Geht nur an api.buchhaltung-beispiel.de");
    expect(page).toContain("Hinterlegt");
    expect(page).toContain("geändert am 30.10. von Jana Probe");
    expect(page).toContain("Wert ersetzen");
    expect(page).toContain("Löschen");
    expect(page).toContain("Secret anlegen");
    const missing = text("secrets-missing");
    expect(missing).toContain("Kein Wert");
    expect(missing).toContain("Läufe, die ihn brauchen, schlagen fehl");
    expect(missing).toContain("Wert eintragen");
  });

  test("refused, unclear, empty, error and long; unclear never offers to try again", () => {
    expect(text("secrets-refused")).toContain("Cloud hat den neuen Wert abgelehnt. Für BUCHHALTUNG_TOKEN gilt weiter der bisherige Wert.");
    expect(text("secrets-refused")).toContain("Wert noch einmal eintragen");
    const unclear = text("secrets-unknown");
    expect(unclear).toContain("Cloud weiß noch nicht, ob der neue Wert gespeichert ist.");
    expect(unclear).toContain("Stand prüfen");
    expect(unclear).not.toContain("Erneut versuchen");
    expect(text("secrets-empty")).toContain("Diese Automation braucht kein Secret.");
    expect(text("secrets-error")).toContain("Erneut versuchen");
    expect(text("secrets-long")).toContain("6 weitere anzeigen");
  });
});

describe("Code page: personal Code (CODE_P)", () => {
  test("its own name with the state, your Code, no counted effects, and runs as you", () => {
    const page = text("personal");
    expect(page).toContain("Wochenbericht Vertrieb Eingeschaltet");
    expect(page).toContain("Dein Code · Version 2");
    expect(page).toContain("Läuft als du, mit deinen Rechten und nicht mehr.");
    expect(page).not.toContain("Dienstkonto");
    expect(text("personal-needs-you")).toContain("Eingeschaltet, braucht dich");
    expect(text("personal-error")).toContain("Diese Automation konnte nicht geladen werden.");
    expect(html("personal-loading")).toContain('aria-busy="true"');
  });
});

test.each(["de", "en"])("%s: no state shows source, identifiers or an unqualified status word", (locale) => {
  // The code tab is the one place for source (3p); its field carries its own exemption.
  for (const state of CODE_PAGE_FIXTURE_STATES.filter((name) => name !== "code")) {
    const visible = renderedText(
      new HTMLRewriter().on("script", { element: (element) => void element.remove() }).transform(html(state, locale)),
      "\n",
    );
    expect(codeSurfaceFindings(`${locale}/${state}`, visible)).toEqual([]);
    for (const word of ["Passt", "Fertig", "Done", "OK"]) expect(visible.split(/\s+/)).not.toContain(word);
  }
});

test("English copy", () => {
  const page = text("overview", "en");
  expect(page).toContain("Switched on");
  expect(page).toContain("What it may do");
  expect(page).toContain("When it runs");
  expect(text("needs-you", "en")).toContain("Switched on, needs you");
});

describe("Code page helpers", () => {
  test("a target is described from its type in the registry: type title, icon and a link only for a pattern with just :id", async () => {
    const library = {
      appId: "library",
      appName: "Library",
      appIcon: "ti ti-books",
      appDescription: "Books",
      manifest: {
        ...currentLibrary.manifest,
        resourcePages: [
          { type: "book", path: "/app/library/books/:id" },
          { type: "author", path: "/app/library/:shelf/authors?author=:id" },
        ],
      },
    };
    const catalog = async () => ({ ok: true as const, data: library });
    expect(await describeTarget({ type: "library.book", id: "b 1" }, { codeId: "c1" }, catalog)).toEqual({
      key: "library.book\u0000b 1",
      ref: { type: "library.book", id: "b 1" },
      title: null,
      typeTitle: "Book",
      icon: null,
      own: false,
      href: "/app/library/books/b%201",
    });
    // An author's page also needs its shelf: the reference alone cannot fill it, so only the ID shows.
    expect(await describeTarget({ type: "library.author", id: "a1" }, { codeId: "c1" }, catalog)).toMatchObject({ href: null });
    // A type without pages, an unknown app and a broken registry leave the ID only.
    expect(await describeTarget({ type: "library.shelf", id: "s1" }, { codeId: "c1" }, catalog)).toMatchObject({
      href: null,
      typeTitle: "Shelf",
    });
    expect(await describeTarget({ type: "library.book", id: "b1" }, { codeId: "c1" }, async () => null)).toMatchObject({
      title: null,
      typeTitle: null,
      href: null,
    });
    expect(cloudResourcePageHref("/app/spaces/:id", "k7qm2x9a")).toBe("/app/spaces/k7qm2x9a");
    expect(cloudResourcePageHref("/app/spaces/:space?item=:id", "it_1")).toBeNull();
    expect(cloudResourcePageHref("/app/files?file=:id", "a/b")).toBe("/app/files?file=a%2Fb");
  });

  test("the page's own attention follows Core's rule: failed run or pending approval", () => {
    expect(codePageNeedsAttention(codePageFixture("overview").state)).toBe(false);
    expect(codePageNeedsAttention(codePageFixture("refused").state)).toBe(true);
    expect(codePageNeedsAttention(codePageFixture("approval").state)).toBe(true);
    expect(codePageNeedsAttention(codePageFixture("paused").state)).toBe(false);
  });

  test("Core down, failing or slow: no dot and no error, within the timeout", async () => {
    const c = { req: { raw: { signal: new AbortController().signal }, header: () => undefined } } as unknown as Context;
    const ref = { type: "mail.mailbox", id: "Mb4kd2" };
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as CodePageInvoke;
    expect(await loadCodeAttention(c, ref, { invoke: down })).toBeNull();
    const refused = (async () => ({ ok: false, error: { code: "APP_UNAVAILABLE", message: "down", status: 503 } })) as CodePageInvoke;
    expect(await loadCodeAttention(c, ref, { invoke: refused })).toBeNull();
    const hanging = (() => new Promise(() => {})) as CodePageInvoke;
    const started = performance.now();
    expect(await loadCodeAttention(c, ref, { invoke: hanging, timeoutMs: 50 })).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
    const answer =
      (items: Array<{ codeId: string; reasons: string[] }>): CodePageInvoke =>
      async (_invocation, schema) => ({ ok: true, data: capabilityResultSchema(schema).parse({ data: { items } }) });
    expect(await loadCodeAttention(c, ref, { invoke: answer([]) })).toEqual({ visible: false, attention: false });
    expect(await loadCodeAttention(c, ref, { invoke: answer([{ codeId: "c_3mfa", reasons: [] }]) })).toEqual({
      visible: true,
      attention: false,
    });
    expect(await loadCodeAttention(c, ref, { invoke: answer([{ codeId: "c_3mfa", reasons: ["access_missing"] }]) })).toEqual({
      visible: true,
      attention: true,
    });
  });

  test("a permission without a target is an app-wide grant, as Core plans it", () => {
    expect(permissionRef({ operation: "spaces.space.list", target: null })).toEqual({ type: "app", id: "spaces" });
    expect(permissionRef({ operation: "spaces.task.create", target: { type: "spaces.space", id: "sp_2lg8" } })).toEqual({
      type: "spaces.space",
      id: "sp_2lg8",
    });
    expect(permissionRef({ operation: "spaces.task.create", target: { type: "spaces.space", id: null } })).toBeNull();
  });

  test("guests see only their own name, like in directory search", () => {
    const me = "00000000-0000-4000-8000-0000000000a1";
    const other = "00000000-0000-4000-8000-0000000000b1";
    expect(visiblePersonIds([me, other, null, "not-a-uuid"], { id: me, directory: true })).toEqual([me, other]);
    expect(visiblePersonIds([me, other], { id: me, directory: false })).toEqual([me]);
  });

  test("a failed run's detail reads further calls until its first action", async () => {
    const calls = [...Array.from({ length: 23 }, () => "query" as const), "action" as const, "query" as const];
    const reads: number[] = [];
    const invoke: CodePageInvoke = async (invocation, schema) => {
      const cursor = (invocation.input as { cursor: number }).cursor;
      reads.push(cursor);
      const kind = calls[cursor];
      return {
        ok: true,
        data: capabilityResultSchema(schema).parse({
          data: {
            run: {
              id: "00000000-0000-4000-8000-000000000099",
              versionId: "00000000-0000-4000-8000-000000000004",
              trigger: "schedule",
              entrypoint: "lieferungenEintragen",
              state: "failed",
              outcome: "failed",
              createdAt: "2026-11-01T08:30:00.000Z",
              startedAt: null,
              endedAt: null,
            },
            contents: {
              input: null,
              inputChunked: false,
              content: null,
              calls: kind
                ? [{ ordinal: cursor + 1, kind, capability: "mail.conversation.list", call: null, result: null, state: "succeeded" }]
                : [],
              nextCursor: cursor + 1 < calls.length ? cursor + 1 : null,
            },
          },
        }),
      };
    };
    const result = await loadCodeRunCallsForDetail(invoke, "c_3mfa", "00000000-0000-4000-8000-000000000099");
    expect(result?.calls.some((call) => call.kind === "action")).toBe(true);
    expect(Math.max(...reads)).toBeLessThan(40);
  });

  test("schedules read as short sentences and fall back to the expression", () => {
    expect(describeCodeSchedule("0 8 * * 1-5", "de")).toBe("Mo–Fr 08:00");
    expect(describeCodeSchedule("30 6 * * *", "en")).toBe("daily 06:30");
    expect(describeCodeSchedule("0 7 1 * *", "de")).toBe("am 1. jedes Monats 07:00");
    expect(describeCodeSchedule("5 * * * *", "de")).toBe("stündlich zur Minute 5");
    expect(describeCodeSchedule("0 7 * 1 *", "de")).toBe("0 7 * 1 *");
  });

  test("call results become one short line, preferring an error message", () => {
    const reserved = { ok: false, error: { code: "code_ai_budget_reserved" } };
    expect(summarizeCallResult(reserved, "en")).toContain("Wait for that call");
    expect(summarizeCallResult(reserved, "de-CH")).toContain("Warte vor einem neuen Aufruf");
    const budget = { ok: false, error: { code: "code_ai_budget_limit" } };
    expect(summarizeCallResult(budget, "en")).toContain("No AI call was started");
    expect(summarizeCallResult(budget, "de-CH")).toContain("Es wurde kein KI-Aufruf gestartet");
    for (const code of ["code_ai_daily_budget_limit", "code_ai_owner_daily_budget_limit"]) {
      expect(summarizeCallResult({ ok: false, error: { code } }, "en")).toContain("next installation calendar day");
      expect(summarizeCallResult({ ok: false, error: { code } }, "de-CH")).toContain("Kalendertag der Installation");
    }
    expect(summarizeCallResult({ error: { code: "FORBIDDEN", message: "Zugriff entfernt" } })).toBe("Zugriff entfernt");
    expect(summarizeCallResult({ id: "t_1" })).toBe('{"id":"t_1"}');
    expect(summarizeCallResult("x".repeat(400))?.length).toBe(160);
    expect(summarizeCallResult(null)).toBeNull();
  });
});

describe("Code page loader", () => {
  const V4 = "00000000-0000-4000-8000-000000000004";
  const RUN = "2284a1b2-0000-4000-8000-000000000004";
  const space = { type: "spaces.space", id: "k7qm2x9a" };
  const manifest = {
    entrypoints: [{ kind: "schedule", entrypoint: "lieferungenEintragen", cron: "0 8 * * 1-5" }],
    permissions: [
      { operation: "spaces.task.create", target: space, file: "code.ts", line: 3 },
      { operation: "spaces.task.update", target: { type: "spaces.task", id: "it_7f3k" }, file: "code.ts", line: 4 },
    ],
  };
  const failedRun = {
    id: RUN,
    versionId: V4,
    trigger: "schedule",
    entrypoint: "lieferungenEintragen",
    state: "failed",
    outcome: "failed",
    firstRefusedCallOrdinal: 2 as number | null,
    createdAt: "2026-11-01T08:30:00.000Z",
    startedAt: null,
    endedAt: null,
  };
  /** A version in words, as Core's read model answers: only the fields the schema requires. */
  const versionWords = (versionId: string) => ({
    versionId,
    number: 4,
    submittedAt: "2026-10-28T09:00:00.000Z",
    locale: "de",
    description: { state: "visible", text: "Legt werktags Aufgaben im Space Logistik an.", modelLabel: "" },
    assurance: "Cloud begrenzt die Zugriffe auf die Apps und Ziele dieser Version.",
    mayDo: { items: [{ text: "Aufgabe erstellen · Space Logistik", app: "Spaces" }], more: 0, moreText: null },
    timing: { items: [{ text: "Mo–Fr 08:00" }], more: 0, moreText: null },
    changes: {
      state: "first",
      text: "Erste Version",
      rows: { items: [{ kind: "same", text: "Aufgabe erstellen · Space Logistik" }], more: 0, moreText: null },
      assurance: "Cloud prüft Zugriffe und Auslöser, nicht das Verhalten.",
    },
    examples: { state: "none", passed: 0, total: 0, summary: "Keine Beispiele", explanation: "", items: [] },
    notices: { items: [], more: 0, moreText: null },
  });
  /** Core as the page reads it; every other app answers with an error, so any call to one would show. */
  /** A policy refusal before the target refusal, as Core lists calls one per read. */
  const policyCall = {
    ordinal: 1,
    kind: "action",
    capability: "spaces.comment.create",
    refusalKind: "policy",
    call: null,
    result: { ok: false, error: { code: "code_policy_never" } },
    state: "failed",
  };
  const core =
    (permission: "editor" | "reader", run: typeof failedRun, firstCall = policyCall, checkedManifest: unknown = manifest) =>
    (capabilityId: string, input: { content?: unknown; cursor?: number; versionId?: string }) => {
      if (capabilityId === "code.version.words") return versionWords(input.versionId ?? V4);
      if (capabilityId === "code.list")
        return {
          items: [{ id: "c_3mfa", title: "Code", state: "active", activeVersionId: V4, pauseReason: null, permission }],
          nextCursor: null,
        };
      if (capabilityId === "code.version.list")
        return {
          items: [
            { version: { id: V4, number: 4, createdBy: null, createdAt: "2026-10-28T09:00:00.000Z" }, status: "approved", decision: null },
          ],
          nextBefore: null,
        };
      if (capabilityId === "code.version.read")
        return {
          version: { id: V4, number: 4, createdBy: null, createdAt: "2026-10-28T09:00:00.000Z" },
          content: input.content ? { text: JSON.stringify(checkedManifest), nextOffset: null } : null,
        };
      if (capabilityId === "code.run.list") return { items: [run], nextCursor: null };
      if (capabilityId === "code.run.read")
        return {
          run,
          contents:
            permission === "editor"
              ? {
                  input: null,
                  inputChunked: false,
                  content: null,
                  calls: (input.cursor ?? 0) === 0 ? [firstCall] : [],
                  nextCursor: null,
                  firstRefusedCall: run.firstRefusedCallOrdinal
                    ? { ordinal: 2, kind: "action", capability: "spaces.task.create", target: space }
                    : null,
                }
              : null,
        };
      return { items: [] };
    };
  const registry = {
    spaces: {
      appId: "spaces",
      appName: "Spaces",
      appIcon: "ti ti-layout-kanban",
      appDescription: "Spaces",
      manifest: {
        ...currentLibrary.manifest,
        appId: "spaces",
        types: [
          { localId: "space", title: "Space", description: "One space.", icon: "ti ti-layout-kanban" },
          { localId: "task", title: "Aufgabe", description: "One task." },
        ],
        actions: [{ ...currentLibrary.manifest.actions[0]!, localId: "task.create", title: "Aufgabe erstellen" }],
        queries: [],
        resourcePages: [
          { type: "space", path: "/app/spaces/:id" },
          { type: "task", path: "/app/spaces/:space?item=:id" },
        ],
      },
    },
  };
  const load = async (
    permission: "editor" | "reader",
    query = "",
    run = failedRun,
    firstCall = policyCall,
    checkedManifest: unknown = manifest,
    cloudTimeZone?: string,
    roles: string[] = ["user"],
  ) => {
    const appCalls: string[] = [];
    const coreCalls: string[] = [];
    const invoke = spyOn(capabilityServer, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
      if (invocation.appId !== "core") {
        appCalls.push(`${invocation.appId}.${invocation.capabilityId}`);
        return { ok: false, error: { code: "APP_UNAVAILABLE", message: "Another app was asked", status: 503 } };
      }
      coreCalls.push(invocation.capabilityId);
      const data = core(
        permission,
        run,
        firstCall,
        checkedManifest,
      )(invocation.capabilityId, invocation.input as { content?: unknown; cursor?: number; versionId?: string });
      return { ok: true, data: capabilityResultSchema(schema).parse({ data }) };
    });
    const catalog = spyOn(capabilityServer, "getCapabilityCatalogApp").mockImplementation(async (appId) => ({
      ok: true,
      data: appId === "spaces" ? registry.spaces : null,
    }));
    const fetched = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          throw new Error("The Code page fetched something");
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const request = new Request(`https://cloud.test/app/mail/Mb4kd2/code${query}`, {
      headers: cloudTimeZone ? { Cookie: "cloud.timezone=Pacific/Auckland" } : {},
    });
    const variables: Record<string, unknown> = {
      settings: { app: { timezone: cloudTimeZone } },
      actor: { kind: "user", sessionKind: "web" },
      credentialKind: "session",
      user: { id: "00000000-0000-4000-8000-0000000000a1", roles },
      runtime: { apps: [] },
    };
    const c = {
      req: { url: request.url, raw: request, header: (name: string) => request.headers.get(name) ?? undefined },
      get: (key: string) => variables[key],
    } as unknown as Context;
    try {
      const data = await loadCodePage(c, {
        owner: { ref: { type: "mail.mailbox", id: "Mb4kd2" }, title: "info@moebel-beispiel.de" },
        href: "/app/mail/Mb4kd2/code",
        canManageOwner: permission === "editor",
      });
      return { data, appCalls, coreCalls, fetches: fetched.mock.calls.length };
    } finally {
      invoke.mockRestore();
      catalog.mockRestore();
      fetched.mockRestore();
    }
  };

  test("an omitted schedule zone displays the Cloud default even with a different visitor zone", async () => {
    const at = "2026-12-01T09:15:30Z";
    const { data } = await load(
      "editor",
      "",
      failedRun,
      policyCall,
      {
        ...manifest,
        entrypoints: [{ kind: "schedule", entrypoint: "lieferungenEintragen", cron: null, at }],
      },
      "America/New_York",
    );
    if (data.state.kind !== "ready") throw new Error("Expected ready page");
    expect(data.state.automations?.[0]).toMatchObject({ at, timeZone: "America/New_York" });
    // Core's read model names the timing; without it the page says the same instant with its zone itself.
    data.state.automations![0]!.timingText = undefined;
    const markup = renderMarkup(() => createComponent(CodePage, { data }));
    expect(markup).toContain("(America/New_York)");
    expect(markup).not.toContain("(undefined)");
  });

  for (const locale of ["de", "en"]) {
    test(`${locale}: an exhausted attempt budget has its own run notice`, async () => {
      const { data } = await load(
        "editor",
        `?tab=runs&run=${RUN}`,
        { ...failedRun, firstRefusedCallOrdinal: null },
        { ...policyCall, capability: "core.ai.decide", result: { ok: false, error: { code: "code_ai_budget_limit" } } },
      );
      if (data.state.kind !== "ready") throw new Error("Expected ready page");
      expect(data.state.run?.refusal).toMatchObject({ code: "code_ai_budget_limit" });
      const markup = renderMarkup(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(CodePage, { data });
          },
        }),
      );
      expect(markup).toContain(
        locale === "de" ? "KI-Budget dieses Code-Versuchs ist verbraucht" : "Code AI budget for this attempt is spent",
      );
      expect(markup).not.toContain(locale === "de" ? "Die Richtlinie erlaubt das nicht" : "The policy does not allow this");
      expect(markup).not.toContain(locale === "de" ? "Die Richtlinie für Code legt" : "The Cloud admin sets the policy");
    });
  }

  test("an editor reads the refused call once at Core; the page asks no other app and names targets by type and ID", async () => {
    const { data, appCalls, coreCalls, fetches } = await load("editor");
    expect(appCalls).toEqual([]);
    expect(fetches).toBe(0);
    // One read of the refused run at Core, however many targets the page lists.
    expect(coreCalls.filter((call) => call === "code.run.read")).toEqual(["code.run.read"]);
    if (data.state.kind !== "ready") throw new Error(`Expected a ready page, got ${data.state.kind}`);
    expect(data.state.refusal).toEqual({
      kind: "target_refused",
      runId: RUN,
      versionId: V4,
      call: {
        capability: "spaces.task.create",
        title: "Aufgabe erstellen",
        target: {
          key: "spaces.space\u0000k7qm2x9a",
          ref: space,
          title: null,
          typeTitle: "Space",
          icon: "ti ti-layout-kanban",
          own: false,
          href: "/app/spaces/k7qm2x9a",
        },
      },
    });
    // A task's page needs its space too, so it is listed by ID only.
    expect(data.state.targets?.find((row) => row.target.ref.type === "spaces.task")?.target).toMatchObject({ href: null, title: null });
    expect(JSON.stringify(data)).not.toContain('"missing"');
  });

  test("the run's detail names the same recorded target refusal as the overview, even after an earlier policy refusal", async () => {
    const { data, appCalls } = await load("editor", `?tab=runs&run=${RUN}`);
    expect(appCalls).toEqual([]);
    if (data.state.kind !== "ready") throw new Error(`Expected a ready page, got ${data.state.kind}`);
    expect(data.state.run?.refusal).toMatchObject({
      kind: "target_refused",
      call: { capability: "spaces.task.create", target: { ref: space } },
    });
  });

  test("a successful run whose refused call the code caught raises no notice and reads nothing more", async () => {
    const { data, appCalls, coreCalls } = await load("editor", "", { ...failedRun, state: "succeeded", outcome: "succeeded" });
    expect(appCalls).toEqual([]);
    expect(coreCalls).not.toContain("code.run.read");
    if (data.state.kind !== "ready") throw new Error(`Expected a ready page, got ${data.state.kind}`);
    expect(data.state.refusal).toBeNull();
  });

  test("a reader's page data carries no target ID of the refused call", async () => {
    const { data, appCalls } = await load("reader");
    expect(appCalls).toEqual([]);
    if (data.state.kind !== "ready") throw new Error(`Expected a ready page, got ${data.state.kind}`);
    expect(data.state.refusal).toEqual({ kind: "target_refused", runId: RUN, versionId: V4, call: null });
    // Targets from the reviewed manifest stay: readers may read the version's source, which names them anyway.
    // Operation titles name only operations those rows show, never the refused call.
    const shown = new Set([
      ...(data.state.targets ?? []).flatMap((row) => [...row.operations, ...row.newOperations]),
      ...(data.state.waitingTargets ?? []).flatMap((row) => row.operations),
      ...(data.state.diff?.permissions ?? []).map((permission) => permission.operation),
    ]);
    expect(Object.keys(data.state.operationLabels).filter((operation) => !shown.has(operation))).toEqual([]);
    const serialized = JSON.stringify({ ...data.state, targets: null, diff: null, waitingTargets: null, operationLabels: {} });
    expect(serialized).not.toContain("k7qm2x9a");
    expect(serialized).not.toContain("spaces.task.create");
  });

  test("the known path ?tab=versions&version= still opens that version, now in words, without reading its source", async () => {
    const { data, coreCalls } = await load("editor", `?tab=versions&version=${V4}`);
    if (data.state.kind !== "ready") throw new Error(`Expected a ready page, got ${data.state.kind}`);
    expect(data.tab).toBe("versions");
    expect(data.state.diff?.version.id).toBe(V4);
    expect(data.state.versionSelected).toBe(true);
    expect(data.state.words?.selected?.versionId).toBe(V4);
    expect(coreCalls).toContain("code.version.words");
    expect(coreCalls).not.toContain("code.version.diff");
    const page = renderedText(
      renderMarkup(() =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(CodePage, { data });
          },
        }),
      ),
      " ",
    );
    expect(page).toContain("Version 4");
    expect(page).toContain("Die erste Version. Es gibt nichts zu vergleichen.");
    expect(page).toContain("Aufgabe erstellen · Space Logistik");
    expect(page).not.toContain("code.ts");
    expect(page).not.toContain("Diese Version konnte nicht geladen werden.");
  });

  test("the overview reads the Code in words: running version, this week's effects and the last run", async () => {
    const { data, coreCalls } = await load("editor");
    if (data.state.kind !== "ready") throw new Error(`Expected a ready page, got ${data.state.kind}`);
    expect(coreCalls).toContain("code.version.words");
    expect(coreCalls).toContain("code.activity.words");
    expect(coreCalls.filter((call) => call === "code.run.words")).toEqual(["code.run.words"]);
    expect(data.state.words?.current?.versionId).toBe(V4);
    // Each automation carries its timing in words from the same read model.
    expect(data.state.automations?.[0]?.timingText).toBe("Mo–Fr 08:00");
  });

  test("?tab=code is for editors: a reader lands on the overview, an editor gets the code tab's own data", async () => {
    const reader = await load("reader", "?tab=code");
    expect(reader.data.tab).toBe("overview");
    expect(reader.coreCalls).not.toContain("code.source.tab");
    const editor = await load("editor", "?tab=code");
    expect(editor.data.tab).toBe("code");
    if (editor.data.state.kind !== "ready") throw new Error("Expected a ready page");
    expect(editor.data.state.sourceTab).not.toBeUndefined();
  });

  test("F30: a Cloud admin without the editor right gets no code tab and no source, like any reader", async () => {
    // Core answers a Cloud admin who does not edit this Code as a reader; the page never widens that.
    const admin = await load("reader", "?tab=code", failedRun, policyCall, manifest, undefined, ["user", "admin"]);
    expect(admin.data.cloudAdmin).toBe(true);
    expect(admin.data.tab).toBe("overview");
    expect(admin.coreCalls).not.toContain("code.source.tab");
    const markup = renderMarkup(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(CodePage, { data: admin.data });
        },
      }),
    );
    expect(markup).not.toContain("?tab=code");
    expect(markup).not.toContain("data-code-source-region");
    expect(markup).not.toContain("k2b-code-diff");
  });

  test("a failed read model is a part that did not load, never an empty one", async () => {
    const { data } = await load("editor", "", failedRun, policyCall, manifest);
    if (data.state.kind !== "ready") throw new Error("Expected a ready page");
    // The mock answers the activity read model with nothing it can parse.
    expect(data.state.words?.activity).toBeNull();
    const page = renderedText(
      renderMarkup(() => createComponent(CodePage, { data })),
      " ",
    );
    expect(page).toContain("This part could not be loaded. Nothing changes for the automation.");
  });
});

test("the real Code page loader retains the handle before the first run", async () => {
  const unavailable = { ok: false as const, error: { code: "UNAVAILABLE", message: "Not needed", status: 503 as const } };
  const catalog = spyOn(capabilityProvider, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: null });
  const origin = spyOn(coreLocation, "coreOrigin").mockResolvedValue("http://core.test");
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No app calls in fixture"));
  const invoke = spyOn(capabilityProvider, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
    if (invocation.capabilityId !== "code.list") return unavailable;
    return {
      ok: true,
      data: capabilityResultSchema(schema).parse({
        data: {
          items: [
            {
              id: "c_fixture",
              title: "Code",
              serviceAccountHandle: "code-7k2q9m4xwt",
              state: "draft",
              activeVersionId: null,
              pauseReason: null,
              permission: "editor",
            },
          ],
          nextCursor: null,
        },
      }),
    };
  });
  try {
    const routes = new Hono().get("/code", async (c) =>
      c.json(
        await loadCodePage(c, {
          owner: { ref: { type: "demo.item", id: "fixture" }, title: "Fixture" },
          href: "/code",
          canManageOwner: true,
        }),
      ),
    );
    const response = await routes.request("http://example.test/code");
    const page = await response.json();
    expect(page.state.kind).toBe("ready");
    expect(page.state.code.serviceAccountHandle).toBe("code-7k2q9m4xwt");
    expect(page.owner).not.toHaveProperty("handle");
  } finally {
    invoke.mockRestore();
    catalog.mockRestore();
    origin.mockRestore();
    network.mockRestore();
  }
});

test("a legacy version entry shows the reconfirmation hint", () => {
  const fixture = codePageFixture("overview");
  if (fixture.state.kind !== "ready") throw new Error("Expected ready fixture");
  fixture.state.code.needsReconfirmation = true;
  const rendered = renderMarkup(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(CodePage, { data: fixture });
      },
    }),
  );
  expect(rendered).toContain("Neu bestätigen");
  expect(rendered).toContain("Beim Wechsel pausiert der alte Eintrag.");
});

test("failed event delivery remains visible by its event and only an active editor can retry it", () => {
  const page = (permission: "editor" | "reader", state: "active" | "paused", outcome = "code_event_backlog_full") => {
    const data = codePageFixture("runs", "en");
    if (data.state.kind !== "ready") throw new Error("Missing ready fixture");
    data.state.permission = permission;
    data.state.code.state = state;
    data.state.runs = {
      ...data.state.runs!,
      eventDeliveries: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          eventId: "22222222-2222-4222-8222-222222222222",
          eventType: "fixture.changed",
          state: "failed",
          code: outcome,
          attempts: 8,
          createdAt: "2026-11-14T12:00:00Z",
        },
      ],
    };
    return renderMarkup(() =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(CodePage, { data });
        },
      }),
    );
  };
  const markup = page("editor", "active");
  // Named by what happened, never by its type or a stable code.
  expect(markup).not.toContain("fixture.changed");
  expect(markup).not.toContain("code_event_backlog_full");
  expect(markup).toContain("Delivery failed");
  expect(markup).toContain("Retry delivery");
  expect(page("reader", "active")).not.toContain("Retry delivery");
  expect(page("editor", "paused")).not.toContain("Retry delivery");
  const revoked = page("editor", "active", "resource_access_revoked");
  expect(revoked).toContain("can no longer read the event place");
  expect(revoked).toContain("Retry delivery");
});

test.each(["de", "en"])("Code page shows database use, storage and export in what it may do in %s", (locale) => {
  const data = codePageFixture("overview", locale);
  if (data.state.kind !== "ready") throw new Error("Missing fixture");
  data.state.databaseUsed = true;
  data.state.code.database = {
    bytes: 1048576,
    limit: 104857600,
    state: "ready",
    canExport: true,
    owner: { reserved: 209715200, limit: 1048576000 },
  };
  const markup = () =>
    renderMarkup(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(CodePage, { data });
        },
      }),
    );
  const page = renderedText(markup(), " ");
  expect(page).toContain(locale === "de" ? "Eigene Daten merken" : "Remember its own data");
  expect(page).toContain(locale === "de" ? "Datenbank: 1,00 MB von 100,00 MB" : "Database: 1.00 MB of 100.00 MB");
  expect(page).toContain(
    locale === "de"
      ? "Reservierte Kapazität des Besitzers: 200,00 MB von 1.000,00 MB"
      : "Owner reserved capacity: 200.00 MB of 1,000.00 MB",
  );
  expect(markup()).toContain(`/api/code/authoring/database/${data.state.code.id}/export`);
  data.state.code.database.canExport = false;
  expect(markup()).not.toContain(`/api/code/authoring/database/${data.state.code.id}/export`);
});

test.each(["de", "en"])("an unused database keeps its deletion date and confirmed delete control in %s", (locale) => {
  const data = codePageFixture("overview", locale);
  if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
  data.state.code.database = {
    bytes: 4096,
    limit: 104857600,
    state: "ready",
    canExport: true,
    unused: {
      since: "2026-11-01T12:00:00.000Z",
      deleteAt: "2026-12-01T12:00:00.000Z",
      namespace: "code_c_test_incarnation",
      canDelete: true,
    },
  };
  const markup = renderMarkup(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodePage, { data });
      },
    }),
  );
  expect(markup).toContain(locale === "de" ? "Diese Datenbank wird am" : "This database will be deleted on");
  expect(markup).toContain(locale === "de" ? "Jetzt löschen" : "Delete now");
});

// 6b: "Next run" sits in a fixed 10.5rem column at 18 px; each word for a missing next run fits it whole (#66).
test("every word for a missing next run fits the situation's first column", () => {
  for (const locale of ["de", "en"]) {
    const t = codePageMessages.resolve([locale]).t;
    for (const word of [t.nextNone, t.nextUnknown, t.nextPaused]) expect(word.length).toBeLessThanOrEqual(14);
  }
});

// #65: Core names a recent result by kind only; the page reads each target with the reader's rights. A target the
// reader may open shows its name and link; one they may not keeps the kind-only sentence, without link or ID.
test("what it did for you names only the results the reader may read", async () => {
  const fixture = codePageFixture("overview");
  if (fixture.state.kind !== "ready" || !fixture.state.words?.activity) throw new Error("Expected ready fixture");
  const result = (id: string) => ({
    text: "Aufgabe angelegt",
    app: "Spaces",
    icon: "tabler:layout-kanban",
    state: "succeeded" as const,
    at: "2026-11-14T10:00:00.000Z",
    runId: "44444444-4444-4444-8444-444444444444",
    target: { ref: { type: "spaces.item", id }, text: "Aufgabe „{name}“ angelegt" },
  });
  const invoke: CodePageInvoke = async (invocation, schema) =>
    (invocation.input as { id: string }).id === "UxrUVC"
      ? {
          ok: true,
          data: capabilityResultSchema(schema).parse({
            data: { view: { title: "Lieferung Polsterei Weber", permission: "read" } },
            links: [{ rel: "open", href: "/app/spaces/GPzX93/UxrUVC" }],
          }),
        }
      : { ok: false, error: { code: "FORBIDDEN", message: "Hidden", status: 403 } };
  fixture.state.words.activity.recent = await nameRecentResults([result("UxrUVC"), result("HidN3x")], invoke, () => "item.read");
  const markup = renderMarkup(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(CodePage, { data: fixture });
      },
    }),
  );
  expect(markup).toContain('<a href="/app/spaces/GPzX93/UxrUVC">Aufgabe „Lieferung Polsterei Weber“ angelegt</a>');
  const feed = markup.slice(markup.indexOf("cloud-code__feed"));
  expect(feed).toMatch(/<span class="cloud-code__feed-text">Aufgabe angelegt<\/span>/);
  expect(markup).not.toMatch(/HidN3x|\{name\}/);
});
