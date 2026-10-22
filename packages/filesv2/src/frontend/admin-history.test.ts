import { describe, expect, test } from "bun:test";
import type { ActivityBasesInput, ActivityEntry, ActivitySide } from "../activity-contracts";
import {
  type AdminActivityBase,
  adminActivityHref,
  adminBaseLabel,
  adminBaseOptions,
  loadAdminBaseLabels,
  adminChannel,
  adminItem,
  adminPlaceDescriber,
  adminTime,
  adminWhat,
  adminWho,
  defaultExportPeriod,
  entryBase,
  exportFileName,
  exportRequest,
  parseAdminActivityFilters,
} from "./admin-history";
import { adminHistoryCatalog } from "./admin-history-messages";
import { type HistoryEnvironment, historyRows } from "./history-actions";
import { historyMessages } from "./history-messages";

// Fictional places and people of the approved mockup; Tuesday 20.10.2026, frozen.
const env: HistoryEnvironment = { now: "2026-10-20T12:30:00.000Z", timeZone: "Europe/Berlin" };
const a = adminHistoryCatalog.resolve(["de"]).t;
const h = historyMessages("de");
const vertrieb: AdminActivityBase = {
  id: "cloud:groups:11111111-1111-4111-8111-111111111111",
  bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  area: "cloud",
  kind: "groups",
  name: "vertrieb",
  displayName: "Team Vertrieb",
  root: "cloud",
  path: "groups/vertrieb",
};
const jana: AdminActivityBase = {
  id: "cloud:users:22222222-2222-4222-8222-222222222222",
  bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  area: "cloud",
  kind: "users",
  name: "jana",
  displayName: "Jana Berger",
  root: "cloud",
  path: "users/jana",
};
const bases = new Map([vertrieb, jana].map((base) => [base.bindingId, base]));
const side = (path: string, base = vertrieb, directory = true): ActivitySide => ({
  visibility: "full",
  source: "snapshot",
  name: path.split("/").at(-1)!,
  path,
  root: base.root,
  baseId: base.bindingId,
  publicBaseId: null,
  itemId: null,
  directory,
  size: null,
  revision: null,
});
let counter = 0;
const entry = (patch: Partial<ActivityEntry> & Pick<ActivityEntry, "action">): ActivityEntry => ({
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  state: "done",
  time: "2026-10-20T12:12:00.000Z",
  startedAt: "2026-10-20T12:12:00.000Z",
  finishedAt: "2026-10-20T12:12:00.000Z",
  actor: { kind: "user", userId: "33333333-3333-4333-8333-333333333333", name: "Lukas Pohl" },
  via: "web",
  before: { visibility: "hidden" },
  after: { visibility: "hidden" },
  batchId: null,
  ...patch,
});

describe("administration history address", () => {
  test("keeps Activity's filters, rejects what Activity rejects, and never takes a single-item path", () => {
    const filters = {
      baseId: vertrieb.id,
      actor: "33333333-3333-4333-8333-333333333333",
      action: "item.move" as const,
      when: "30" as const,
      q: "Angebote 2025",
    };
    const href = adminActivityHref(filters);
    expect(href.startsWith("/admin/filesv2?view=activity&")).toBeTrue();
    expect(parseAdminActivityFilters(new URL(href, "https://files.invalid").searchParams)).toEqual(filters);
    expect(parseAdminActivityFilters(new URLSearchParams(`view=activity&base=${vertrieb.id}&path=Kunden`))).toEqual({
      baseId: vertrieb.id,
    });
    expect(parseAdminActivityFilters(new URLSearchParams("view=activity&what=item.unknown"))).toBeNull();
    expect(parseAdminActivityFilters(new URLSearchParams("view=activity&who=lukas"))).toBeNull();
    expect(parseAdminActivityFilters(new URLSearchParams(`view=activity&q=${"x".repeat(201)}`))).toBeNull();
  });
});

