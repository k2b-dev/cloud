import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AdminBaseRow, AdminBasesPage, InternalTargetsPage, PulsePolicy } from "../../store/admin-contracts";
import { notSetUpMessages } from "../not-set-up";
import { baseStoreMessages } from "../workspace/base-store-messages";
import { pulseAdminMessages } from "./pulse-admin-messages";

const root = mkdtempSync(join(tmpdir(), "pulse-admin-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: BasesAdmin } = await import("./BasesAdmin.island");
const { default: TargetsAdmin } = await import("./TargetsAdmin.island");
const render = (locale: string, child: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return child();
      },
    }),
  );

const limits = {
  valuesPerMinute: 2000,
  bytesPerMinute: 5_242_880,
  storageBytes: 5_000_000_000,
  maxSeries: 50_000,
  maxEventKinds: 2000,
  maxStateKeys: 2000,
};
const policy: PulsePolicy = {
  baseCreation: "everyone",
  maxBases: 200,
  maxRawRetentionDays: 730,
  defaultProfile: "normal",
  defaultLimits: limits,
};
const row = (id: string, name: string, store: Partial<AdminBaseRow["store"]> = {}): AdminBaseRow => ({
  id,
  name,
  admins: ["Jana Berger"],
  adminCount: 1,
  rawRetentionDays: 30,
  rollupRetentionDays: 800,
  sensitiveRetentionHours: 24,
  createdAt: "2026-10-01T08:00:00.000Z",
  store: {
    state: "active",
    operation: null,
    errorCode: null,
    errorAt: null,
    writeBlockReason: null,
    profile: "normal",
    limits,
    usage: { bytes: 1_800_000_000, rows: 1_200_000, measuredAt: "2026-10-17T12:30:00.000Z" },
    ...store,
  },
});
const page: AdminBasesPage = {
  items: [
    row("Bet001", "Betrieb"),
    row("Lad001", "Laden", { state: "failed", operation: "provision", errorCode: "STORE_UNREACHABLE", usage: null }),
    row("Web001", "Website", { writeBlockReason: "checkpoint_mismatch" }),
  ],
  total: 3,
  nextOffset: null,
  usedBytes: 2_200_000_000,
  disk: { freeBytes: 41_000_000_000, totalBytes: 100_000_000_000, measuredAt: "2026-10-17T12:30:00.000Z" },
};

test("the bases tab shows policy, starting values, usage against limits and every state in the first frame", () => {
  const html = render("de", () => createComponent(BasesAdmin, { initialPolicy: policy, initialPage: page }));
  expect(html).toContain("Alle Personen und Agenten");
  expect(html).toContain("höchstens 730 Tage Rohdaten");
  expect(html).toContain("3 Bases · 2,2 GB belegt · 41 GB frei");
  expect(html).toContain("1,8 GB von 5 GB");
  expect(html).toContain("noch nicht gemessen");
  expect(html).toContain("Fehlgeschlagen");
  expect(html).toContain("Erneut versuchen");
  expect(html).toContain("1 Base ist für Schreiben gesperrt");
  expect(html).toContain("Leer neu anlegen");
  expect(html).toContain("Hier stehen nur Mengen");
  // Orphans come from ClickHouse after the page is shown; their place is reserved with a loading line.
  expect(html).toContain("ClickHouse wird geprüft");
});

test("a failed server read shows the error with Try again instead of an empty list", () => {
  const html = render("en", () => createComponent(BasesAdmin, { initialPolicy: null, initialPage: null }));
  expect(html).toContain("Bases could not be loaded");
  expect(html).not.toContain("No bases yet");
});

test("the targets tab names scope and base, and offers the release action when empty", () => {
  const targets: InternalTargetsPage = {
    items: [
      {
        id: "t1",
        baseId: "Lad001",
        baseName: "Laden",
        entry: "shop-01:9100",
        scope: "host_port",
        port: 9100,
        createdAt: "2026-10-01T08:00:00.000Z",
      },
      {
        id: "t2",
        baseId: "Bet001",
        baseName: "Betrieb",
        entry: "10.20.0.0/24",
        scope: "network",
        port: null,
        createdAt: "2026-10-01T08:00:00.000Z",
      },
    ],
    total: 2,
    nextOffset: null,
  };
  const html = render("de", () => createComponent(TargetsAdmin, { initialPage: targets }));
  expect(html).toContain("shop-01:9100");
  expect(html).toContain("Port 9100");
  expect(html).toContain("Netz, alle Ports");
  expect(html).toContain("Ziel freigeben");
  const empty = render("en", () => createComponent(TargetsAdmin, { initialPage: { items: [], total: 0, nextOffset: null } }));
  expect(empty).toContain("No internal targets released");
  expect(render("en", () => createComponent(TargetsAdmin, { initialPage: null }))).toContain("Internal targets could not be loaded");
});

test("admin, base store and not-set-up catalogs are complete in German", () => {
  expect(pulseAdminMessages.check()).toEqual([]);
  expect(baseStoreMessages.check()).toEqual([]);
  expect(notSetUpMessages.check()).toEqual([]);
});
