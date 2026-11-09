import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Context, Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { renderedText, withoutComments } from "../../../../../scripts/fixtures/rendered-markup";
import { currentLibrary } from "../../../test/future-capability-manifest";
import * as capabilityProvider from "../../capabilities/server";
import { capabilityResultSchema } from "../../contracts/capabilities";
import { cloudResourcePageHref } from "../../contracts/resource-pages";
import * as coreLocation from "../../services/identity/core-origin";
import { loadCodeRunCallsForDetail, summarizeCallResult } from "./calls";
import { codePageFixture } from "./code-page.fixture";
import type { CodePageInvoke } from "./data";
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

type State = Parameters<typeof codePageFixture>[0];
const html = (state: State, locale = "de") =>
  renderMarkup(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodePage, { data: codePageFixture(state, locale) });
      },
    }),
  );
const text = (state: State, locale = "de") =>
  renderedText(html(state, locale), " ")
    .replaceAll(/\s+/g, " ")
    // A sentence may end right after a linked ID.
    .replaceAll(/ \./g, ".");

// Refusal actions belong to the notice; the account line always keeps its ordinary copy action.
const refusalMarkup = (state: State) => {
  const markup = html(state);
  const start = markup.indexOf('<div class="cloud-code__refusal">');
  const end = markup.indexOf("</section>", start);
  if (start < 0 || end < 0) throw new Error(`Missing refusal notice in ${state}`);
  return markup.slice(start, end);
};

const personal = (state: State, locale = "de") =>
  renderedText(
    renderMarkup(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(CodePage, {
            data: {
              ...codePageFixture(state, locale),
              owner: { kind: "person", ref: null, title: state === "error" ? "" : "Wochenbericht Vertrieb", typeTitle: null },
              href: "/app/assistant/code/c_woche1",
            },
          });
        },
      }),
    ),
    " ",
  ).replaceAll(/\s+/g, " ");

describe("personal Code", () => {
  test("leads with its own title, runs as its person and never lists target access", () => {
    const page = personal("overview");
    expect(page).toContain("Wochenbericht Vertrieb");
    expect(page).toContain("Dein Code · läuft als du");
    expect(page).toContain("Er nutzt deine Rechte, nicht mehr.");
    expect(page).not.toContain("Handelt im Namen von");
    expect(page).not.toContain("an info@moebel-beispiel.de selbst");
  });
  test("someone else's shared personal Code names whose rights it runs with", () => {
    const shared = renderedText(
      renderMarkup(() =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(CodePage, {
              data: {
                ...codePageFixture("overview", "de"),
                owner: { kind: "person", ref: null, title: "Wochenbericht Vertrieb", typeTitle: null, runsAs: { name: "Lea Muster" } },
                href: "/app/assistant/code/c_woche1",
              },
            });
          },
        }),
      ),
      " ",
    ).replaceAll(/\s+/g, " ");
    expect(shared).toContain("Code von Lea Muster · läuft als Lea Muster");
    expect(shared).toContain("Er nutzt die Rechte der Person, der er gehört");
    expect(shared).not.toContain("Dein Code");
  });
  test("an unreadable personal Code says so without naming a place", () => {
    expect(personal("error")).toContain("Dieser Code konnte nicht geladen werden");
    expect(personal("no-access")).toContain("Nur wer den Code besitzt oder mit wem er geteilt ist, sieht ihn.");
  });
});

