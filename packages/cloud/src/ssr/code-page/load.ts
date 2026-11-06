import type { Context } from "hono";
import { z } from "zod";
import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "../../capabilities/server";
import type { CapabilityCaller } from "../../capabilities/server-invoke";
import { type CloudResourceRef, cloudResourceRefAppId } from "../../contracts/capabilities";
import { cloudResourcePageHref } from "../../contracts/resource-pages";
import { sql } from "../../runtime/clients";
import { getDateConfig, getLocale, isAppSessionActor } from "../../server";
import { visiblePanelProviders } from "../app-navigation";
import { getDisplayRuntimeContext } from "../runtime";
import { AttentionSchema } from "./attention-schema";
import { loadCodeRunCallsForDetail } from "./calls";
import {
  AutomationListSchema,
  CodeListSchema,
  type CodePageAutomation,
  type CodePageData,
  type CodePageDiff,
  type CodePageInvoke,
  type CodePagePerson,
  type CodePageReady,
  type CodePageRefusal,
  type CodePageRun,
  type CodePageRunDetail,
  type CodePageSecret,
  type CodePageSecrets,
  type CodePageTab,
  type CodePageTarget,
  type CodePageTargetRow,
  type CodePageVersion,
  CodeReadSchema,
  coreQuery,
  ManifestSchema,
  RunListSchema,
  RunReadSchema,
  SecretListSchema,
  VersionDiffSchema,
  VersionListSchema,
  VersionReadSchema,
} from "./data";

/** Core pages run metadata and versions in pages of 20. */
const PAGE = 20;
/** Core's default manifest budget is 1 MiB: 64 chunks of 16 Ki code units. A larger manifest shows as unreadable. */
const MANIFEST_CHUNKS = 64;
/** Pages of 20 secrets read for one page view; Core bounds each page by items and bytes. */
const SECRET_PAGES = 10;
const SECRET_NOTICES = ["replaced", "submitted", "saved", "submit-failed"] as const;

/** The owning resource, or null for personal Code. */
const ownerRefOf = (owner: LoadCodePageOptions["owner"]) => ("ref" in owner ? owner.ref : null);
const ownerTitleOf = (owner: LoadCodePageOptions["owner"]) => ("ref" in owner ? owner.title : "");
const isOwnRef = (ref: { type: string; id: string }, owner: LoadCodePageOptions["owner"]) => {
  const own = ownerRefOf(owner);
  return own !== null && sameRef(ref, own);
};
export const targetKey = (ref: { type: string; id: string }) => `${ref.type}\u0000${ref.id}`;
const sameRef = (a: { type: string; id: string }, b: { type: string; id: string }) => a.type === b.type && a.id === b.id;

export type LoadCodePageOptions = {
  /**
   * The resource whose Code this page shows and its name as the owner app shows it, or one personal Code by its ID;
   * personal Code runs as its person and has no place of its own.
   */
  owner: { ref: CloudResourceRef; title: string } | { codeId: string };
  /** This page's path without query, for tabs and "Copy link". */
  href: string;
  /** The person administers the owner, so an empty page offers to create Code. The owner app decides this. */
  canManageOwner: boolean;
};

/** The caller's own credentials, forwarded unchanged: Core decides what this person may see. */
const callerOf = (c: Context): CapabilityCaller => ({
  cookie: c.req.header("cookie"),
  authorization: c.req.header("authorization"),
  locale: getLocale(c),
  signal: c.req.raw.signal,
  requestId: c.req.header("x-request-id"),
});

const readTab = (value: string | null): CodePageTab =>
  value === "runs" || value === "versions" || value === "secrets" ? value : "overview";
const uuid = z.uuid();

/** Who is looking: only members may see other people's names, as in the directory. */
export type Viewer = { id: string | null; directory: boolean };
/**
 * Display names for the people a page mentions; unknown or deleted accounts are left out. Like directory search,
 * guests see only their own name.
 */
export const visiblePersonIds = (ids: Iterable<string | null | undefined>, viewer: Viewer): string[] =>
  [
    ...new Set(
      [...ids].filter((id): id is string => typeof id === "string" && uuid.safeParse(id).success && (viewer.directory || id === viewer.id)),
    ),
  ].slice(0, 100);
