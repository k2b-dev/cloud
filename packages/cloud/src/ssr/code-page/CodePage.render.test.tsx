import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { loadCodeRunCallsForDetail, summarizeCallResult } from "./calls";
import { codePageFixture } from "./code-page.fixture";
import type { CodePageInvoke } from "./data";
import { describeCodeSchedule } from "./schedule";

const root = mkdtempSync(resolve(tmpdir(), "cloud-code-page-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CodePage } = await import("./CodePage");
const { permissionRef, visiblePersonIds } = await import("./load");
const { LocaleProvider } = await import("@k2b/ui");

type State = Parameters<typeof codePageFixture>[0];
const html = (state: State, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodePage, { data: codePageFixture(state, locale) });
      },
    }),
  ).replaceAll(/<!--[^>]*-->/g, "");
const text = (state: State, locale = "de") =>
  html(state, locale)
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ");

describe("Code page states", () => {
  test("overview lists automations with schedule, status and last run, and access as operation at target", () => {
    const page = text("overview");
    expect(page).toContain("Handelt im Namen von info@moebel-beispiel.de, nicht als Person");
    expect(page).toContain("Version 4");
    expect(page).toContain("eingeschaltet von Ben Schulz am");
    expect(page).toContain("alle 15 Minuten");
    expect(page).toContain("montags 07:00");
    expect(page).toContain("spaces.task.create");
    expect(page).toContain("an Space Logistik (sp_2lg8)");
    expect(page).toContain("an info@moebel-beispiel.de selbst");
    expect(page).toContain("Keine. Darum hat dieser Code keine Adresse, nur Automationen.");
    expect(page).toContain("Mit Gustav bearbeiten");
    // No redundant visible title row: the sidebar marks "Code", the heading is for screen readers.
    expect(html("overview")).toContain('<h1 class="sr-only">Code von info@moebel-beispiel.de</h1>');
  });

  test("a finished version that is still off offers switching on, names its new access and keeps the running version", () => {
    const page = text("waiting");
    expect(page).toContain("Version 5 ist fertig, aber noch aus.");
    expect(page).toContain("Bis jemand sie einschaltet, läuft Version 4 weiter.");
    expect(page).toContain("Version 5 einschalten");
    expect(page).toContain("neu beim Einschalten von Version 5");
    expect(page).toContain("Neu in Version 5 · aus");
  });

  test("a version waiting for approval cannot be switched on", () => {
    const page = text("approval");
    expect(page).toContain("Version 5 wartet auf Freigabe.");
    expect(page).not.toContain("Version 5 einschalten");
  });

  test("removed access and a deleted target say what fails and how to recover", () => {
    const removed = text("removed");
    expect(removed).toContain("Zugriff auf Space Logistik wurde entfernt.");
    expect(removed).toContain("Zugriff entfernt");
    expect(removed).toContain("Wieder einschalten");
    const deleted = text("deleted");
    expect(deleted).toContain("Space Logistik wurde gelöscht.");
    expect(deleted).toContain("Ziel gelöscht");
    expect(deleted).not.toContain("Wieder einschalten");
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
    const page = text("run-failed");
    expect(page).toContain("Fehlgeschlagen nach dem ersten Aufruf.");
    expect(page).toContain("Erneut ausführen");
    expect(page).toContain("Zeitüberschreitung nach 10 s");
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
    expect(text("no-access")).toContain("Diesen Code siehst du nicht");
    expect(text("error")).toContain("Der Code von info@moebel-beispiel.de konnte nicht geladen werden");
    expect(text("error")).toContain("info@moebel-beispiel.de und laufende Automationen sind nicht betroffen.");
  });

  test("the header credits only the activation of the running version, never an older reused grant", () => {
    const line = html("overview").match(/<p class="cloud-code__vline">.*?<\/p>/)?.[0] ?? "";
    expect(line).toContain("eingeschaltet von Ben Schulz am 28. Okt. 2026");
    expect(line).not.toContain("14. Okt.");
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
    expect(text("removed", "en")).toContain("Access to Space Logistik was removed.");
  });
});

describe("Code page helpers", () => {
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
    const invoke = (async (invocation) => {
      const cursor = (invocation.input as { cursor: number }).cursor;
      reads.push(cursor);
      const kind = calls[cursor];
      return {
        ok: true,
        data: {
          data: {
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
          },
        },
      };
    }) as CodePageInvoke;
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
    expect(summarizeCallResult({ error: { code: "FORBIDDEN", message: "Zugriff entfernt" } })).toBe("Zugriff entfernt");
    expect(summarizeCallResult({ id: "t_1" })).toBe('{"id":"t_1"}');
    expect(summarizeCallResult("x".repeat(400))?.length).toBe(160);
    expect(summarizeCallResult(null)).toBeNull();
  });
});
