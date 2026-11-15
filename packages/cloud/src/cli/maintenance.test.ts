import { expect, test } from "bun:test";
import type { MaintenanceStatus } from "../contracts/maintenance";
import { maintenanceCommands } from "./admin/maintenance";
import { defineCliCommands } from "./commands";
import type { CloudCliFlags } from "./index";
import {
  formatMaintenanceTime,
  MAINTENANCE_EXIT_CODE,
  maintenanceOffSentence,
  maintenanceOnSentence,
  maintenanceProblemSentence,
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
  expect(printed.slice(0, 2).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""))).toEqual(["Wartungsmodus aktiviert.", "Wartungsmodus beendet. Offene Seiten laden jetzt neu."]);
  await expect(invoke(["maintenance", "until", "00:00"])).rejects.toThrow();
});