export const loadPeople = async (ids: Iterable<string | null | undefined>, viewer: Viewer): Promise<Map<string, CodePagePerson>> => {
  const unique = visiblePersonIds(ids, viewer);
  if (unique.length === 0) return new Map();
  const rows = await sql<{ id: string; display_name: string | null; given_name: string | null; sn: string | null; uid: string }[]>`
    SELECT id, display_name, given_name, sn, uid FROM auth.users WHERE id = ANY(${sql.array(unique, "uuid")}::uuid[])`;
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, name: row.display_name?.trim() || `${row.given_name ?? ""} ${row.sn ?? ""}`.trim() || row.uid },
    ]),
  );
};

type CatalogApp = Awaited<ReturnType<typeof getCapabilityCatalogApp>>;
/** One registry catalog read per app and page, shared by every target of that app; never a call to the app. */
export const catalogCache = (locale: string) => {
  const apps = new Map<string, Promise<CatalogApp | null>>();
  return (appId: string) => {
    let app = apps.get(appId);
    if (!app) {
      app = getCapabilityCatalogApp(appId, locale).catch(() => null);
      apps.set(appId, app);
    }
    return app;
  };
};

/**
 * Describe a target from its app's manifest in the registry: type name, icon, and a link when the type's page pattern
 * needs only the ID. The target's app is never asked, so a foreign target is never named and the page costs no call
 * per target; the app names it on its own page, for whoever may read it.
 */
export const describeTarget = async (
  ref: { type: string; id: string },
  owner: LoadCodePageOptions["owner"],
  catalog: ReturnType<typeof catalogCache>,
): Promise<CodePageTarget> => {
  const own = isOwnRef(ref, owner);
  const base: CodePageTarget = {
    key: targetKey(ref),
    ref,
    title: own ? ownerTitleOf(owner) : null,
    typeTitle: null,
    icon: null,
    own,
    href: null,
  };
  try {
    if (ref.type === "app") {
      // An app-wide target: the receiving app as a whole, whose name every person in the installation sees.
      const app = await catalog(ref.id);
      return app?.ok && app.data ? { ...base, title: app.data.appName, icon: app.data.appIcon ?? null } : base;
    }
    const app = await catalog(cloudResourceRefAppId(ref));
    if (!app?.ok || !app.data) return base;
    const localType = ref.type.slice(app.data.appId.length + 1);
    const type = app.data.manifest.types.find((candidate) => candidate.localId === localType);
    const href =
      (app.data.manifest.resourcePages ?? [])
        .filter((page) => page.type === localType)
        .map((page) => cloudResourcePageHref(page.path, ref.id))
        .find((path) => path !== null) ?? null;
    return { ...base, typeTitle: type?.title ?? null, icon: type?.icon ?? null, href };
  } catch {
    return base;
  }
};

/** The title of a called Query or Action in the caller's locale, from the same registry manifest; null when unknown. */
const capabilityTitle = async (capability: string, catalog: ReturnType<typeof catalogCache>): Promise<string | null> => {
  const appId = capability.split(".")[0]!;
  const app = await catalog(appId);
  if (!app?.ok || !app.data) return null;
  const localId = capability.slice(appId.length + 1);
  return [...app.data.manifest.actions, ...app.data.manifest.queries].find((entry) => entry.localId === localId)?.title ?? null;
};

