import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Context } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { isAccessRefusal, loadCodeRunCallsForDetail, summarizeCallResult } from "./calls";
import { codePageFixture } from "./code-page.fixture";
import type { CodePageInvoke } from "./data";
import { describeCodeSchedule } from "./schedule";

const root = mkdtempSync(resolve(tmpdir(), "cloud-code-page-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CodePage } = await import("./CodePage");
const { attributeMissingAccess, permissionRef, targetKey, visiblePersonIds } = await import("./load");
const { loadCodeAttention } = await import("./attention");
const { codePageNeedsAttention } = await import("./CodePage");
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

const personal = (state: State, locale = "de") =>
  renderToString(() =>
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
  )
    .replaceAll(/<!--[^>]*-->/g, "")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ");

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
    const shared = renderToString(() =>
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
    )
      .replaceAll(/<!--[^>]*-->/g, "")
      .replaceAll(/<[^>]+>/g, " ")
      .replaceAll(/\s+/g, " ");
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
  test("overview lists automations with schedule, status and last run, and access as operation at target", () => {
    const page = text("overview");
    expect(page).toContain("Handelt im Namen von info@moebel-beispiel.de, nicht als Person");
    expect(page).toContain("Version 4");
    expect(page).toContain("Ursprünge im Internet");
    expect(page).toContain("https://bank.example");
    expect(page).toContain("https://status.example:8443");
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

  test("removed access and a deleted target say what fails and how to recover", () => {
    const removed = text("removed");
    expect(removed).toContain("Zugriff auf Space Logistik wurde entfernt.");
    expect(removed).toContain(
      "Mia Koch hat ihn heute um 11:20 entfernt. Aufrufe an Space Logistik scheitern, bis jemand neu einschaltet. Darum ist der letzte Lauf von „lieferungenEintragen“ fehlgeschlagen. „anfragenSortieren“ läuft weiter.",
    );
    expect(removed).toContain("heute 11:20 von Mia Koch entfernt");
    // A hidden name still says when; without the removal's audit event the page says only that it was removed.
    const unnamed = text("removed-unnamed");
    expect(unnamed).toContain("Jemand hat ihn heute um 11:20 entfernt.");
    expect(unnamed).toContain("heute 11:20 entfernt");
    expect(unnamed).not.toContain("Mia Koch");
    const unknown = text("removed-unknown");
    expect(unknown).toContain("Zugriff auf Space Logistik wurde entfernt. Aufrufe an Space Logistik scheitern");
    expect(unknown).toContain("Zugriff entfernt");
    expect(unknown).not.toContain("hat ihn");
    expect(text("removed", "en")).toContain("Mia Koch removed it today at 11:20.");
    expect(text("removed", "en")).toContain("removed by Mia Koch today at 11:20");
    expect(removed).toContain("Wieder einschalten");
    expect(removed).toContain("Mit Gustav bearbeiten");
    // Only the affected automation shows missing access; nothing is paused per automation.
    expect(html("removed").match(/k2b-status-badge__label">Zugriff fehlt</g)).toHaveLength(1);
    expect(removed).not.toContain("Pausiert");
    expect(removed).toContain("Pausieren lässt sich nur der ganze Code.");
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

  test("a failed run offers a look with the panel, under the panel's own name and icon", () => {
    expect(text("run-failed")).toContain("Mit Gustav ansehen");
    expect(html("run-failed")).toContain("ti ti-moustache");
    expect(text("run-failed", "en")).toContain("View with Gustav");
    expect(text("run-unclassified")).toContain("Mit Gustav ansehen");
    expect(text("reader")).not.toContain("Mit Gustav ansehen");
  });

  test("the Edit with panel buttons show the panel's icon, never a spark", () => {
    for (const state of ["overview", "empty", "removed"] as const) {
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
  test("the page's own attention follows Core's rule: failed run, missing access or pending approval", () => {
    expect(codePageNeedsAttention(codePageFixture("overview").state)).toBe(false);
    expect(codePageNeedsAttention(codePageFixture("removed").state)).toBe(true);
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
    const answer = (items: Array<{ codeId: string; reasons: string[] }>) =>
      (async () => ({ ok: true, data: { data: { data: { items } } } })) as unknown as CodePageInvoke;
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

  test("missing access is attributed only on evidence; unknown automations are never said to keep running", async () => {
    const space = { type: "spaces.space", id: "sp_2lg8" };
    const removed = new Set([targetKey(space)]);
    const run = (id: string, state: "succeeded" | "failed") => ({
      id,
      versionId: "v",
      versionNumber: 4,
      trigger: "schedule" as const,
      entrypoint: id,
      state,
      outcome: state,
      createdAt: "2026-11-01T08:00:00.000Z",
      startedAt: null,
      endedAt: null,
    });
    const automation = (name: string, lastRun: ReturnType<typeof run> | null) => ({
      entrypoint: name,
      kind: "schedule" as const,
      cron: null,
      isNew: false,
      lastRun,
      missingTargets: [] as string[],
      missingProven: false,
      accessUnknown: false,
    });
    const call = (target: { type: string; id: string } | null, capability = "spaces.task.create", accessRefused = true) => ({
      ordinal: 1,
      kind: "action" as const,
      capability,
      target,
      refs: [],
      accessRefused,
      state: "failed" as const,
      summary: null,
    });
    const deliver = automation("deliver", run("deliver", "failed"));
    const sort = automation("sort", run("sort", "succeeded"));
    const other = automation("other", run("other", "failed"));
    const reads: string[] = [];
    await attributeMissingAccess([deliver, sort, other], removed, "editor", async (id) => {
      reads.push(id);
      return id === "deliver" ? { calls: [call(space)], next: null } : { calls: [call(null, "mail.send")], next: 5 };
    });
    expect(deliver).toMatchObject({ missingTargets: [targetKey(space)], missingProven: true, accessUnknown: false });
    expect(sort).toMatchObject({ missingTargets: [], accessUnknown: false });
    // Its calls were not all read: it may fail there too, so the page makes no claim.
    expect(other).toMatchObject({ missingTargets: [], accessUnknown: true });
    expect(reads).toEqual(["deliver", "other"]);

    // A call that failed at the target for another reason shows the need, not the cause.
    const timedOut = automation("timedOut", run("timedOut", "failed"));
    await attributeMissingAccess([timedOut, automation("y", run("y", "succeeded"))], removed, "editor", async () => ({
      calls: [call(space, "spaces.task.create", false)],
      next: null,
    }));
    expect(timedOut).toMatchObject({ missingTargets: [targetKey(space)], missingProven: false, accessUnknown: false });

    // A reader gets no calls: failed automations stay unknown; the only automation needs the access without proof.
    const lone = automation("lone", run("lone", "succeeded"));
    await attributeMissingAccess([lone], removed, "reader", async () => {
      throw new Error("not read");
    });
    expect(lone).toMatchObject({ missingTargets: [targetKey(space)], missingProven: false });

    // App-wide calls match an app-wide grant.
    const app = { type: "app", id: "weather" };
    const forecast = automation("forecast", run("forecast", "failed"));
    await attributeMissingAccess([forecast, automation("x", run("x", "succeeded"))], new Set([targetKey(app)]), "editor", async () => ({
      calls: [call(null, "weather.forecast.read")],
      next: null,
    }));
    expect(forecast.missingTargets).toEqual([targetKey(app)]);
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

  test("only an access refusal counts as missing access, not invalid input or an outage", () => {
    expect(isAccessRefusal({ ok: false, error: { code: "FORBIDDEN", message: "Access denied", status: 403 } })).toBe(true);
    expect(isAccessRefusal({ ok: false, error: { code: "NOT_FOUND", status: 404 } })).toBe(true);
    expect(isAccessRefusal({ ok: false, error: { code: "BAD_INPUT", message: "Invalid title", status: 400 } })).toBe(false);
    expect(isAccessRefusal({ ok: false, error: { code: "APP_UNAVAILABLE", status: 503 } })).toBe(false);
    expect(isAccessRefusal(null)).toBe(false);
  });

  test("call results become one short line, preferring an error message", () => {
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