describe("administration history cells", () => {
  test("names storage, delegates, visitors and findings the way the approved table does", () => {
    const delegated = entry({ action: "item.move", via: "agent", after: side("groups/vertrieb/Archiv/2025/Angebote 2025") });
    expect(adminWho(delegated, h, a, env)).toBe("Assistant für Lukas Pohl");
    expect(adminChannel(delegated, h, a, env)).toBe("Agent");
    expect(adminBaseLabel(jana, a, "de")).toBe("Persönlich (Jana Berger)");
    expect(adminBaseLabel({ ...vertrieb, displayName: null }, a, "de")).toBe("Vertrieb");

    const upload = entry({ action: "file.upload", actor: { kind: "visitor", userId: null, name: null }, via: "link" });
    expect(adminWho(upload, h, a, env)).toBe("Upload-Link");
    expect(adminChannel(upload, h, a, env)).toBe("öffentlicher Link");

    const finding = entry({ action: "item.differs", actor: { kind: "observed", userId: null, name: null }, via: "observed" });
    expect(adminWho(finding, h, a, env)).toBe("Ohne Eintrag in Cloud");
    expect(adminChannel(finding, h, a, env)).toBe("bemerkt");

    const mail = entry({ action: "file.create", via: "app:mail", actor: { kind: "user", userId: null, name: "Jana Berger" } });
    expect(adminChannel(mail, h, a, env)).toBe("Andere App");
    expect(adminChannel(mail, h, a, { ...env, appInfo: () => ({ label: "Mail" }) })).toBe("über Mail");
    expect(adminWho(entry({ action: "item.trash", actor: { kind: "user", userId: "x", name: null } }), h, a, env)).toBe("Gelöschtes Konto");
    expect(adminTime(delegated, "de", env)).toBe("20.10. 14:12");
  });

  test("counts only the visible members of a batch and keeps the storage of the side it belongs to", () => {
    const batch = ["Angebote 2025", "Messe", "Preise"].map((name) =>
      entry({ action: "item.move", batchId: "b1", before: side(`groups/vertrieb/${name}`), after: side(`groups/vertrieb/Archiv/${name}`) }),
    );
    const [row] = historyRows(batch, { batches: true });
    expect(adminWhat(row!, a)).toBe("Verschoben (3)");
    expect(adminItem(row!, a)).toBe("Angebote 2025 und 2 weitere");

    const copied = entry({
      action: "item.copy",
      before: side("groups/vertrieb/Plan.pdf"),
      after: side("users/jana/Plan.pdf", jana, false),
    });
    expect(entryBase(copied, bases)).toBe(jana);
    // An archive can move a recorded binding outside its old prefix. Its label remains known.
    expect(entryBase(entry({ action: "item.trash", before: side("archive/old-team/Plan.pdf") }), bases)).toBe(vertrieb);
    expect(
      entryBase(
        entry({
          action: "item.missing",
          before: { visibility: "disappearance", name: "Plan.pdf", path: "x", directory: null, publicBaseId: null },
        }),
        bases,
      ),
    ).toBeNull();
    const describe = adminPlaceDescriber(bases, a, "de");
    const archived = side("archive/old-team/Plan.pdf");
    if (archived.visibility !== "full") throw new Error("fixture");
    expect(describe({ kind: "side", side: archived })).toBeUndefined();
    expect(describe({ kind: "side", side: side("groups/vertrieb/Kunden/Hoffmann/Druckdaten") as never })).toEqual([
      "Team Vertrieb",
      "Kunden",
      "Hoffmann",
    ]);
  });
});