/** Reads a whole manifest in bounded chunks; null when it cannot be read or parsed. */
const loadManifest = async (invoke: CodePageInvoke, codeId: string, versionId: string) => {
  let text = "";
  let offset: number | null = 0;
  for (let chunk = 0; offset !== null && chunk < MANIFEST_CHUNKS; chunk++) {
    const from: number = offset;
    const read = await invoke(
      coreQuery("code.version.read", { codeId, versionId, content: { kind: "manifest" }, offset: from }),
      VersionReadSchema,
    );
    const content: { text: string; nextOffset: number | null } | null = read.ok ? read.data.data.content : null;
    if (!content) return null;
    text += content.text;
    offset = content.nextOffset;
  }
  if (offset !== null) return null;
  try {
    return ManifestSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
};

/** Core turns a permission without a target into a grant at the receiving app; dynamic personal IDs have none. */
export const permissionRef = (permission: { operation: string; target: { type: string; id: string | null } | null }) =>
  permission.target === null
    ? { type: "app", id: permission.operation.split(".")[0]! }
    : permission.target.id === null
      ? null
      : { type: permission.target.type, id: permission.target.id };

const versionView = (
  receipt: Pick<z.infer<typeof VersionListSchema>["items"][number], "version"> &
    Partial<Pick<z.infer<typeof VersionListSchema>["items"][number], "status" | "decision">>,
  people: Map<string, CodePagePerson>,
  activeVersionId: string | null,
): CodePageVersion => ({
  id: receipt.version.id,
  number: receipt.version.number,
  status: receipt.status ?? null,
  createdBy: receipt.version.createdBy ? (people.get(receipt.version.createdBy) ?? null) : null,
  createdAt: receipt.version.createdAt,
  decisionLabel: receipt.decision?.label ?? null,
  decidedBy: receipt.decision?.decidedBy ? (people.get(receipt.decision.decidedBy) ?? null) : null,
  active: receipt.version.id === activeVersionId,
});

/** Statuses that keep a newer version waiting to be switched on. */
const WAITING = new Set(["submitted", "pending", "approved"]);

/** A recorded refused call as the Code page shows it, from the registry only; Administration › Code uses it too. */
export const presentRefusedCall = async (
  call: { capability: string; target: { type: string; id: string } | null },
  owner: LoadCodePageOptions["owner"],
  catalog: ReturnType<typeof catalogCache>,
): Promise<NonNullable<CodePageRefusal["call"]>> => ({
  capability: call.capability,
  title: await capabilityTitle(call.capability, catalog).catch(() => null),
  target: call.target ? await describeTarget(call.target, owner, catalog) : null,
});

/** Refusal kinds the page explains; the others stay a plain failed run. */
const SHOWN_REFUSALS = new Set<CodePageRefusal["kind"]>(["target_refused", "policy", "approval"]);
const isShownRefusal = (kind: string | null): kind is CodePageRefusal["kind"] => SHOWN_REFUSALS.has(kind as CodePageRefusal["kind"]);

const loadReady = async (
  c: Context,
  options: LoadCodePageOptions,
  invoke: CodePageInvoke,
  listed: z.infer<typeof CodeListSchema>["items"][number],
  tab: CodePageTab,
  url: URL,
  viewer: Viewer,
  /** The Code's owner in Core's terms, for the attention query. */
  codeOwner: { kind: "resource"; ref: CloudResourceRef } | { kind: "person"; userId: string },
): Promise<CodePageReady> => {
  const catalog = catalogCache(getLocale(c));
  const code = listed;
  const [versionsResult, runsResult, attentionResult, automationResult] = await Promise.all([
    invoke(coreQuery("code.version.list", { codeId: code.id, limit: PAGE }), VersionListSchema),
    invoke(coreQuery("code.run.list", { codeId: code.id, limit: PAGE }), RunListSchema),
    // The same answer the owner's navigation gets, so its dot and this page agree.
    invoke(coreQuery("code.attention", { owner: codeOwner }), AttentionSchema).catch(() => null),
    // Only the next run comes from here; without it the row simply does not name one.
    invoke(coreQuery("code.automation.list", { codeId: code.id }), AutomationListSchema).catch(() => null),
  ]);
  const receipts = versionsResult.ok ? versionsResult.data.data.items : [];
  const latest = receipts[0];
  const activeReceipt = receipts.find((receipt) => receipt.version.id === code.activeVersionId);
  const waitingReceipt =
    latest &&
    latest.version.id !== code.activeVersionId &&
    WAITING.has(latest.status) &&
    (!activeReceipt || latest.version.number > activeReceipt.version.number)
      ? latest
      : undefined;
  const [activeManifest, waitingManifest] = await Promise.all([
    code.activeVersionId ? loadManifest(invoke, code.id, code.activeVersionId) : Promise.resolve(null),
    waitingReceipt ? loadManifest(invoke, code.id, waitingReceipt.version.id) : Promise.resolve(null),
  ]);
  const numbers = new Map(receipts.map((receipt) => [receipt.version.id, receipt.version.number]));
  // The running or a linked version can be older than the first history page; read its own metadata then.
  const versionMeta = async (versionId: string | null | undefined) => {
    if (!versionId || receipts.some((receipt) => receipt.version.id === versionId)) return null;
    const read = await invoke(coreQuery("code.version.read", { codeId: code.id, versionId }), VersionReadSchema);
    return read.ok ? read.data.data.version : null;
  };
  const runs: CodePageRun[] | null = runsResult.ok
    ? runsResult.data.data.items.map((run) => ({ ...run, versionNumber: numbers.get(run.versionId) ?? null }))
    : null;

  // Selection: a run on the runs tab (the newest by default), a version on the versions tab.
  const runParam = url.searchParams.get("run");
  const selectedRunId = tab === "runs" ? (runParam && uuid.safeParse(runParam).success ? runParam : (runs?.[0]?.id ?? null)) : null;
  const versionParam = url.searchParams.get("version");
  const selectedVersionId =
    tab === "versions"
      ? versionParam && uuid.safeParse(versionParam).success
        ? versionParam
        : (waitingReceipt?.version.id ?? code.activeVersionId ?? latest?.version.id ?? null)
      : null;
  // The newest run that ended; "skipped" and "cancelled" are not a run's result.
  const lastRun = runs?.find((run) => run.state === "succeeded" || run.state === "failed") ?? null;
  // Only a failed run with a recorded target refusal raises the notice; editors read that one call once at Core.
  const lastRefused = tab === "overview" && lastRun?.state === "failed" && lastRun.firstRefusedCallOrdinal ? lastRun : null;
  const [runCalls, diffResult, olderActive, olderSelected, lastRead] = await Promise.all([
    selectedRunId ? loadCodeRunCallsForDetail(invoke, code.id, selectedRunId, getLocale(c)) : Promise.resolve(null),
    selectedVersionId
      ? invoke(coreQuery("code.version.diff", { codeId: code.id, versionId: selectedVersionId }), VersionDiffSchema)
      : Promise.resolve(null),
    versionMeta(code.activeVersionId),
    selectedVersionId !== code.activeVersionId ? versionMeta(selectedVersionId) : Promise.resolve(null),
    lastRefused && code.permission === "editor"
      ? invoke(coreQuery("code.run.read", { codeId: code.id, runId: lastRefused.id }), RunReadSchema).catch(() => null)
      : Promise.resolve(null),
  ]);
  for (const version of [olderActive, olderSelected]) if (version) numbers.set(version.id, version.number);

  // Targets: what the running version calls, plus what the waiting version would add, as the checker read them.
  const byTarget = (manifest: z.infer<typeof ManifestSchema> | null) => {
    const map = new Map<string, { ref: { type: string; id: string }; operations: Set<string> }>();
    for (const permission of manifest?.permissions ?? []) {
      const ref = permissionRef(permission);
      if (!ref) continue;
      const entry = map.get(targetKey(ref)) ?? { ref, operations: new Set<string>() };
      entry.operations.add(permission.operation);
      map.set(targetKey(ref), entry);
    }
    return map;
  };
  const activeByTarget = byTarget(activeManifest);
  const waitingByTarget = byTarget(waitingManifest);
  const diffPermissions = diffResult?.ok ? diffResult.data.data.permissions : [];
  const ownerRef = ownerRefOf(options.owner);
  /** The refused call of a failed run: the target refusal Core recorded, else the first policy or approval refusal loaded. */
  const refusalOf = (
    run: CodePageRun,
    recorded: { ordinal: number; capability: string; target: { type: string; id: string } | null } | null | undefined,
    loaded:
      | {
          ordinal: number;
          capability: string;
          target: { type: string; id: string } | null;
          refusal: string | null;
          refusalCode?: "code_ai_budget_limit";
        }[]
      | null,
  ) => {
    if (run.state !== "failed") return null;
    // The target refusal Core recorded wins, so the overview and the run's detail always name the same call.
    const first =
      (recorded ? { ...recorded, kind: "target_refused" as const } : undefined) ??
      (loaded ?? [])
        .flatMap((call) => (call.refusal === "policy" || call.refusal === "approval" ? [{ ...call, kind: call.refusal }] : []))
        .sort((a, b) => a.ordinal - b.ordinal)[0];
    if (first && isShownRefusal(first.kind)) return { run, kind: first.kind, call: first };
    // Readers see no calls, only that a target refused one.
    return loaded === null && run.firstRefusedCallOrdinal ? { run, kind: "target_refused" as const, call: null } : null;
  };
  const lastContents = lastRead?.ok ? lastRead.data.data.contents : null;
  const overviewRefusal = lastRefused ? refusalOf(lastRefused, lastContents?.firstRefusedCall, lastContents ? [] : null) : null;
  const detailRefusal = runCalls
    ? refusalOf({ ...runCalls.run, versionNumber: null }, runCalls.firstRefusedCall, runCalls.readable ? runCalls.calls : null)
    : null;
  const refs = new Map<string, { type: string; id: string }>(ownerRef ? [[targetKey(ownerRef), ownerRef]] : []);
  for (const entry of [...activeByTarget.values(), ...waitingByTarget.values()]) refs.set(targetKey(entry.ref), entry.ref);
  for (const permission of diffPermissions) {
    const ref = permissionRef(permission);
    if (ref) refs.set(targetKey(ref), ref);
  }
  for (const refusal of [overviewRefusal, detailRefusal])
    if (refusal?.call?.target) refs.set(targetKey(refusal.call.target), refusal.call.target);
  // Registry reads only, one per app and page: a version calls at most 200 operations.
  const targets = new Map(
    (await Promise.all([...refs.values()].map((ref) => describeTarget(ref, options.owner, catalog)))).map((target) => [target.key, target]),
  );
  const targetOf = (ref: { type: string; id: string }): CodePageTarget =>
    targets.get(targetKey(ref)) ?? {
      key: targetKey(ref),
      ref,
      title: isOwnRef(ref, options.owner) ? ownerTitleOf(options.owner) : null,
      typeTitle: null,
      icon: null,
      own: isOwnRef(ref, options.owner),
      href: null,
    };
  const presentRefusal = async (refusal: ReturnType<typeof refusalOf>): Promise<CodePageRefusal | null> =>
    refusal && {
      kind: refusal.kind,
      ...(refusal.call && "refusalCode" in refusal.call && refusal.call.refusalCode ? { code: refusal.call.refusalCode } : {}),
      runId: refusal.run.id,
      versionId: refusal.run.versionId,
      call: refusal.call && {
        capability: refusal.call.capability,
        title: await capabilityTitle(refusal.call.capability, catalog).catch(() => null),
        target: refusal.call.target ? targetOf(refusal.call.target) : null,
      },
    };
  const [refusal, runRefusal] = await Promise.all([presentRefusal(overviewRefusal), presentRefusal(detailRefusal)]);

  const people = await loadPeople(
    [
      ...receipts.flatMap((receipt) => [receipt.version.createdBy, receipt.decision?.decidedBy]),
      olderActive?.createdBy,
      olderSelected?.createdBy,
    ],
    viewer,
  ).catch(() => new Map<string, CodePagePerson>());
  const targetRows: CodePageTargetRow[] | null =
    (code.activeVersionId && !activeManifest) || (waitingReceipt && !waitingManifest)
      ? null
      : [
          ...[...activeByTarget.values()].map((entry) => ({
            target: targetOf(entry.ref),
            operations: [...entry.operations],
            newOperations: [...(waitingByTarget.get(targetKey(entry.ref))?.operations ?? [])].filter(
              (operation) => !entry.operations.has(operation),
            ),
          })),
          ...[...waitingByTarget.values()]
            .filter((entry) => !activeByTarget.has(targetKey(entry.ref)))
            .map((entry) => ({ target: targetOf(entry.ref), operations: [], newOperations: [...entry.operations] })),
        ];

  const waitingTargets =
    waitingReceipt && waitingManifest
      ? [
          // A resource owner is checked on every switch-on, also when the Code only works on itself.
          ...(!ownerRef || waitingByTarget.has(targetKey(ownerRef))
            ? []
            : [{ target: targetOf(ownerRef), operations: [] as string[], isNew: false }]),
          ...[...waitingByTarget.values()].map((entry) => {
            const present = activeByTarget.get(targetKey(entry.ref))?.operations;
            return {
              target: targetOf(entry.ref),
              operations: [...entry.operations],
              isNew: !present || [...entry.operations].some((operation) => !present.has(operation)),
            };
          }),
        ]
      : null;
  // A skipped tick or a cancelled start is not a run's result.
  const nextRuns = new Map(automationResult?.ok ? automationResult.data.data.items.map((item) => [item.entrypoint, item.nextRunAt]) : []);
  const lastRunOf = (entrypoint: string) =>
    runs?.find((run) => run.entrypoint === entrypoint && run.state !== "skipped" && run.state !== "cancelled") ?? null;
  const automationsFrom = (manifest: z.infer<typeof ManifestSchema>, isNew: (entrypoint: string) => boolean): CodePageAutomation[] =>
    manifest.entrypoints.map((entry) => ({
      entrypoint: entry.entrypoint,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      kind: entry.kind,
      cron: entry.cron,
      isNew: isNew(entry.entrypoint),
      lastRun: lastRunOf(entry.entrypoint),
      nextRunAt: isNew(entry.entrypoint) ? null : (nextRuns.get(entry.entrypoint) ?? null),
    }));
  const activeEntrypoints = new Set(activeManifest?.entrypoints.map((entry) => entry.entrypoint) ?? []);
  const automations =
    (code.activeVersionId && !activeManifest) || (waitingReceipt && !waitingManifest)
      ? null
      : [
          ...(activeManifest ? automationsFrom(activeManifest, () => false) : []),
          ...(waitingManifest
            ? automationsFrom(waitingManifest, (entrypoint) => !activeEntrypoints.has(entrypoint)).filter((item) => item.isNew)
            : []),
        ];

  const versions = receipts.map((receipt) => versionView(receipt, people, code.activeVersionId));
  /** Every read goes through Core's editor-only list; a failure on any page shows as an error, never as a shorter list. */
  const loadSecrets = async (): Promise<CodePageSecrets | null> => {
    // Without the versions a write could not tell whether it must submit one.
    if (!versionsResult.ok) return null;
    const listed: z.infer<typeof SecretListSchema>["items"] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SECRET_PAGES && (page === 0 || cursor); page++) {
      const after: string | null = cursor;
      const read = await invoke(
        coreQuery("code.secret.list", { codeId: code.id, limit: PAGE, ...(after ? { cursor: after } : {}) }),
        SecretListSchema,
      );
      if (!read.ok) return null;
      const items: z.infer<typeof SecretListSchema> = read.data.data;
      listed.push(...items.items);
      cursor = items.nextCursor;
    }
    const setters = await loadPeople(
      listed.map((item) => item.valueSetBy),
      viewer,
    ).catch(() => new Map<string, CodePagePerson>());
    // A rejected, expired or withdrawn submission can never run, so its binding still needs a version.
    const latestUsable = latest && !["rejected", "expired", "cancelled"].includes(latest.status);
    const latestManifest = !latestUsable
      ? null
      : latest.version.id === code.activeVersionId
        ? activeManifest
        : latest.version.id === waitingReceipt?.version.id
          ? waitingManifest
          : await loadManifest(invoke, code.id, latest.version.id);
    const items = listed.map((item): CodePageSecret => {
      const carries = (manifest: z.infer<typeof ManifestSchema> | null) =>
        manifest?.secrets?.some((binding) => binding.binding_revision === item.binding_revision) ?? false;
      return {
        ...item,
        valueSetBy: item.valueSetBy ? (setters.get(item.valueSetBy) ?? null) : null,
        usedIn: [
          ...(activeVersion && activeManifest?.secrets?.some((binding) => binding.name === item.name)
            ? [{ number: activeVersion.number, state: "active" as const }]
            : []),
          ...(waitingReceipt && waitingManifest?.secrets?.some((binding) => binding.name === item.name)
            ? [{ number: waitingReceipt.version.number, state: "waiting" as const }]
            : []),
        ],
        unsubmitted:
          !item.configured || !latest || carries(activeManifest) || carries(latestManifest)
            ? false
            : latestUsable && !latestManifest
              ? null
              : true,
      };
    });
    const wanted = url.searchParams.get("secret");
    return {
      items,
      more: cursor !== null,
      selected: items.find((item) => item.name === wanted)?.name ?? items[0]?.name ?? null,
      notice: SECRET_NOTICES.find((notice) => notice === url.searchParams.get("notice")) ?? null,
      latest: latest ? { id: latest.version.id, number: latest.version.number } : null,
    };
  };
  const activeVersion =
    versions.find((version) => version.active) ??
    (olderActive ? versionView({ version: olderActive }, people, code.activeVersionId) : null);
  let run: CodePageRunDetail | null = null;
  if (runCalls)
    run = {
      run: { ...runCalls.run, versionNumber: numbers.get(runCalls.run.versionId) ?? null },
      calls: runCalls.readable ? runCalls.calls : null,
      nextCallCursor: runCalls.readable ? runCalls.next : null,
      input: runCalls.input,
      inputTooLarge: runCalls.inputTooLarge,
      refusal: runRefusal,
    };
  let diff: CodePageDiff | null = null;
  if (diffResult?.ok && selectedVersionId) {
    const value = diffResult.data.data;
    // The comparison can also be older than the loaded history; its number comes from its own metadata then.
    const comparisonId = value.binding.comparisonVersionId;
    if (comparisonId && !numbers.has(comparisonId)) {
      const older = await versionMeta(comparisonId);
      if (older) numbers.set(older.id, older.number);
    }
    const selected =
      versions.find((version) => version.id === selectedVersionId) ??
      (selectedVersionId === activeVersion?.id ? activeVersion : null) ??
      (olderSelected ? versionView({ version: olderSelected }, people, code.activeVersionId) : null);
    const selectedManifest =
      selectedVersionId === code.activeVersionId
        ? activeManifest
        : selectedVersionId === waitingReceipt?.version.id
          ? waitingManifest
          : await loadManifest(invoke, code.id, selectedVersionId);
    if (selected)
      diff = {
        version: selected,
        comparison: comparisonId ? (numbers.get(comparisonId) ?? "unknown") : null,
        staleComparison: value.staleComparison,
        internet: selectedManifest ? (selectedManifest.internet ?? []) : null,
        files: value.files,
        permissions: value.permissions.map((permission) => ({
          operation: permission.operation,
          target: permissionRef(permission) ? targetOf(permissionRef(permission)!) : null,
          file: permission.file,
          line: permission.line,
        })),
      };
  }
  const secrets = tab === "secrets" && code.permission === "editor" ? await loadSecrets() : null;
  return {
    kind: "ready",
    code: {
      id: code.id,
      title: code.title,
      serviceAccountHandle: code.serviceAccountHandle ?? null,
      state: code.state,
      activeVersionId: code.activeVersionId,
      pauseReason: code.pauseReason,
    },
    permission: code.permission,
    versions,
    versionsFailed: !versionsResult.ok,
    moreVersions: versionsResult.ok && versionsResult.data.data.nextBefore !== null,
    active: activeVersion,
    waiting: waitingReceipt ? (versions.find((version) => version.id === waitingReceipt.version.id) ?? null) : null,
    automations,
    internet: {
      active: activeManifest ? (activeManifest.internet ?? []) : code.activeVersionId ? null : [],
      waiting: waitingManifest ? (waitingManifest.internet ?? []) : waitingReceipt ? null : [],
    },
    targets: targetRows,
    refusal,
    attentionReasons: attentionResult?.ok ? (attentionResult.data.data.items.find((item) => item.codeId === code.id)?.reasons ?? []) : null,
    waitingTargets,
    runs:
      runs && runsResult.ok
        ? { items: runs, nextCursor: runsResult.data.data.nextCursor, eventDeliveries: runsResult.data.data.eventDeliveries ?? [] }
        : null,
    run,
    diff,
    selectionFailed: Boolean((selectedRunId && !run) || (selectedVersionId && !diff)),
    secrets,
  };
};

