import { expect, test } from "bun:test";
import type { MaintenanceStatus } from "../contracts/maintenance";
import { maintenanceCommands } from "./admin/maintenance";
import { defineCliCommands } from "./commands";
import type { CloudCliFlags } from "./index";
import {
  formatMaintenanceTime,
  MAINTENANCE_EXIT_CODE,
  maintenanceBypassLines,
  maintenanceBypassOffSentence,
  maintenanceOffSentence,
  maintenanceOnSentence,
  maintenanceProblemSentence,
  maintenanceQuietLine,
  maintenanceResumeSentence,
  maintenanceStatusLines,
  maintenanceUntilSentence,
  markMaintenanceWord,
  parseMaintenanceTime,
} from "./maintenance";

// Local times on purpose: cld prints and reads the terminal's own clock.
const now = new Date(2026, 10, 16, 14, 2);
const at = (hours: number, minutes: number, day = 16) => new Date(2026, 10, day, hours, minutes).toISOString();
const active: MaintenanceStatus = {
  active: true,
  startedAt: at(14, 2),
  startedBy: { id: "0b6f2e3c-6f0e-4d8e-9a77-3f1c2b9d4e51", label: "Lea Muster" },
  message: "Wir spielen Version 2.4 ein.",
  until: at(14, 30),
  apps: { ready: 9, total: 11, starting: ["files", "mail"] },
};

test("German output uses the sentences from the concept", () => {
  expect(maintenanceOnSentence(active, { locale: "de-DE", now })).toBe("Wartungsmodus aktiviert. Geplant bis 14:30 Uhr.");
  expect(maintenanceUntilSentence({ ...active, until: at(15, 0) }, { locale: "de", now })).toBe("Neues Ende: 15:00 Uhr.");
  expect(maintenanceOffSentence({ locale: "de" })).toBe("Wartungsmodus beendet. Offene Seiten laden jetzt neu.");
  expect(maintenanceStatusLines(active, { locale: "de", now })).toEqual([
    "Aktiv seit 14:02 · geplant bis 14:30",
    "Hinweis: Wir spielen Version 2.4 ein.",
    "Apps bereit: 9 von 11 (files, mail starten)",
  ]);
  expect(maintenanceStatusLines({ active: false, apps: { ready: 11, total: 11, starting: [] } }, { locale: "de" })).toEqual([
    "Wartungsmodus aus.",
  ]);
});

test("English output and other days name the date", () => {
  const { message: _message, until: _until, ...plain } = active;
  expect(maintenanceOnSentence(plain, { locale: "en", now })).toBe("Maintenance mode on.");
  expect(maintenanceStatusLines({ ...plain, apps: { ready: 11, total: 11, starting: [] } }, { now })).toEqual([
    "Active since 14:02",
    "Apps ready: 11 of 11",
  ]);
  expect(formatMaintenanceTime(at(9, 5, 17), "de", now)).toBe("17.11., 09:05");
  expect(formatMaintenanceTime(at(9, 5, 17), "en", now)).toBe("Nov 17, 09:05");
});

test("times are HH:MM today or ISO, and a passed time is rejected instead of moved to tomorrow", () => {
  expect(parseMaintenanceTime("14:30", now)).toBe(at(14, 30));
  expect(parseMaintenanceTime("2026-11-17T09:00:00+01:00", now)).toBe("2026-11-17T08:00:00.000Z");
  expect(() => parseMaintenanceTime("13:00", now)).toThrow("already passed");
  expect(() => parseMaintenanceTime("24:00", now)).toThrow("Invalid time");
  expect(() => parseMaintenanceTime("morgen", now)).toThrow("Invalid time");
});

test("only a terminal that wants colour gets the orange word", () => {
  expect(markMaintenanceWord("Wartungsmodus aktiviert.", false)).toBe("Wartungsmodus aktiviert.");
  expect(markMaintenanceWord("Wartungsmodus aktiviert.", true)).toBe("\u001b[38;5;208mWartungsmodus\u001b[39m aktiviert.");
});

const problem = (body: unknown, status = 503, type = "application/problem+json") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } });

