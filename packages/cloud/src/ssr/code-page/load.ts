import type { Context } from "hono";
import { z } from "zod";
import { aiLive } from "../../ai/live";
import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "../../capabilities/server";
import type { CapabilityCaller } from "../../capabilities/server-invoke";
import { nameCodeGrantTargets } from "../../code/read-model-targets";
import { type CloudResourceRef, cloudResourceRefAppId, resolveCapabilityResourceReader } from "../../contracts/capabilities";
import {
  CodeActivityReadModelSchema,
  type CodeRunReadModel,
  CodeRunReadModelSchema,
  type CodeVersionReadModel,
  CodeVersionReadModelSchema,
} from "../../contracts/code-read-model";
import { cloudResourcePageHref } from "../../contracts/resource-pages";
import { sql } from "../../runtime/clients";
import { auth, getDateConfig, getLocale, isAppSessionActor } from "../../server";
import { CORE_SETTINGS } from "../../services/settings/core-settings";
import { visiblePanelProviders } from "../app-navigation";
import { getDisplayRuntimeContext } from "../runtime";
import { AttentionSchema } from "./attention-schema";
import { loadCodeRunCallsForDetail } from "./calls";
import {
  AutomationListSchema,
  CodeChatBindingSchema,
  CodeListSchema,
  type CodePageAutomation,
  type CodePageData,
  type CodePageDiff,
  type CodePageEvent,
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
  type CodeRunFilter,
  coreQuery,
  ManifestSchema,
  RunListSchema,
  RunReadSchema,
  SecretListSchema,
  VersionListSchema,
  VersionReadSchema,
} from "./data";
import { nameRecentResults } from "./recent-names";
import { loadSourceTabInitial } from "./source-tab-load";
import { type CodeOperationLabel, codeActivationRows, codeTargetsOf, permissionRef, targetKey } from "./targets";

/** Core pages run metadata and versions in pages of 20. */
const PAGE = 20;
/** The run strip shows the last 30 runs; the runs tab lists the same page. */
const RUN_STRIP = 30;
/** Core's default manifest budget is 1 MiB: 64 chunks of 16 Ki code units. A larger manifest shows as unreadable. */
const MANIFEST_CHUNKS = 64;
/** Pages of 20 secrets read for one page view; Core bounds each page by items and bytes. */
const SECRET_PAGES = 10;
const SECRET_NOTICES = ["replaced", "submitted", "saved", "submit-failed", "refused", "unknown"] as const;

/** The owning resource, or null for personal Code. */
const ownerRefOf = (owner: LoadCodePageOptions["owner"]) => ("ref" in owner ? owner.ref : null);
const ownerTitleOf = (owner: LoadCodePageOptions["owner"]) => ("ref" in owner ? owner.title : "");

export { permissionRef, targetKey };

const isOwnRef = (ref: { type: string; id: string }, owner: LoadCodePageOptions["owner"]) => {
  const own = ownerRefOf(owner);
  return own !== null && sameRef(ref, own);
};
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

/** The person's authority for registry reads; null where the route has no authenticated request. */
const requestAuthority = (c: Context) => {
  try {
    return auth.getAuthority(c);
  } catch {
    return null;
  }
};

const readTab = (value: string | null): CodePageTab =>
  value === "runs" || value === "versions" || value === "secrets" || value === "code" ? value : "overview";
const readRunFilter = (value: string | null): CodeRunFilter => (value === "failed" || value === "skipped" ? value : "all");

/** The local calendar day of an instant in a time zone, as `YYYY-MM-DD`. */
export const localDay = (iso: string, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
};

