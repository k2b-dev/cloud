import type { NavProps } from "@k2b/ui/v2";
import type { AdminBaseRow, AdminBasesPage, InternalTargetsPage, PulsePolicy } from "../../store/admin-contracts";
import { fixtureBase } from "../screens/fixtures";
import type { AdminView } from "./AdminScreen";

/** Invented data for the admin screen's tests and previews. */
export const fixtureAdminNav = (view: AdminView): NavProps => ({
  title: "Verwaltung",
  icon: "settings",
  groups: [
    {
      label: "Apps",
      items: [
        { label: "Mail", icon: "mail", href: "/admin/mail" },
        { label: "Pulse", icon: "activity-heartbeat", href: "/admin/pulse" },
        { label: "Datenspeicher", icon: "database", href: "/admin/pulse?view=store", nested: true, current: view === "store" },
        { label: "Basen", icon: "stack-2", href: "/admin/pulse?view=bases", nested: true, current: view === "bases" },
        { label: "Interne Ziele", icon: "route", href: "/admin/pulse?view=targets", nested: true, current: view === "targets" },
      ],
    },
  ],
});

const base = fixtureBase({ id: "x", name: "x" });
const row = (patch: Partial<AdminBaseRow> & Pick<AdminBaseRow, "id" | "name">): AdminBaseRow => ({
  rollupLag: false,
  admins: ["Jana Petersen"],
  adminCount: 1,
  rawRetentionDays: 30,
  rollupRetentionDays: 400,
  sensitiveRetentionHours: 72,
  createdAt: "2026-03-02T08:00:00.000Z",
  store: base.store,
  ...patch,
});

export const fixturePolicy: PulsePolicy = {
  baseCreation: "everyone",
  maxBases: 50,
  maxRawRetentionDays: 365,
  defaultProfile: "normal",
  defaultLimits: base.store.limits,
};

export const fixtureAdminBases: AdminBasesPage = {
  items: [
    row({ id: "b7Kq2mX9", name: "Betrieb Werkstatt Nord", admins: ["Jana Petersen", "Jonas Wolf", "Mira Aydın"], adminCount: 5 }),
    row({ id: "c3Lw8pR1", name: "Webshop", rawRetentionDays: 90 }),
    row({ id: "e8Pv1sJ3", name: "Archiv 2025", store: { ...base.store, writeBlockReason: "checkpoint_mismatch" } }),
    row({
      id: "g6Ts3vL8",
      name: "Altes Lager",
      store: { ...base.store, state: "failed", operation: "provision", errorCode: "STORE_UNREACHABLE" },
    }),
  ],
  total: 4,
  nextOffset: null,
  usedBytes: 12.4 * 1024 ** 3,
  disk: { freeBytes: 180 * 1024 ** 3, totalBytes: 250 * 1024 ** 3, measuredAt: "2026-11-25T09:40:00.000Z" },
};

export const fixtureTargets: InternalTargetsPage = {
  items: [
    {
      id: "t1",
      baseId: "b7Kq2mX9",
      baseName: "Betrieb Werkstatt Nord",
      entry: "srv-01:9100",
      scope: "host_port",
      port: 9100,
      createdAt: "2026-10-02T08:00:00.000Z",
    },
    {
      id: "t2",
      baseId: "b7Kq2mX9",
      baseName: "Betrieb Werkstatt Nord",
      entry: "10.20.0.0/24",
      scope: "network",
      port: null,
      createdAt: "2026-10-02T08:00:00.000Z",
    },
  ],
  total: 2,
  nextOffset: null,
};