describe("history export request", () => {
  test("opens on the list's range in inclusive UTC days, 30 days by default", () => {
    expect(defaultExportPeriod("30", env.now)).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    expect(defaultExportPeriod(undefined, env.now)).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    expect(defaultExportPeriod("today", env.now)).toEqual({ from: "2026-10-20", to: "2026-10-20" });
    expect(defaultExportPeriod("7", env.now)).toEqual({ from: "2026-10-14", to: "2026-10-20" });
    expect(defaultExportPeriod("365", env.now)).toEqual({ from: "2025-10-21", to: "2026-10-20" });
  });

  test("keeps every list filter, takes storage from the dialog, and counts independently of the format", () => {
    const filters = { baseId: vertrieb.id, actor: "33333333-3333-4333-8333-333333333333", action: "item.move" as const, q: "Angebote" };
    const csv = exportRequest({ from: "2026-09-21", to: "2026-10-20", baseId: jana.id, format: "csv" }, filters);
    const jsonl = exportRequest({ from: "2026-09-21", to: "2026-10-20", baseId: jana.id, format: "jsonl" }, filters);
    expect(csv).toMatchObject({
      status: "ready",
      input: {
        format: "csv",
        from: "2026-09-21",
        to: "2026-10-20",
        baseId: jana.id,
        actor: filters.actor,
        action: "item.move",
        q: "Angebote",
      },
    });
    expect(csv.status === "ready" && jsonl.status === "ready" && csv.key === jsonl.key).toBeTrue();
    const all = exportRequest({ from: "2026-09-21", to: "2026-10-20", baseId: null, format: "csv" }, filters);
    expect(all.status === "ready" && !("baseId" in all.input)).toBeTrue();
    if (csv.status === "ready") expect(exportFileName(csv.input)).toBe("files-activity-2026-09-21-2026-10-20.csv");
  });

  test("refuses a missing, reversed or longer than one calendar year period before asking the server", () => {
    expect(exportRequest({ from: null, to: "2026-10-20", baseId: null, format: "csv" }, {}).status).toBe("missing");
    expect(exportRequest({ from: "2026-10-21", to: "2026-10-20", baseId: null, format: "csv" }, {}).status).toBe("range");
    expect(exportRequest({ from: "2025-10-21", to: "2026-10-20", baseId: null, format: "csv" }, {}).status).toBe("ready");
    expect(exportRequest({ from: "2025-10-20", to: "2026-10-20", baseId: null, format: "csv" }, {}).status).toBe("range");
    expect(exportRequest({ from: "2024-02-29", to: "2025-02-27", baseId: null, format: "csv" }, {}).status).toBe("ready");
    expect(exportRequest({ from: "2024-02-29", to: "2025-02-28", baseId: null, format: "csv" }, {}).status).toBe("range");
  });
});

describe("bounded administrator base metadata", () => {
  test("selector options deduplicate public IDs while both historical binding labels remain addressable", () => {
    const archived = { ...vertrieb, bindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", path: "archive/team" };
    expect(adminBaseOptions([vertrieb, archived, jana], a, "de")).toHaveLength(2);
    const map = new Map([vertrieb, archived].map((base) => [base.bindingId, base]));
    expect(entryBase(entry({ action: "item.trash", before: side("archive/team/old.pdf", archived) }), map)).toBe(archived);
  });

  test("loads only visible missing bindings in 50-ID batches, plus an exact selected public ID", async () => {
    const missing = Array.from({ length: 101 }, (_, index) => ({
      ...vertrieb,
      bindingId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const entries = missing.map((base) => entry({ action: "item.trash", before: side("archive/file.pdf", base) }));
    const requests: ActivityBasesInput[] = [];
    const labels = await loadAdminBaseLabels(
      entries,
      [jana],
      vertrieb.id,
      async (input) => {
        requests.push(input);
        return {
          items: input.baseId ? [vertrieb] : missing.filter((base) => input.bindingIds?.split(",").includes(base.bindingId)),
          next: null,
        };
      },
      new AbortController().signal,
    );
    expect(requests[0]).toEqual({ baseId: vertrieb.id });
    expect(requests.slice(1).map((input) => input.bindingIds!.split(",").length)).toEqual([50, 50, 1]);
    expect(requests.every((input) => !input.after)).toBeTrue();
    expect(labels).toHaveLength(103);
  });

  test("known SSR labels need no client metadata read and cancellation propagates", async () => {
    const entries = [entry({ action: "item.trash", before: side("groups/vertrieb/old") })];
    const never = async () => {
      throw new Error("Unexpected metadata read");
    };
    expect(await loadAdminBaseLabels(entries, [vertrieb], vertrieb.id, never, new AbortController().signal)).toEqual([vertrieb]);
    const controller = new AbortController();
    controller.abort(new Error("left"));
    await expect(loadAdminBaseLabels(entries, [], undefined, never, controller.signal)).rejects.toThrow("left");
  });
});