describe("Code page states", () => {
  test("overview lists automations with schedule, status and last run, and targets as operation at target", () => {
    const page = text("overview");
    // As in the mockup: the word "Kennung" before it and a short "Kopieren" that still says what it copies.
    expect(page).toContain("Läuft als Dienstkonto „Code von info@moebel-beispiel.de“ · Kennung code-7k2q9m4xwt Kopieren");
    expect(html("overview")).toMatch(/<button aria-label="Kennung kopieren"[^>]*>(?:(?!<\/button>).)*>Kopieren<\/span><\/button>/);
    expect(text("overview", "en")).toContain("Runs as service account “Code of info@moebel-beispiel.de” · Handle code-7k2q9m4xwt Copy");
    expect(page).toContain("Version 4");
    expect(page).toContain("Ursprünge im Internet");
    expect(page).toContain("https://bank.example");
    expect(page).toContain("https://status.example:8443");
    // Who switched a version on came from target grants; the page reads none.
    expect(page).not.toContain("eingeschaltet von");
    expect(page).toContain("alle 15 Minuten");
    expect(page).toContain("montags 07:00");
    expect(page).toContain("nächster Lauf");
    expect(page).toContain("spaces.task.create");
    // A foreign target by type and ID, linked from its type's page pattern; never by name.
    expect(page).toContain("an Space sp_2lg8");
    expect(html("overview")).toContain('<a href="/app/spaces/sp_2lg8">an Space sp_2lg8</a>');
    expect(page).toContain("an info@moebel-beispiel.de selbst");
    expect(page).toContain("Ob er darf, entscheidet, wer das Ziel verwaltet.");
    expect(page).toContain("Keine. Darum hat dieser Code keine Adresse, nur Automationen.");
    expect(page).toContain("Mit Gustav bearbeiten");
    // A place's Code is titled with the feat/code wordmark (slim drawing); screen readers hear whose Code it is.
    const title = html("overview").match(/<h1 class="cloud-code__page-title">.*?<\/h1>/)?.[0] ?? "";
    // The mark itself (not only its inner sign) is hidden, so screen readers hear the title once.
    const mark = title.match(/<span class="cloud-featcode"[^>]*>/)?.[0] ?? "";
    expect(mark).toContain('data-variant="wordmark"');
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).not.toContain("aria-label");
    expect(title).toContain('data-drawing="large"');
    expect(title).toContain('<span class="sr-only">Code von info@moebel-beispiel.de</span>');
  });

  test("a finished version that is still off offers switching on, names its new access and keeps the running version", () => {
    const page = text("waiting");
    expect(page).toContain("Version 5 ist fertig, aber noch aus.");
    expect(page).toContain("Bis jemand sie einschaltet, läuft Version 4 weiter.");
    expect(page).toContain("Version 5 einschalten");
    expect(page).toContain("neu beim Einschalten von Version 5");
    expect(page).toContain("Neu in Version 5 · aus");
  });

  test("manifest internet origins are listed, new ones marked", () => {
    const page = text("internet");
    expect(page).toContain("Ursprünge im Internet");
    expect(page).toContain("https://api.spedition-probe.example");
    expect(page).toContain("https://tracking.example:8443 neu beim Einschalten von Version 5");
    expect(text("no-internet")).not.toContain("Ursprünge im Internet");
  });

  test("a version waiting for approval cannot be switched on", () => {
    const page = text("approval");
    expect(page).toContain("Version 5 wartet auf Freigabe.");
    expect(page).not.toContain("Version 5 einschalten");
  });

  test("a failed run with a target refusal says what was refused, as a fact, with type, ID, link and handle", () => {
    const page = text("refused");
    expect(page).toContain("Letzter Lauf");
    expect(page).toContain(
      "Kein Zugriff auf Space sp_2lg8. Der Code wollte dort „Aufgabe erstellen“. Entweder fehlt dem Dienstkonto „Code von info@moebel-beispiel.de“ das Recht dafür, oder das Ziel existiert nicht.",
    );
    expect(html("refused")).toContain('<a class="k2b-text-link" href="/app/spaces/sp_2lg8"><code>sp_2lg8</code></a>');
    expect(page).toContain("Kennung kopieren");
    expect(page).toContain(
      "Wer das Ziel verwaltet, fügt das Dienstkonto im Rechte-Editor des Ziels mit der Kennung code-7k2q9m4xwt hinzu. Der nächste Lauf versucht es erneut.",
    );
    // The page names no foreign target and asks nobody for access.
    expect(page).not.toContain("Logistik");
    expect(page.toLowerCase()).not.toContain("zugriff anfragen");
    const english = text("refused", "en");
    expect(english).toContain("No access to Space sp_2lg8. The Code tried “Aufgabe erstellen” there.");
    expect(english).toContain("Copy handle");
    expect(english).toContain("The next run tries again.");
  });

  test("a type whose page also needs another ID gets no link, only its ID", () => {
    const page = text("refused-nolink");
    expect(page).toContain("Kein Zugriff auf Aufgabe it_7f3k.");
    expect(html("refused-nolink")).toContain("<code>it_7f3k</code>");
    expect(html("refused-nolink")).not.toContain("it_7f3k</code></a>");
  });

  test("a reader’s refusal notice gives no action, target ID, link or handle", () => {
    const page = text("refused-reader");
    expect(page).toContain(
      "Ein Aufruf wurde abgelehnt. Der Code läuft als Dienstkonto „Code von info@moebel-beispiel.de“. Welches Ziel abgelehnt hat, sehen alle, die den Code bearbeiten dürfen.",
    );
    for (const hidden of ["sp_2lg8", "Aufgabe erstellen", "spaces.task.create", "Kennung kopieren", "Rechte-Editor", "/app/spaces/"])
      expect(refusalMarkup("refused-reader")).not.toContain(hidden);
  });

  test("an editor whose refused call could not be read is told so, not given the reader's text", () => {
    const page = text("refused-unloaded");
    expect(page).toContain("Ein Aufruf wurde abgelehnt. Welches Ziel abgelehnt hat, ließ sich gerade nicht laden.");
    expect(page).not.toContain("sehen alle, die den Code bearbeiten dürfen");
    expect(refusalMarkup("refused-unloaded")).not.toContain("Kennung kopieren");
  });

  test("policy and approval refusals never read as a target refusal and offer no handle", () => {
    const policy = text("refused-policy");
    expect(policy).toContain("Die Richtlinie erlaubt das nicht.");
    expect(policy).toContain("Der Code wollte „Kommentar schreiben“ an Space sp_2lg8.");
    expect(policy).toContain("Die Richtlinie für Code legt der Cloud-Admin fest.");
    const approval = text("refused-approval");
    expect(approval).toContain("Diese Version braucht die Freigabe des Cloud-Admins.");
    expect(approval).toContain("Der Code wollte „Aufgabe erstellen“ an Space sp_2lg8.");
    // Cloud admins decide approvals, so only they get the link to the version's review.
    expect(approval).toContain("Freigabe ansehen");
    expect(html("refused-approval")).toContain('href="/admin/code?sec=approvals&amp;id=00000000-0000-4000-8000-000000000004"');
    for (const page of [refusalMarkup("refused-policy"), refusalMarkup("refused-approval")]) {
      expect(page).not.toContain("Kein Zugriff");
      expect(page).not.toContain("Kennung kopieren");
      expect(page).not.toContain("Wer das Ziel verwaltet");
      expect(page).not.toContain("das Recht dafür");
    }
    expect(text("refused-policy")).not.toContain("Freigabe ansehen");
    expect(text("refused-policy", "en")).toContain("The policy does not allow this.");
    expect(text("refused-approval", "en")).toContain("This version needs the Cloud admin's approval.");
    expect(text("run-refused-policy")).toContain("Die Richtlinie erlaubt das nicht.");
  });

  test("a successful last run shows no refusal notice, even when one of its calls was refused", () => {
    for (const state of ["overview", "runs"] as const) {
      expect(text(state)).not.toContain("Kein Zugriff");
      expect(text(state)).not.toContain("abgelehnt");
    }
  });

  test("the handle shows before the first run, and without one the hint still says what to do", () => {
    const first = codePageFixture("overview");
    if (first.state.kind !== "ready") throw new Error("Expected ready fixture");
    first.state.runs = { items: [], nextCursor: null };
    const render = (data: ReturnType<typeof codePageFixture>) =>
      renderedText(
        renderMarkup(() =>
          createComponent(LocaleProvider, {
            locale: "de",
            get children() {
              return createComponent(CodePage, { data });
            },
          }),
        ),
        " ",
      ).replaceAll(/\s+/g, " ");
    expect(render(first)).toContain("Kennung code-7k2q9m4xwt Kopieren");
    const unknown = codePageFixture("refused");
    if (unknown.state.kind !== "ready") throw new Error("Expected ready fixture");
    unknown.state.code.serviceAccountHandle = null;
    const page = render(unknown);
    expect(page).not.toContain("Kennung kopieren");
    expect(page).toContain(
      "Wer das Ziel verwaltet, fügt das Dienstkonto im Rechte-Editor des Ziels hinzu. Der nächste Lauf versucht es erneut.",
    );
  });

  test("paused Code offers resume", () => {
    expect(text("paused")).toContain("Dieser Code ist pausiert.");
    expect(text("paused")).toContain("Fortsetzen");
  });

  test("a run shows its calls in order with their results", () => {
    const page = text("runs");
    expect(page).toContain("Aufrufe 2");
    expect(page).toContain("Karte „Lieferung KW 45 – Rampe 2“ angelegt");
    expect(page).toContain("Übersprungen, vorheriger Lauf läuft noch");
    expect(page).not.toContain("Erneut ausführen");
  });

  test("a run that failed after its first action offers run again", () => {
    const failed = codePageFixture("run-failed");
    if (failed.state.kind !== "ready") throw new Error("Expected ready fixture");
    failed.state.run!.refusal = null;
    failed.state.run!.calls![1]!.refusal = "bridge";
    const page = renderedText(
      renderMarkup(() =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(CodePage, { data: failed });
          },
        }),
      ),
      " ",
    ).replaceAll(/\s+/g, " ");
    expect(page).toContain("Fehlgeschlagen nach dem ersten Aufruf.");
    expect(page).toContain("Erneut ausführen");
  });

  test("a failed run's refusal takes the place of the generic failure and keeps run again", () => {
    const page = text("run-failed");
    expect(page).toContain("Kein Zugriff auf Space sp_2lg8.");
    expect(page).toContain("Erneut ausführen");
    expect(page).toContain("Kennung kopieren");
    expect(page).not.toContain("Fehlgeschlagen nach dem ersten Aufruf.");
  });

  test("a failed run offers a look with the panel, under the panel's own name and icon", () => {
    expect(text("run-failed")).toContain("Mit Gustav ansehen");
    expect(html("run-failed")).toContain("ti ti-moustache");
    expect(text("run-failed", "en")).toContain("View with Gustav");
    expect(text("run-unclassified")).toContain("Mit Gustav ansehen");
    expect(text("reader")).not.toContain("Mit Gustav ansehen");
  });

  test("the Edit with panel buttons show the panel's icon, never a spark", () => {
    for (const state of ["overview", "empty", "refused"] as const) {
      const page = html(state);
      expect(page).toContain("ti ti-moustache");
      expect(page).not.toContain("ti-sparkles");
    }
  });

  test("a run started again says by whom and links the run it repeats", () => {
    const page = text("run-rerun");
    expect(page).toContain("erneut ausgeführt von Ben Schulz");
    expect(page).toContain("Erneuter Lauf von #2284a1");
    expect(html("run-rerun")).toContain("run=2284a1b2-0000-4000-8000-000000000004");
    expect(text("run-rerun", "en")).toContain("run again by Ben Schulz");
    expect(text("run-rerun", "en")).toContain("Run again from #2284a1");
    expect(text("runs")).not.toContain("erneut ausgeführt");
  });

  test("secrets show where a value may go, who set it and every next step, never a value", () => {
    const page = text("secrets");
    expect(page).toContain("LAGER_TOKEN");
    expect(page).toContain("2 Secrets · Werte nie sichtbar");
    expect(page).toContain("https://api.lager-beispiel.de/v2/");
    expect(page).toContain("authorization");
    expect(page).toContain("[secret:LAGER_TOKEN]");
    expect(page).toContain("gesetzt von Ben Schulz");
    expect(page).toContain("Version 4 (aktiv)");
    expect(page).toContain("Wert ersetzen …");
    expect(page).toContain("Bindung ändern");
    expect(page).toContain("Löschen …");
    expect(html("secrets")).not.toContain('type="password"');
    expect(text("secrets", "en")).toContain("Only sent to");
  });

  test("secrets keep empty, error and result states with a way forward", () => {
    expect(text("secrets-empty")).toContain("Noch keine Secrets");
    expect(text("secrets-empty")).toContain("Secret anlegen");
    expect(text("secrets-error")).toContain("Die Secrets konnten nicht geladen werden");
    expect(text("secrets-error")).toContain("Die Werte sind unverändert gespeichert.");
    expect(text("secrets-replaced")).toContain("Wert ersetzt.");
    expect(text("secrets-submitted")).toContain("Version 5 ist eingereicht.");
    expect(text("secrets-submitted")).toContain("Bis dahin läuft Version 4 mit der alten Bindung.");
    expect(text("secrets-unsubmitted")).toContain("Noch nutzt keine Version diese Bindung.");
    expect(text("secrets-unsubmitted")).toContain("Version 5 einreichen");
    const deleted = text("secrets-deleted");
    expect(deleted).toContain("Wert setzen …");
    expect(deleted).not.toContain("Löschen …");
  });

  test("the secrets tab is offered to editors only", () => {
    expect(html("overview")).toContain("tab=secrets");
    expect(html("reader")).not.toContain("tab=secrets");
  });

  test("readers see runs without their contents and no actions", () => {
    const page = text("reader");
    expect(page).toContain("Was ein Lauf getan hat, sehen nur Bearbeiter dieses Codes.");
    expect(page).not.toContain("Erneut ausführen");
    expect(page).not.toContain("einschalten");
    expect(page).not.toContain("Mit Gustav bearbeiten");
  });

  test("versions show their state, the code difference and what the version may do", () => {
    const page = text("versions");
    expect(page).toContain("Version 5 verglichen mit Version 4");
    expect(page).toContain("selbst freigegeben (einziger Admin)");
    expect(page).toContain("code.ts:7");
    expect(page).toContain("Aktiv");
    expect(html("versions")).toContain("Hinzugefügt, Zeile 6: ");
  });

  test("empty, no access and error states", () => {
    expect(text("empty")).toContain("info@moebel-beispiel.de hat noch keinen Code");
    expect(text("empty")).toContain("cld code pull mail/Mb4kd2");
    expect(text("empty")).toContain("Mit Gustav anlegen");
    // The editor is named from the data, never as a fixed product.
    expect(text("empty")).toContain("Gustav schreibt ihn mit dir.");
    expect(text("empty")).not.toContain("Assistent");
    expect(text("no-access")).toContain("Diesen Code siehst du nicht");
    expect(text("error")).toContain("Der Code von info@moebel-beispiel.de konnte nicht geladen werden");
    expect(text("error")).toContain("info@moebel-beispiel.de und laufende Automationen sind nicht betroffen.");
  });

  test("a failed run whose calls are not all loaded makes no claim about its first action", () => {
    const page = text("run-unclassified");
    expect(page).not.toContain("Erneut ausführen");
    expect(page).not.toContain("vor dem ersten Aufruf");
    expect(page).toContain("Weitere Aufrufe anzeigen");
  });

  test("without the version list nothing can be switched on, and the page says so", () => {
    const page = text("versions-failed");
    expect(page).toContain("Die Versionen konnten nicht geladen werden.");
    expect(page).not.toContain("Version 5 einschalten");
  });

  test("the page right after switching on confirms it", () => {
    expect(text("activated")).toContain("Version 4 ist eingeschaltet.");
  });

  test("English copy", () => {
    expect(text("waiting", "en")).toContain("Version 5 is ready but still off.");
    expect(text("refused-reader", "en")).toContain("A call was refused.");
  });
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