test("a gateway maintenance answer becomes one sentence with its own exit code; other errors stay errors", async () => {
  expect(MAINTENANCE_EXIT_CODE).toBe(75);
  const maintenance = { type: "about:blank", title: "Cloud is in maintenance", status: 503, code: "maintenance", until: at(14, 30) };
  expect(await maintenanceProblemSentence(problem(maintenance), { now })).toEqual({
    code: "maintenance",
    de: "Wartungsmodus aktiv, geplant bis 14:30 Uhr.",
    en: "Maintenance mode active, planned until 14:30.",
  });
  expect(await maintenanceProblemSentence(problem({ ...maintenance, code: "app_unavailable", appId: "mail" }))).toMatchObject({
    code: "app_unavailable",
  });
  expect(await maintenanceProblemSentence(problem(maintenance, 500))).toBeNull();
  expect(await maintenanceProblemSentence(problem(maintenance, 503, "application/json"))).toBeNull();
  expect(await maintenanceProblemSentence(problem({ ...maintenance, code: "other" }))).toBeNull();
  expect(await maintenanceProblemSentence(new Response("Service unavailable", { status: 503 }))).toBeNull();
});

test("cld admin maintenance calls Core's maintenance API and prints the sentence", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const printed: string[] = [];
  const module = defineCliCommands({ name: "admin", summary: "Maintenance", commands: maintenanceCommands });
  const invoke = (args: string[], flags: CloudCliFlags = {}) =>
    module.run({
      args,
      flags,
      options: { profile: "test", server: "http://test", token: "test", output: "text", locale: "de" },
      getDefault: async () => undefined,
      setDefault: async () => {},
      createApiClient: () => {
        throw new Error("unused");
      },
      fetch: async (path, init) => {
        calls.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        const { message: _message, until: _until, ...plain } = active;
        return Response.json(plain);
      },
      readJson: async (response) => response.json(),
      print: (line = "") => {
        printed.push(line);
      },
      write: async () => {},
      error: () => {},
      json: () => {},
      jsonLine: () => {},
      table: () => {},
    });
  await invoke(["maintenance", "on"], { message: "Hallo" });
  await invoke(["maintenance", "off"]);
  await invoke(["maintenance", "status"]);
  expect(calls).toEqual([
    { path: "/api/admin/maintenance/on", method: "POST", body: { message: "Hallo" } },
    { path: "/api/admin/maintenance/off", method: "POST", body: {} },
    { path: "/api/admin/maintenance", method: "GET", body: undefined },
  ]);
  // FORCE_COLOR may be set where tests run; the words matter here.
  expect(printed.slice(0, 2).map((line) => line.replaceAll("\u001b[38;5;208m", "").replaceAll("\u001b[39m", ""))).toEqual([
    "Wartungsmodus aktiviert.",
    "Wartungsmodus beendet. Offene Seiten laden jetzt neu.",
  ]);
  await expect(invoke(["maintenance", "until", "00:00"])).rejects.toThrow();

  calls.length = 0;
  await invoke(["maintenance", "on"], { quiesce: true });
  await invoke(["maintenance", "on"], { "no-quiesce": true });
  expect(calls.map((call) => call.body)).toEqual([{ quiesce: true }, { quiesce: false }]);
  expect(printed.at(-1)).toBe("Ruhe aus: Hintergrundarbeit läuft wieder.");
  await expect(invoke(["maintenance", "on"], { quiesce: true, "no-quiesce": true })).rejects.toThrow("either --quiesce or --no-quiesce");
  expect(calls).toHaveLength(2);
});

test("stage Ruhe adds one sentence to on and one line to status", () => {
  const quiet = { quiet: 8, total: 9, busy: [{ id: "mail", name: "Mail", inFlight: 2, unreported: 0 }] };
  expect(maintenanceOnSentence({ ...active, quiesce: true }, { locale: "de", now })).toBe(
    "Wartungsmodus aktiviert. Geplant bis 14:30 Uhr. Ruhe: Hintergrundarbeit hält an.",
  );
  const { until: _until, ...noEnd } = active;
  expect(maintenanceOnSentence({ ...noEnd, quiesce: true }, { locale: "en", now })).toBe(
    "Maintenance mode on. Quiet: background work is stopping.",
  );
  expect(maintenanceStatusLines({ ...active, quiesce: true, quiet }, { locale: "de", now }).at(-1)).toBe(
    "Ruhe: 8 von 9 Apps ruhig, Mail: 2 Aufgaben laufen noch",
  );
  expect(maintenanceStatusLines({ ...active, quiesce: false, quiet }, { locale: "de", now })).toHaveLength(3);
  expect(maintenanceQuietLine(quiet, { locale: "en" })).toBe("Quiet: 8 of 9 apps quiet, Mail: 2 tasks still running");
  expect(maintenanceQuietLine({ quiet: 9, total: 9, busy: [] }, { locale: "de" })).toBe("Ruhe: 9 von 9 Apps ruhig");
  expect(maintenanceResumeSentence({ locale: "en" })).toBe("Quiet off: background work runs again.");
});

