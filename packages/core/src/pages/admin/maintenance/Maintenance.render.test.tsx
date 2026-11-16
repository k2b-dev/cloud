import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-maintenance-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { default: Maintenance }] = await Promise.all([import("@k2b/ui"), import("./Maintenance.island.tsx")]);

// 14:10 in Berlin.
beforeAll(() => setSystemTime(new Date("2026-11-16T13:10:00.000Z")));
afterAll(() => setSystemTime());

const html = (initial: MaintenanceStatus, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(Maintenance, {
          initial,
          appNames: { files: "Dateien", mail: "Mail" },
          dateConfig: { timeZone: "Europe/Berlin", locale },
          path: "/admin/settings/maintenance",
          suggestedEnd: "2026-11-16T14:15:00.000Z",
        });
      },
    }),
  );

/** Visible text of trusted test markup: every tag (and comment) becomes a space, character by character. */
const text = (markup: string) => {
  let out = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") inTag = true;
    else if (char === ">" && inTag) {
      inTag = false;
      out += " ";
    } else if (!inTag) out += char;
  }
  return out.replace(/\s+/g, " ");
};

test("off: the switch with its note, a suggested end with its date and the cld way out, and no start-time choice", () => {
  const page = text(html({ active: false, apps: { ready: 11, total: 11, starting: [] } }));
  // The suggested end is a full date and time (15:15 in Berlin), so a maintenance can run past midnight.
  expect(page).toMatch(/16\.\s?Nov\.?\s2026,\s15:15/);
  for (const words of [
    "Wartungsmodus",
    "Aus",
    "Solange er an ist, sehen alle statt der Cloud eine Wartungsseite.",
    "Hinweis für alle",
    "Freiwillig. Steht auf der Wartungsseite.",
    "Voraussichtlich fertig um",
    "Freiwillig. Die Wartung endet nie von selbst; du schaltest sie aus.",
    "Ausschalten geht auch mit cld admin maintenance off .",
    "Wartung starten",
  ])
    expect(page).toContain(words);
  // Planning with an announcement comes later: no "Beginn" group, and no space kept for it.
  expect(page).not.toContain("Beginn");
  expect(page).not.toContain("Planen");
  expect(page).not.toContain("Wartung beenden");
});

test("active: who started it and when, the planned end, the note and the apps by name", () => {
  const markup = html({
    active: true,
    startedAt: "2026-11-16T13:02:00.000Z",
    startedBy: { id: "u-lea", label: "Lea Muster" },
    message: "Wir spielen Version 2.4 ein. Danach ist alles wie vorher.",
    until: "2026-11-16T13:30:00.000Z",
    apps: { ready: 9, total: 11, starting: ["files", "mail"] },
  });
  const page = text(markup);
  expect(markup).toContain("ti-barrier-block");
  for (const words of [
    "Aktiv",
    "Alle außer dir sehen gerade die Wartungsseite.",
    "Seit",
    "14:02 Uhr, gestartet von Lea Muster",
    "Geplant bis",
    "14:30 Uhr",
    "Hinweis",
    "Wir spielen Version 2.4 ein. Danach ist alles wie vorher.",
    "Apps bereit",
    "9 von 11 · Dateien und Mail starten noch",
    "Ende verschieben",
    "Wartung beenden",
  ])
    expect(page).toContain(words);
  expect(page).not.toContain("Wartung starten");
  expect(page).not.toContain("Hinweis für alle");
});

test("active without end, note or starting apps leaves no empty rows", () => {
  const page = text(
    html({
      active: true,
      startedAt: "2026-11-16T13:02:00.000Z",
      startedBy: { id: "u-lea", label: "Lea Muster" },
      apps: { ready: 11, total: 11, starting: [] },
    }),
  );
  expect(page).toContain("14:02 Uhr, gestartet von Lea Muster");
  expect(page).toContain("11 von 11");
  expect(page).not.toContain("Geplant bis");
  expect(page).not.toContain("Hinweis");
  expect(page).not.toContain("starten noch");
});

test("English wording and a start on another day with its date", () => {
  const page = text(
    html(
      {
        active: true,
        startedAt: "2026-11-15T21:00:00.000Z",
        startedBy: { id: "u-lea", label: "Lea Muster" },
        apps: { ready: 10, total: 11, starting: ["mail"] },
      },
      "en",
    ),
  );
  expect(page).toContain("Maintenance mode");
  expect(page).toContain("Everyone except you sees the maintenance page right now.");
  expect(page).toContain("22:00, started by Lea Muster");
  expect(page).toMatch(/Nov.*15|15.*Nov/);
  expect(page).toContain("10 of 11 · Mail is still starting");
});