test("internet lists distinguish running/waiting versions, historical selection, no destinations and load failure", () => {
  expect(text("waiting")).toContain("https://new.example");
  expect(text("versions")).toContain("https://version.example:8443");
  expect(text("no-internet")).not.toContain("Ursprünge im Internet");
  expect(text("internet-failed")).toContain("Die Ursprünge im Internet konnten nicht geladen werden.");
  expect(text("internet-failed")).toContain("Erneut versuchen");
});

test("one-time automation rows display the same explicit instant and zone in German and English", () => {
  for (const locale of ["de", "en"]) {
    const data = codePageFixture("overview", locale);
    if (data.state.kind !== "ready" || !data.state.automations?.[0]) throw new Error("Expected automation fixture");
    const automation = data.state.automations[0];
    automation.cron = null;
    automation.at = "2026-12-01T09:15:30+01:00";
    automation.timeZone = "Europe/Berlin";
    const rendered = renderMarkup(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(CodePage, { data });
        },
      }),
    );
    const expected = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" }).format(
      new Date(automation.at),
    );
    expect(rendered).toContain(expected);
    expect(rendered).toContain("(Europe/Berlin)");
  }
});

test("automation rows and the last run use reviewed titles with identifier fallback", () => {
  for (const state of ["overview", "refused", "waiting"] as const) {
    const data = codePageFixture(state, "de");
    if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
    for (const automation of data.state.automations ?? []) automation.title = "Lieferungen eintragen";
    const rendered = renderMarkup(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(CodePage, { data });
        },
      }),
    );
    const text = renderedText(rendered, " ");
    expect(text).toContain("Lieferungen eintragen");
    expect(text).not.toContain("anfragenSortieren");
    if (state === "refused") expect(text).toContain("Letzter Lauf");
  }
  expect(html("overview")).toContain("anfragenSortieren");
});