test("the quiet line names at most three busy apps, with running tasks and instances that have not reported", () => {
  const busy = [
    { id: "files", name: "Dateien", inFlight: 1, unreported: 0 },
    { id: "mail", name: "Mail", inFlight: 2, unreported: 1 },
    { id: "pulse", name: "Pulse", inFlight: 3, unreported: 0 },
    { id: "spaces", name: "Spaces", inFlight: 1, unreported: 0 },
    { id: "venue", name: "Venue", inFlight: 1, unreported: 0 },
  ];
  expect(maintenanceQuietLine({ quiet: 4, total: 9, busy }, { locale: "de" })).toBe(
    "Ruhe: 4 von 9 Apps ruhig, Dateien: 1 Aufgabe läuft noch, Mail: 2 Aufgaben laufen noch und 1 Instanz ohne Rückmeldung, Pulse: 3 Aufgaben laufen noch, 2 weitere",
  );
  expect(maintenanceQuietLine({ quiet: 4, total: 9, busy }, { locale: "en" })).toBe(
    "Quiet: 4 of 9 apps quiet, Dateien: 1 task still running, Mail: 2 tasks still running and 1 instance has not reported, Pulse: 3 tasks still running, 2 more",
  );
  const silent = { quiet: 8, total: 9, busy: [{ id: "mail", name: "Mail", inFlight: 0, unreported: 2 }] };
  expect(maintenanceQuietLine(silent, { locale: "de" })).toBe("Ruhe: 8 von 9 Apps ruhig, Mail: 2 Instanzen ohne Rückmeldung");
  expect(maintenanceQuietLine(silent, { locale: "en" })).toBe("Quiet: 8 of 9 apps quiet, Mail: 2 instances have not reported");
});

test("cld admin maintenance bypass prints the sentence and the link on its own line, or one sentence when off", async () => {
  const link = { url: "https://cloud.musterverein.test/?cloud-maintenance-bypass=abc.def", expiresAt: at(2, 2, 17) };
  // The link ends with the maintenance, but never later than Core's cap; the sentence names that time.
  expect(maintenanceBypassLines(link, { locale: "de-DE", now })).toEqual([
    "Link für dich, gilt bis zum Ende dieser Wartung, längstens bis 17.11., 02:02 Uhr:",
    link.url,
  ]);
  expect(maintenanceBypassLines({ ...link, expiresAt: at(23, 30) }, { locale: "en", now })).toEqual([
    "Your link, valid until this maintenance ends, at the latest until 23:30:",
    link.url,
  ]);
  expect(maintenanceBypassOffSentence({ locale: "de" })).toBe("Kein Link nötig: Der Wartungsmodus ist aus.");
  expect(maintenanceBypassOffSentence({ locale: "en" })).toBe("No link needed: maintenance mode is off.");

  const module = defineCliCommands({ name: "admin", summary: "Maintenance", commands: maintenanceCommands });
  const calls: Array<{ path: string; method: string }> = [];
  const printed: string[] = [];
  const invoke = (answer: Response) =>
    module.run({
      args: ["maintenance", "bypass"],
      flags: {},
      options: { profile: "test", server: "http://test", token: "test", output: "text", locale: "de" },
      getDefault: async () => undefined,
      setDefault: async () => {},
      createApiClient: () => {
        throw new Error("unused");
      },
      fetch: async (path, init) => {
        calls.push({ path, method: init?.method ?? "GET" });
        return answer;
      },
      readJson: async (response) => response.json(),
      print: (line = "") => {
        printed.push(line);
      },
      write: async () => {},
      error: () => {},
      json: () => {},
      jsonLine: () => {},
      table: () => {},
    });
  await invoke(Response.json(link));
  expect(calls).toEqual([{ path: "/api/admin/maintenance/bypass", method: "POST" }]);
  expect(printed).toEqual(maintenanceBypassLines(link, { locale: "de" }));
  expect(printed[1]).toBe(link.url);
  expect(printed[0] ?? "").toStartWith("Link für dich, gilt bis zum Ende dieser Wartung, längstens bis ");
  await expect(invoke(Response.json({ error: "Maintenance mode is not active" }, { status: 409 }))).rejects.toThrow(
    "Kein Link nötig: Der Wartungsmodus ist aus.",
  );
});