/** A read model answer, or null when Core cannot give one; the page then shows that part as not loaded. */
const words = async <T>(promise: Promise<{ ok: true; data: { data: T } } | { ok: false }>): Promise<T | null> => {
  try {
    const result = await promise;
    return result.ok ? result.data.data : null;
  } catch {
    return null;
  }
};
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
/**
 * One registry catalog read per app and page, shared by every target of that app; never a call to the app. The
 * catalog answers only for apps the person may use, so it reads with the request's authority: without it, every app
 * with an entry rule (such as Spaces) looks unusable and its types have no reader.
 */
export const catalogCache = (locale: string, authority: Parameters<typeof getCapabilityCatalogApp>[2] = null) => {
  const apps = new Map<string, Promise<CatalogApp | null>>();
  return (appId: string) => {
    let app = apps.get(appId);
    if (!app) {
      app = getCapabilityCatalogApp(appId, locale, authority).catch(() => null);
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

/** The event an automation follows: its title from its app's registry entry and its place, named as a target is. */
export const describeEvent = async (
  event: { type: string; version: number; place: { type: string; id: string } },
  owner: LoadCodePageOptions["owner"],
  catalog: ReturnType<typeof catalogCache>,
): Promise<CodePageEvent> => {
  const app = await catalog(event.type.split(".")[0]!);
  const title =
    app?.ok && app.data
      ? (app.data.events?.find((entry) => entry.type === event.type && entry.version === event.version)?.title ?? null)
      : null;
  return { type: event.type, title, place: await describeTarget(event.place, owner, catalog) };
};

/** Titles and app names of called operations in the caller's locale, from registry manifests; unknown ones are left out. */
export const describeOperations = async (
  operations: Iterable<string>,
  catalog: ReturnType<typeof catalogCache>,
): Promise<Record<string, CodeOperationLabel>> => {
  const entries = await Promise.all(
    [...new Set(operations)].map(async (operation) => {
      const appId = operation.split(".")[0]!;
      const app = await catalog(appId).catch(() => null);
      if (!app?.ok || !app.data) return null;
      const localId = operation.slice(appId.length + 1);
      const entry = [...app.data.manifest.actions, ...app.data.manifest.queries].find((candidate) => candidate.localId === localId);
      return entry ? ([operation, { title: entry.title, app: app.data.appName ?? null }] as const) : null;
    }),
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
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
  let pages: z.infer<typeof VersionReadSchema>["pages"] = null;
  let offset: number | null = 0;
  for (let chunk = 0; offset !== null && chunk < MANIFEST_CHUNKS; chunk++) {
    const from: number = offset;
    const read = await invoke(
      coreQuery("code.version.read", { codeId, versionId, content: { kind: "manifest" }, offset: from }),
      VersionReadSchema,
    );
    const content: { text: string; nextOffset: number | null } | null = read.ok ? read.data.data.content : null;
    if (!content) return null;
    if (chunk === 0 && read.ok) pages = read.data.data.pages ?? null;
    text += content.text;
    offset = content.nextOffset;
  }
  if (offset !== null) return null;
  try {
    return { ...ManifestSchema.parse(JSON.parse(text)), pages: pages?.versionId === versionId ? pages : null };
  } catch {
    return null;
  }
};

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
  decisionComment: receipt.decision?.comment ?? null,
  decidedAt: receipt.decision?.decidedAt ?? null,
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
  const catalog = catalogCache(getLocale(c), requestAuthority(c));
  const code = listed;
  const [versionsResult, runsResult, attentionResult, automationResult, chatBinding] = await Promise.all([
    invoke(coreQuery("code.version.list", { codeId: code.id, limit: PAGE }), VersionListSchema),
    invoke(coreQuery("code.run.list", { codeId: code.id, limit: RUN_STRIP }), RunListSchema),
    // The same answer the owner's navigation gets, so its dot and this page agree.
    invoke(coreQuery("code.attention", { owner: codeOwner }), AttentionSchema).catch(() => null),
    // Only the next run comes from here; without it the row simply does not name one.
    invoke(coreQuery("code.automation.list", { codeId: code.id }), AutomationListSchema).catch(() => null),
    // Personal Code writes to one chat; the page names it and lets its owner choose another one.
    codeOwner.kind === "person"
      ? invoke(coreQuery("code.chat_binding.read", { codeId: code.id }), CodeChatBindingSchema)
          .then((result) => (result.ok ? result.data.data : null))
          .catch(() => null)
      : Promise.resolve(undefined),
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
  // The page shows versions in words; the source difference stays in the code tab and in `cld code diff`.
  const [runCalls, olderActive, olderSelected, lastRead] = await Promise.all([
    selectedRunId ? loadCodeRunCallsForDetail(invoke, code.id, selectedRunId, getLocale(c)) : Promise.resolve(null),
    versionMeta(code.activeVersionId),
    selectedVersionId !== code.activeVersionId ? versionMeta(selectedVersionId) : Promise.resolve(null),
    lastRefused && code.permission === "editor"
      ? invoke(coreQuery("code.run.read", { codeId: code.id, runId: lastRefused.id }), RunReadSchema).catch(() => null)
      : Promise.resolve(null),
  ]);
  for (const version of [olderActive, olderSelected]) if (version) numbers.set(version.id, version.number);

  // Targets: what the running version calls, plus what the waiting version would add, as the checker read them.
  const activeByTarget = codeTargetsOf(activeManifest);
  const waitingByTarget = codeTargetsOf(waitingManifest);
  const diffPermissions: { operation: string; target: { type: string; id: string | null } | null }[] = [];
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
          refusalCode?: "code_ai_budget_limit" | "code_ai_daily_budget_limit" | "code_ai_owner_daily_budget_limit";
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
      ? codeActivationRows(activeManifest, waitingManifest, ownerRef).map((row) => ({
          target: targetOf(row.ref),
          operations: row.operations,
          isNew: row.isNew,
        }))
      : null;
  // Names only the operations this page shows anyway: its target rows, the switch-on rows and the version difference.
  const operationLabels = await describeOperations(
    [
      ...(targetRows ?? []).flatMap((row) => [...row.operations, ...row.newOperations]),
      ...(waitingTargets ?? []).flatMap((row) => row.operations),
      ...diffPermissions.map((permission) => permission.operation),
    ],
    catalog,
  );
  // A skipped tick or a cancelled start is not a run's result.
  const nextRuns = new Map(automationResult?.ok ? automationResult.data.data.items.map((item) => [item.entrypoint, item.nextRunAt]) : []);
  const nextRunStates = new Map(
    automationResult?.ok ? automationResult.data.data.items.map((item) => [item.entrypoint, item.nextRunState]) : [],
  );
  const lastRunOf = (entrypoint: string) =>
    runs?.find((run) => run.entrypoint === entrypoint && run.state !== "skipped" && run.state !== "cancelled") ?? null;
  const defaultTimeZone = c.get("settings")?.app?.timezone ?? CORE_SETTINGS["app.timezone"].default;
  const events = new Map(
    await Promise.all(
      [activeManifest, waitingManifest]
        .flatMap((manifest) => manifest?.entrypoints ?? [])
        .flatMap((entry) => (entry.event ? [entry.event] : []))
        .map(async (event) => [JSON.stringify(event), await describeEvent(event, options.owner, catalog)] as const),
    ),
  );
  const eventOf = (event: { type: string; version: number; place: { type: string; id: string } } | undefined) => {
    const described = event && events.get(JSON.stringify(event));
    return described ? { event: described } : {};
  };
  const automationsFrom = (
    manifest: z.infer<typeof ManifestSchema> & { pages?: z.infer<typeof VersionReadSchema>["pages"] },
    isNew: (entrypoint: string) => boolean,
  ): CodePageAutomation[] => {
    const pages = new Map(manifest.pages?.pages.map((page) => [page.entrypoint, page]));
    return manifest.entrypoints.map((entry) => ({
      entrypoint: entry.entrypoint,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      kind: entry.kind,
      ...(entry.route ? { route: entry.route } : {}),
      ...(pages.has(entry.entrypoint) ? { pageLink: pages.get(entry.entrypoint) } : {}),
      ...eventOf(entry.event),
      cron: entry.cron,
      ...(entry.at === undefined ? {} : { at: entry.at, timeZone: entry.timeZone ?? defaultTimeZone }),
      isNew: isNew(entry.entrypoint),
      lastRun: lastRunOf(entry.entrypoint),
      nextRunAt: isNew(entry.entrypoint) ? null : (nextRuns.get(entry.entrypoint) ?? null),
      nextRunState: isNew(entry.entrypoint)
        ? "none"
        : (nextRunStates.get(entry.entrypoint) ??
          (nextRuns.get(entry.entrypoint) ? "planned" : code.state === "active" && entry.kind === "schedule" ? "unavailable" : "none")),
    }));
  };
  const activeEntrypoints = new Map(activeManifest?.entrypoints.map((entry) => [entry.entrypoint, JSON.stringify(entry.route)]) ?? []);
  const automations =
    (code.activeVersionId && !activeManifest) || (waitingReceipt && !waitingManifest)
      ? null
      : [
          ...(activeManifest ? automationsFrom(activeManifest, () => false) : []),
          ...(waitingManifest
            ? automationsFrom(
                waitingManifest,
                (entrypoint) =>
                  !activeEntrypoints.has(entrypoint) ||
                  activeEntrypoints.get(entrypoint) !==
                    JSON.stringify(waitingManifest.entrypoints.find((entry) => entry.entrypoint === entrypoint)?.route),
              ).filter((item) => item.isNew)
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
    const latestUsable =
      latest && !["changes_requested", "rejected", "withdrawn", "superseded", "expired", "cancelled"].includes(latest.status);
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
  const selectedVersion = selectedVersionId
    ? (versions.find((version) => version.id === selectedVersionId) ??
      (selectedVersionId === activeVersion?.id ? activeVersion : null) ??
      (olderSelected ? versionView({ version: olderSelected }, people, code.activeVersionId) : null))
    : null;
  const diff: CodePageDiff | null = selectedVersion
    ? { version: selectedVersion, comparison: null, staleComparison: false, internet: null, files: [], permissions: [] }
    : null;
  const secrets = tab === "secrets" && code.permission === "editor" ? await loadSecrets() : null;

  // The Code in words: Core's read models carry every sentence the page shows about versions, runs and effects.
  const proposalReceipt =
    waitingReceipt ??
    (latest &&
    latest.version.id !== code.activeVersionId &&
    latest.status === "changes_requested" &&
    (!activeReceipt || latest.version.number > activeReceipt.version.number)
      ? latest
      : undefined);
  const currentId = code.activeVersionId ?? proposalReceipt?.version.id ?? latest?.version.id ?? null;
  /**
   * One source for every target name on the page: a type's canonical reader from the per-page catalog, read with the
   * person's authority. "What it may do" and the latest results both read their targets through it, each target in
   * its own call with the person's rights; Core's one child Query is never involved.
   */
  const readerOf = async (type: string): Promise<string | null> => {
    if (!type.includes(".")) return null;
    const app = await catalog(cloudResourceRefAppId({ type, id: "" }));
    return app?.ok && app.data ? (resolveCapabilityResourceReader(app.data.manifest, { type, id: "" })?.localId ?? null) : null;
  };
  const versionWords = async (versionId: string | null | undefined) => {
    if (!versionId) return null;
    const model = await words<CodeVersionReadModel>(
      invoke(coreQuery("code.version.words", { codeId: code.id, versionId }), CodeVersionReadModelSchema),
    );
    // A name that cannot be read leaves Core's sentence with the target's type, never an empty row.
    return model ? nameCodeGrantTargets(model, invoke, readerOf, c.req.raw.signal).catch(() => model) : null;
  };
  const runFilter = readRunFilter(url.searchParams.get("filter"));
  const runsListed =
    tab === "runs"
      ? (runs ?? []).filter((run) =>
          runFilter === "failed"
            ? run.state === "failed" || run.state === "cancelled"
            : runFilter === "skipped"
              ? run.state === "skipped"
              : true,
        )
      : [];
  const wordRunIds = new Set([
    ...runsListed.slice(0, PAGE).map((run) => run.id),
    ...(selectedRunId ? [selectedRunId] : []),
    ...(tab === "overview" && lastRun ? [lastRun.id] : []),
  ]);
  const dates = getDateConfig(c);
  const [currentWords, proposalWords, selectedWords, activity, runWords, sourceTab] = await Promise.all([
    versionWords(currentId),
    proposalReceipt && proposalReceipt.version.id !== currentId ? versionWords(proposalReceipt.version.id) : Promise.resolve(null),
    tab === "versions" && selectedVersionId && selectedVersionId !== currentId && selectedVersionId !== proposalReceipt?.version.id
      ? versionWords(selectedVersionId)
      : Promise.resolve(null),
    tab === "overview" && ownerRef
      ? words(
          invoke(
            coreQuery("code.activity.words", {
              codeId: code.id,
              day: localDay(new Date().toISOString(), dates.timeZone ?? "UTC"),
              timeZone: dates.timeZone ?? "UTC",
            }),
            CodeActivityReadModelSchema,
          ),
        )
      : Promise.resolve(null),
    Promise.all(
      [...wordRunIds].map(async (runId) => {
        const read = await words<CodeRunReadModel>(invoke(coreQuery("code.run.words", { codeId: code.id, runId }), CodeRunReadModelSchema));
        return read ? ([runId, read] as const) : null;
      }),
    ),
    tab === "code" && code.permission === "editor" ? loadSourceTabInitial(invoke, code.id, url).catch(() => null) : Promise.resolve(null),
  ]);
  // Readers of every type in the apps this Code acts in, from the registry catalog the page already reads.
  const readerApps = new Set(
    activity
      ? [
          ...(activeManifest?.permissions ?? []).map((permission) => permission.operation.split(".")[0]!),
          ...activity.recent.flatMap((item) => (item.target ? [cloudResourceRefAppId(item.target.ref)] : [])),
        ]
      : [],
  );
  // The browser names a live result with the same readers, so they travel with the page.
  const recentReaders: Record<string, string> = {};
  for (const appId of readerApps) {
    const app = await catalog(appId);
    if (!app?.ok || !app.data) continue;
    for (const type of app.data.manifest.types) {
      const reader = resolveCapabilityResourceReader(app.data.manifest, { type: `${appId}.${type.localId}`, id: "" });
      if (reader) recentReaders[`${appId}.${type.localId}`] = reader.localId;
    }
  }
  const namedActivity = activity ? { ...activity, recent: await nameRecentResults(activity.recent, invoke, readerOf) } : null;
  const byId = new Map([currentWords, proposalWords, selectedWords].flatMap((item) => (item ? [[item.versionId, item] as const] : [])));
  const secretNames = [
    ...new Set([...(activeManifest?.secrets ?? []), ...(waitingManifest?.secrets ?? [])].map((binding) => binding.name)),
  ];
  const secretOrigins: Record<string, string[]> = {};
  for (const binding of activeManifest?.secrets ?? [])
    secretOrigins[binding.origin] = [...(secretOrigins[binding.origin] ?? []), binding.name];
  /** Each automation's timing in words, from the read model of the version it belongs to, by manifest position. */
  const timingOf = (automation: CodePageAutomation): string | undefined => {
    const manifest = automation.isNew ? waitingManifest : (activeManifest ?? waitingManifest);
    const model = automation.isNew ? (proposalWords ?? currentWords) : currentWords;
    const index = manifest?.entrypoints.findIndex((entry) => entry.entrypoint === automation.entrypoint) ?? -1;
    if (!model || index < 0 || model.versionId !== (automation.isNew ? waitingReceipt?.version.id : currentId)) return undefined;
    return model.timing.items[index]?.text;
  };
  return {
    kind: "ready",
    code: {
      id: code.id,
      title: code.title,
      ...(code.database ? { database: code.database } : {}),
      serviceAccountHandle: code.serviceAccountHandle ?? null,
      state: code.state,
      activeVersionId: code.activeVersionId,
      pauseReason: code.pauseReason,
      activatedAt: code.activatedAt ?? null,
      activatedBy: code.activatedBy ?? null,
      pausedAt: code.pausedAt ?? null,
      pausedBy: code.pausedBy ?? null,
    },
    permission: code.permission,
    versions,
    versionsFailed: !versionsResult.ok,
    moreVersions: versionsResult.ok && versionsResult.data.data.nextBefore !== null,
    active: activeVersion,
    waiting: waitingReceipt ? (versions.find((version) => version.id === waitingReceipt.version.id) ?? null) : null,
    pages: activeManifest?.pages ?? null,
    automations:
      automations?.map((automation) => {
        const timingText = timingOf(automation);
        return timingText ? { ...automation, timingText } : automation;
      }) ?? null,
    databaseUsed: activeManifest?.database === true || waitingManifest?.database === true,
    internet: {
      active: activeManifest ? (activeManifest.internet ?? []) : code.activeVersionId ? null : [],
      waiting: waitingManifest ? (waitingManifest.internet ?? []) : waitingReceipt ? null : [],
    },
    targets: targetRows,
    refusal,
    attentionReasons: attentionResult?.ok ? (attentionResult.data.data.items.find((item) => item.codeId === code.id)?.reasons ?? []) : null,
    waitingTargets,
    operationLabels,
    runs:
      runs && runsResult.ok
        ? { items: runs, nextCursor: runsResult.data.data.nextCursor, eventDeliveries: runsResult.data.data.eventDeliveries ?? [] }
        : null,
    run,
    diff,
    selectionFailed: Boolean((selectedRunId && !run) || (selectedVersionId && !(diff && byId.get(selectedVersionId)))),
    secrets,
    proposal: proposalReceipt ? (versions.find((version) => version.id === proposalReceipt.version.id) ?? null) : null,
    words: {
      current: currentId ? (byId.get(currentId) ?? null) : null,
      proposal: proposalReceipt ? (byId.get(proposalReceipt.version.id) ?? null) : null,
      selected: selectedVersionId ? (byId.get(selectedVersionId) ?? null) : null,
      activity: namedActivity,
      runs: Object.fromEntries(runWords.filter((entry) => entry !== null)),
    },
    secretNames,
    secretOrigins,
    runFilter,
    runSelected: tab === "runs" && Boolean(runParam && uuid.safeParse(runParam).success),
    versionSelected: tab === "versions" && Boolean(versionParam && uuid.safeParse(versionParam).success),
    sourceTab: tab === "code" ? sourceTab : null,
    recentReaders,
    ...(chatBinding === undefined ? {} : { chatBinding }),
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
  // Before any read: the browser follows runs from here, so one that finishes during this render still arrives.
  const liveCursor = await Promise.resolve()
    .then(() => aiLive.cursor())
    .catch(() => null);
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
    // Secrets and the code are for editors; anyone else following such a link lands on the overview.
    const shown = (tab === "secrets" || tab === "code") && code.permission !== "editor" ? "overview" : tab;
    return {
      ...base,
      tab: shown,
      state: { ...(await loadReady(c, options, invoke, code, shown, url, viewer, attentionOwner)), liveCursor },
    };
  } catch {
    return { ...base, state: { kind: "error" } };
  }
};
