import type {
  CodePageAccessRow,
  CodePageActivationRow,
  CodePageData,
  CodePageReady,
  CodePageRun,
  CodePageSecret,
  CodePageTarget,
  CodePageVersion,
} from "./data";

/** Fictional data only: the mailbox of a furniture shop and a logistics space. */
const owner = {
  kind: "resource" as const,
  ref: { type: "mail.mailbox", id: "Mb4kd2" },
  title: "info@moebel-beispiel.de",
  typeTitle: "Mailbox",
};
const ben = { id: "00000000-0000-4000-8000-0000000000b1", name: "Ben Schulz" };
const lea = { id: "00000000-0000-4000-8000-0000000000a1", name: "Lea Muster" };
const mia = { id: "00000000-0000-4000-8000-0000000000c1", name: "Mia Koch" };
const own: CodePageTarget = {
  key: "own",
  ref: owner.ref,
  title: owner.title,
  typeTitle: "Mailbox",
  icon: "ti ti-inbox",
  own: true,
  deleted: false,
  href: "/app/mail/Mb4kd2",
};
const space: CodePageTarget = {
  key: "space",
  ref: { type: "spaces.space", id: "sp_2lg8" },
  title: "Logistik",
  typeTitle: "Space",
  icon: "ti ti-layout-kanban",
  own: false,
  deleted: false,
  href: "/app/spaces/sp_2lg8",
};
const version = (number: number, status: CodePageVersion["status"], active = false): CodePageVersion => ({
  id: `00000000-0000-4000-8000-00000000000${number}`,
  number,
  status,
  createdBy: number === 5 ? lea : ben,
  createdAt: number === 5 ? "2026-11-01T10:12:00.000Z" : "2026-10-28T09:00:00.000Z",
  decisionLabel: status === "approved" && number === 3 ? "selbst freigegeben (einziger Admin)" : null,
  decidedBy: null,
  active,
});
const v4 = version(4, "approved", true);
const v5 = version(5, "submitted");
const run = (
  id: string,
  entrypoint: string,
  state: CodePageRun["state"],
  createdAt: string,
  outcome: string | null = null,
): CodePageRun => ({
  id,
  versionId: v4.id,
  versionNumber: 4,
  trigger: "schedule",
  entrypoint,
  state,
  outcome,
  createdAt,
  startedAt: createdAt,
  endedAt: createdAt,
});
const runs = [
  run("2291a1b2-0000-4000-8000-000000000001", "lieferungenEintragen", "succeeded", "2026-11-01T09:41:00.000Z", "succeeded"),
  run("2290a1b2-0000-4000-8000-000000000002", "anfragenSortieren", "succeeded", "2026-11-01T09:41:00.000Z", "succeeded"),
  run("2286a1b2-0000-4000-8000-000000000003", "lieferungenEintragen", "skipped", "2026-11-01T08:52:00.000Z", "previous_schedule_running"),
  run("2284a1b2-0000-4000-8000-000000000004", "lieferungenEintragen", "failed", "2026-11-01T08:30:00.000Z", "failed"),
];
const access = (
  state: CodePageAccessRow["state"],
  deleted = false,
  removal: Pick<CodePageAccessRow, "removedBy" | "removedAt"> = { removedBy: null, removedAt: null },
): CodePageAccessRow[] => [
  {
    target: own,
    operations: ["mail.conversation.tag", "mail.conversation.assign"],
    state: "present",
    newOperations: [],
    activatedBy: ben,
    activatedAt: "2026-10-14T08:00:00.000Z",
    // Reused unchanged from version 3: it does not say who switched on version 4.
    activatedVersionId: "00000000-0000-4000-8000-000000000003",
    removedBy: null,
    removedAt: null,
  },
  {
    target: { ...space, deleted },
    operations: ["spaces.task.create"],
    state,
    newOperations: [],
    activatedBy: ben,
    activatedAt: "2026-10-28T09:00:00.000Z",
    activatedVersionId: v4.id,
    ...removal,
  },
];
const waitingTargets: CodePageActivationRow[] = [
  { target: own, operations: ["mail.conversation.tag", "mail.conversation.move"], isNew: true },
  { target: space, operations: ["spaces.task.create"], isNew: true },
];