test("run lists and details use the run's title with identifier fallback", () => {
  const data = codePageFixture("runs", "de");
  if (data.state.kind !== "ready" || !data.state.run || !data.state.runs) throw new Error("Expected run fixture");
  data.state.run.run.title = "Lieferungen eintragen";
  data.state.runs.items[0]!.title = "Lieferungen eintragen";
  const rendered = renderMarkup(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(CodePage, { data });
      },
    }),
  );
  expect(rendered.match(/Lieferungen eintragen/g)?.length).toBeGreaterThanOrEqual(2);
  expect(rendered).toContain("anfragenSortieren");
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
    (permission: "editor" | "reader", run: typeof failedRun, firstCall = policyCall) =>
    (capabilityId: string, input: { content?: unknown; cursor?: number }) => {
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
          content: input.content ? { text: JSON.stringify(manifest), nextOffset: null } : null,
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
  const load = async (permission: "editor" | "reader", query = "", run = failedRun, firstCall = policyCall) => {
    const appCalls: string[] = [];
    const coreCalls: string[] = [];
    const invoke = spyOn(capabilityServer, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
      if (invocation.appId !== "core") {
        appCalls.push(`${invocation.appId}.${invocation.capabilityId}`);
        return { ok: false, error: { code: "APP_UNAVAILABLE", message: "Another app was asked", status: 503 } };
      }
      coreCalls.push(invocation.capabilityId);
      const data = core(permission, run, firstCall)(invocation.capabilityId, invocation.input as { content?: unknown; cursor?: number });
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
    const request = new Request(`https://cloud.test/app/mail/Mb4kd2/code${query}`);
    const variables: Record<string, unknown> = {
      actor: { kind: "user", sessionKind: "web" },
      credentialKind: "session",
      user: { id: "00000000-0000-4000-8000-0000000000a1", roles: ["user"] },
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
    const serialized = JSON.stringify({ ...data.state, targets: null, diff: null, waitingTargets: null });
    expect(serialized).not.toContain("k7qm2x9a");
    expect(serialized).not.toContain("spaces.task.create");
  });
});