/**
 * Initial data for the shared Code page of one resource. The owner app checks that the person may read the resource
 * and says whether they administer it; Core decides which Code they see and what they may do with it. Every part
 * that cannot load becomes a visible state on the page, never an empty one.
 */
export const loadCodePage = async (c: Context, options: LoadCodePageOptions): Promise<CodePageData> => {
  const url = new URL(c.req.url);
  const locale = getLocale(c);
  const caller = callerOf(c);
  const invoke: CodePageInvoke = (invocation, schema) => invokeCapabilityWithDataSchema(invocation, schema, caller);
  const actor = c.get("actor");
  const credentialKind = c.get("credentialKind");
  const activation: CodePageData["activation"] = isAppSessionActor(actor)
    ? { allowed: false, reason: "phone" }
    : actor?.kind === "user" && (credentialKind === "session" || credentialKind === "oauth")
      ? { allowed: true }
      : { allowed: false, reason: "credential" };
  const user = c.get("user");
  const editorPanel = user
    ? visiblePanelProviders(getDisplayRuntimeContext(c).apps, user, locale).find((provider) => provider.code)
    : undefined;
  const tab = readTab(url.searchParams.get("tab"));
  const ownerRef = ownerRefOf(options.owner);
  const appTypeTitle = ownerRef
    ? await getCapabilityCatalogApp(cloudResourceRefAppId(ownerRef), locale)
        .then((app) => {
          if (!app.ok || !app.data) return null;
          const localType = ownerRef.type.slice(app.data.appId.length + 1);
          return app.data.manifest.types.find((type) => type.localId === localType)?.title ?? null;
        })
        .catch(() => null)
    : null;
  const owner: CodePageData["owner"] = {
    kind: ownerRef ? "resource" : "person",
    ref: ownerRef,
    title: ownerTitleOf(options.owner),
    typeTitle: appTypeTitle,
  };
  const base = {
    owner,
    href: options.href,
    tab,
    canManageOwner: options.canManageOwner,
    activation,
    editor: editorPanel ? { provider: editorPanel.id, label: editorPanel.label, icon: editorPanel.icon } : null,
    dates: { ...getDateConfig(c), now: new Date().toISOString() },
    activatedNotice: /^\d{1,6}$/.test(url.searchParams.get("activated") ?? "") ? Number(url.searchParams.get("activated")) : null,
    cloudAdmin: Boolean(user?.roles.includes("admin")),
  } satisfies Omit<CodePageData, "state">;
  let code: z.infer<typeof CodeListSchema>["items"][number] | undefined;
  let attentionOwner: Parameters<typeof loadReady>[7];
  if ("ref" in options.owner) {
    attentionOwner = { kind: "resource", ref: options.owner.ref };
    const ownerRefForList = options.owner.ref;
    const listed = await invoke(
      coreQuery("code.list", { owner: { kind: "resource", ref: ownerRefForList }, limit: 1 }),
      CodeListSchema,
    ).catch(() => null);
    if (!listed?.ok) return { ...base, state: { kind: "error" } };
    code = listed.data.data.items[0];
    if (!code) return { ...base, state: { kind: options.canManageOwner ? "none" : "no-access" } };
  } else {
    // Personal Code is read by its ID; Core answers "not found" for Code the person may not see.
    const read = await invoke(coreQuery("code.read", { codeId: options.owner.codeId }), CodeReadSchema).catch(() => null);
    if (!read?.ok) return { ...base, state: { kind: read?.error.status === 404 || read?.error.status === 403 ? "no-access" : "error" } };
    const codeOwner = read.data.data.code.owner;
    // Only personal Code belongs here; Code of a place is shown at that place.
    if (codeOwner.kind !== "person") return { ...base, state: { kind: "no-access" } };
    attentionOwner = { kind: "person", userId: codeOwner.userId };
    code = { ...read.data.data.code, permission: read.data.data.permission };
    base.owner.title = code.title;
    if (codeOwner.userId !== user?.id) {
      const viewer = { id: user?.id ?? null, directory: Boolean(user?.roles.includes("user")) };
      const people = await loadPeople([codeOwner.userId], viewer).catch(() => new Map<string, CodePagePerson>());
      base.owner.runsAs = { name: people.get(codeOwner.userId)?.name ?? null };
    } else base.owner.runsAs = null;
  }
  try {
    // Like directory search: members see other people's names, guests only their own.
    const viewer = { id: user?.id ?? null, directory: Boolean(user?.roles.includes("user")) };
    // Secrets are for editors; anyone else following such a link lands on the overview.
    const shown = tab === "secrets" && code.permission !== "editor" ? "overview" : tab;
    return { ...base, tab: shown, state: await loadReady(c, options, invoke, code, shown, url, viewer, attentionOwner) };
  } catch {
    return { ...base, state: { kind: "error" } };
  }
};