const ready = (overrides: Partial<CodePageReady> = {}): CodePageReady => ({
  kind: "ready",
  code: { id: "c_3mfa", title: "Code von info@", state: "active", activeVersionId: v4.id, pauseReason: null },
  permission: "editor",
  versions: [v5, v4, version(3, "approved")],
  versionsFailed: false,
  moreVersions: false,
  active: v4,
  waiting: null,
  attentionReasons: null,
  internet: { active: ["https://bank.example", "https://status.example:8443"], waiting: ["https://bank.example", "https://new.example"] },
  automations: [
    {
      entrypoint: "anfragenSortieren",
      kind: "schedule",
      cron: "*/15 * * * *",
      isNew: false,
      lastRun: runs[1]!,
      missingTargets: [],
      missingProven: false,
      accessUnknown: false,
    },
    {
      entrypoint: "wochenbericht",
      kind: "schedule",
      cron: "0 7 * * 1",
      isNew: false,
      lastRun: null,
      missingTargets: [],
      missingProven: false,
      accessUnknown: false,
    },
  ],
  access: access("present"),
  waitingTargets: null,
  runs: { items: runs, nextCursor: null },
  run: null,
  diff: null,
  selectionFailed: false,
  secrets: null,
  ...overrides,
});

export const codePageFixture = (
  state:
    | "no-internet"
    | "internet-failed"
    | "overview"
    | "waiting"
    | "approval"
    | "removed"
    | "removed-unnamed"
    | "removed-unknown"
    | "deleted"
    | "paused"
    | "runs"
    | "run-failed"
    | "run-unclassified"
    | "versions"
    | "versions-failed"
    | "waiting-unreadable"
    | "internet"
    | "reader"
    | "secrets"
    | "secrets-empty"
    | "secrets-error"
    | "secrets-replaced"
    | "secrets-submitted"
    | "secrets-unsubmitted"
    | "secrets-deleted"
    | "activated"
    | "empty"
    | "no-access"
    | "error",
  locale = "de",
): CodePageData => {
  const base: Omit<CodePageData, "state" | "tab"> = {
    owner,
    href: "/app/mail/Mb4kd2/code",
    canManageOwner: true,
    activation: { allowed: true },
    editor: { provider: "assistant", label: "Gustav" },
    dates: { locale, timeZone: "Europe/Berlin", now: "2026-11-01T10:30:00.000Z" },
    activatedNotice: null,
  };
  switch (state) {
    case "empty":
      return { ...base, tab: "overview", state: { kind: "none" } };
    case "no-access":
      return { ...base, canManageOwner: false, tab: "overview", state: { kind: "no-access" } };
    case "error":
      return { ...base, tab: "overview", state: { kind: "error" } };
    case "waiting":
      return {
        ...base,
        tab: "overview",
        state: ready({
          waiting: v5,
          waitingTargets,
          automations: [
            ...ready().automations!,
            {
              entrypoint: "lieferungenEintragen",
              kind: "schedule",
              cron: "0 8 * * 1-5",
              isNew: true,
              lastRun: null,
              missingTargets: [],
              missingProven: false,
              accessUnknown: false,
            },
          ],
          access: [
            ...access("present"),
            {
              target: space,
              operations: ["spaces.task.create"],
              state: "new" as const,
              newOperations: ["spaces.task.create"],
              activatedBy: null,
              activatedAt: null,
              activatedVersionId: null,
              removedBy: null,
              removedAt: null,
            },
          ].filter((row, index) => index !== 1),
        }),
      };
    case "approval":
      return { ...base, tab: "overview", state: ready({ waiting: { ...v5, status: "pending" }, waitingTargets }) };
    case "removed":
    case "removed-unnamed":
    case "removed-unknown":
      // „lieferungenEintragen“ failed at the space whose access was removed; „anfragenSortieren“ keeps running.
      // Mia Koch removed it at 11:20; a guest does not see her name, and without its audit event nobody knows who.
      return {
        ...base,
        tab: "overview",
        state: ready({
          access: access(
            "removed",
            false,
            state === "removed-unknown"
              ? { removedBy: null, removedAt: null }
              : { removedBy: state === "removed" ? mia : null, removedAt: "2026-11-01T10:20:00.000Z" },
          ),
          automations: [
            {
              entrypoint: "anfragenSortieren",
              kind: "schedule",
              cron: "*/15 * * * *",
              isNew: false,
              lastRun: runs[1]!,
              missingTargets: [],
              missingProven: false,
              accessUnknown: false,
            },
            {
              entrypoint: "lieferungenEintragen",
              kind: "schedule",
              cron: "0 8 * * 1-5",
              isNew: false,
              lastRun: runs[3]!,
              missingTargets: ["space"],
              missingProven: true,
              accessUnknown: false,
            },
          ],
        }),
      };
    case "deleted":
      return { ...base, tab: "overview", state: ready({ access: access("removed", true) }) };
    case "paused":
      return { ...base, tab: "overview", state: ready({ code: { ...ready().code, state: "paused" } }) };
    case "activated":
      return { ...base, tab: "overview", activatedNotice: 4, state: ready() };
    case "runs":
      return {
        ...base,
        tab: "runs",
        state: ready({
          run: {
            run: runs[0]!,
            calls: [
              {
                ordinal: 1,
                kind: "action",
                capability: "mail.conversation.move",
                target: owner.ref,
                refs: [],
                accessRefused: false,
                state: "succeeded",
                summary: "in Ordner „Lieferungen“ verschoben",
              },
              {
                ordinal: 2,
                kind: "action",
                capability: "spaces.task.create",
                target: space.ref,
                refs: [],
                accessRefused: false,
                state: "succeeded",
                summary: "Karte „Lieferung KW 45 – Rampe 2“ angelegt",
              },
            ],
            nextCallCursor: null,
            input: null,
            inputTooLarge: false,
          },
        }),
      };
    case "run-failed":
      return {
        ...base,
        tab: "runs",
        state: ready({
          run: {
            run: runs[3]!,
            calls: [
              {
                ordinal: 1,
                kind: "action",
                capability: "mail.conversation.move",
                target: owner.ref,
                refs: [],
                accessRefused: false,
                state: "succeeded",
                summary: "in Ordner „Lieferungen“ verschoben",
              },
              {
                ordinal: 2,
                kind: "action",
                capability: "spaces.task.create",
                target: space.ref,
                refs: [],
                accessRefused: true,
                state: "failed",
                summary: "Space Logistik nicht erreichbar · Zeitüberschreitung nach 10 s",
              },
            ],
            nextCallCursor: null,
            input: { messageId: "m_81k2" },
            inputTooLarge: false,
          },
        }),
      };
    case "run-unclassified":
      // 20 reads loaded, more calls follow: whether an action ran is not known yet.
      return {
        ...base,
        tab: "runs",
        state: ready({
          run: {
            run: runs[3]!,
            calls: Array.from({ length: 20 }, (_, index) => ({
              ordinal: index + 1,
              kind: "query" as const,
              capability: "mail.conversation.list",
              target: owner.ref,
              refs: [],
              accessRefused: false,
              state: "succeeded" as const,
              summary: "12 Unterhaltungen",
            })),
            nextCallCursor: 20,
            input: null,
            inputTooLarge: false,
          },
        }),
      };
    case "internet":
      // The running version calls one API with a credential; version 5 adds a second origin.
      return {
        ...base,
        tab: "overview",
        state: ready({
          waiting: v5,
          waitingTargets,
          internet: {
            active: ["https://api.spedition-probe.example"],
            waiting: ["https://api.spedition-probe.example", "https://tracking.example:8443"],
          },
        }),
      };
    case "waiting-unreadable":
      // The new target is a space the person may not read: only its ID is known to the page.
      return {
        ...base,
        tab: "overview",
        state: ready({
          waiting: v5,
          waitingTargets: [
            waitingTargets[0]!,
            {
              target: { ...space, key: "hidden", ref: { type: "spaces.space", id: "sp_9zz9" }, title: null, href: null },
              operations: ["spaces.task.create"],
              isNew: true,
            },
          ],
        }),
      };
    case "no-internet":
      return { ...base, tab: "overview", state: ready({ internet: { active: [], waiting: [] } }) };
    case "internet-failed":
      return { ...base, tab: "overview", state: ready({ internet: { active: null, waiting: [] } }) };
    case "versions-failed":
      return { ...base, tab: "overview", state: ready({ waiting: v5, waitingTargets, versionsFailed: true }) };
    case "reader":
      return {
        ...base,
        canManageOwner: false,
        tab: "runs",
        state: ready({
          permission: "reader",
          waiting: v5,
          waitingTargets,
          run: { run: runs[3]!, calls: null, nextCallCursor: null, input: null, inputTooLarge: false },
        }),
      };
    case "secrets":
    case "secrets-empty":
    case "secrets-error":
    case "secrets-replaced":
    case "secrets-submitted":
    case "secrets-unsubmitted":
    case "secrets-deleted": {
      const secret: CodePageSecret = {
        name: "LAGER_TOKEN",
        binding_revision: "00000000-0000-4000-8000-0000000000c1",
        origin: "https://api.lager-beispiel.de",
        pathPrefix: "/v2/",
        headers: ["authorization"],
        configured: state !== "secrets-deleted",
        valueSetBy: ben,
        valueSetAt: "2026-10-20T09:00:00.000Z",
        usedIn: [{ number: 4, state: "active" }],
        unsubmitted: state === "secrets-unsubmitted",
      };
      const notice = state === "secrets-replaced" ? "replaced" : state === "secrets-submitted" ? "submitted" : null;
      return {
        ...base,
        tab: "secrets",
        state: ready({
          waiting: state === "secrets-submitted" ? { ...v5, status: "pending" } : null,
          secrets:
            state === "secrets-error"
              ? null
              : {
                  items: state === "secrets-empty" ? [] : [secret, { ...secret, name: "WETTER_KEY", usedIn: [], unsubmitted: false }],
                  more: false,
                  selected: state === "secrets-empty" ? null : secret.name,
                  notice,
                  latest: { id: "00000000-0000-4000-8000-0000000000d4", number: 4 },
                },
        }),
      };
    }
    case "versions":
      return {
        ...base,
        tab: "versions",
        state: ready({
          waiting: v5,
          waitingTargets,
          diff: {
            version: v5,
            comparison: 4,
            staleComparison: false,
            internet: ["https://version.example:8443"],
            files: [
              {
                path: "code.ts",
                lines: [
                  { kind: "same", text: 'import { app, owner, spaces } from "@sdk";' },
                  { kind: "add", text: 'const logistik = spaces.space("sp_2lg8");' },
                  { kind: "same", text: "" },
                  { kind: "same", text: 'app.schedule("*/15 * * * *", async () => {' },
                  { kind: "del", text: '  await owner.conversation.tag({ tag: "Anfrage" });' },
                  { kind: "add", text: '  await owner.conversation.move({ folder: "Lieferungen" });' },
                  { kind: "add", text: '  await logistik.task.create({ title: "Lieferung", idempotencyKey: "lieferung:m_81k2" });' },
                  { kind: "same", text: "});" },
                ],
              },
            ],
            permissions: [
              { operation: "mail.conversation.move", target: own, file: "code.ts", line: 6 },
              { operation: "spaces.task.create", target: space, file: "code.ts", line: 7 },
            ],
          },
        }),
      };
    default:
      return { ...base, tab: "overview", state: ready() };
  }
};