test("the handle is present before the first run and in the server's first render", () => {
  const data = codePageFixture("overview", "de");
  if (data.state.kind !== "ready") throw new Error("Expected draft Code fixture");
  data.state.runs = { items: [], nextCursor: null };
  const markup = renderMarkup(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(CodePage, { data });
      },
    }),
  );
  expect(markup).toContain("code-7k2q9m4xwt");
  expect(markup.match(/Kennung kopieren/g)).toHaveLength(1);
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

test("failed event delivery remains visible and only an active editor can retry it", () => {
  const page = (permission: "editor" | "reader", state: "active" | "paused") => {
    const data = codePageFixture("runs");
    if (data.state.kind !== "ready") throw new Error("Missing ready fixture");
    data.state.permission = permission;
    data.state.code.state = state;
    data.state.runs = {
      items: [],
      nextCursor: null,
      eventDeliveries: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          eventId: "22222222-2222-4222-8222-222222222222",
          eventType: "fixture.changed",
          state: "failed",
          code: "code_event_backlog_full",
          attempts: 8,
          createdAt: "2026-11-06T12:00:00Z",
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
  expect(markup).toContain("fixture.changed");
  expect(markup).toContain("code_event_backlog_full");
  expect(markup).toContain("Retry delivery");
  expect(markup).toContain('data-tone="error"');
  expect(page("reader", "active")).not.toContain("Retry delivery");
  expect(page("editor", "paused")).not.toContain("Retry delivery");
});
