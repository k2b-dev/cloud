import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { AccessEntry, Principal, ServiceAccountKind } from "../contracts/shared";
import { readShellData } from "../ssr/shell-data";
import type { AccessDialogProps, FoundServiceAccount } from "./AccessDialog";
import { accessDialogMessages } from "./access-dialog-messages";
import {
  type AccessDraft,
  addPrincipal,
  applied,
  type DraftChange,
  type DraftDisplay,
  type DraftLevel,
  type DraftRow,
  draftChanges,
  draftRows,
  emptyDraft,
  lastManagerKeys,
  managerCount,
  managerKeys,
  removeRow,
  restoreRow,
  saveOrder,
  setLevel,
} from "./access-draft";
import { accessMessages } from "./messages";
import { levelKey, type ResolvedLevel, resolveAllowedLevels } from "./PermissionEditor";
import { principalLabel } from "./principal-label";
import { serviceAccountLine } from "./ServiceAccountSection";
import { serviceAccountKindDisplay } from "./service-account-kind";
import { findTargetServiceAccount } from "./service-account-lookup";

/**
 * The service accounts that Code of an object or an app runs as. They never reach the search by name, only by their
 * handle. Their kind stays `code` when displayed.
 */
export const isCodeAccount = (kind: ServiceAccountKind | undefined) => kind === "code";
/** The account behind an object's API keys: shown as an API key, never as a service account. */
export const isApiKeyAccount = (kind: ServiceAccountKind | undefined) => kind === "resource_bound";
export const generalPrincipal = (principal: Principal) => principal.type === "authenticated" || principal.type === "public";
/** The directory the search reads; it answers only with what the viewer may see. */
const DIRECTORY = "/api/accounts/entities";
/** The most entries one directory page returns. */
const DIRECTORY_PAGE = 100;
type DirectoryPage = {
  items: { kind: string; user?: { id: string; mail: string | null } }[];
  pagination?: { total: number };
};
/** One directory page, or `null` when the directory refuses or answers in another shape. */
const readDirectory = async (params: Record<string, string>, signal: AbortSignal): Promise<DirectoryPage | null> => {
  try {
    const response = await fetch(`${DIRECTORY}?${new URLSearchParams(params)}`, { signal, credentials: "same-origin" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && Array.isArray((body as DirectoryPage).items) ? (body as DirectoryPage) : null;
  } catch {
    return null;
  }
};

/** A question the dialog asks before something that takes access away or drops changes; resolves `true` to go on. */
export type AccessQuestion = { title: string; body: string; confirm: string; cancel: string };

/** One line of "What changes": the name, what happens to it, and a further sentence where one matters. */
export type AccessChange = {
  tone: "add" | "remove" | "change" | "neutral" | "warning";
  icon?: "world" | "building";
  name: string;
  /** Follows the name directly, such as " gains Edit" or ": View → Edit". */
  text: string;
  detail?: string;
};

/** The mark of a row that changed: new, removed, or its level before. */
export type AccessMark = { tone: "ok" | "bad" | "warn"; label: string };

/**
 * The state and rules of the access dialog, shared by its v1 and v2 looks: the draft over the stored entries, loading,
 * the directory's e-mails and count, levels, the last-manager rule, "What changes", and saving in order after asking.
 * A look draws it; it never decides access itself.
 */
export function createAccessDialogState(
  props: AccessDialogProps,
  locale: () => string,
  ask: (question: AccessQuestion) => Promise<boolean | undefined>,
  close: (saved: boolean) => void,
) {
  const t = () => accessDialogMessages.resolve([locale()]).t;
  const access = () => accessMessages.resolve([locale()]).t;
  const canEdit = () => props.canEdit !== false;
  const findServiceAccount = createMemo(() => {
    const target = props.target;
    return (
      props.findServiceAccount ??
      (target ? (handle: string, signal: AbortSignal) => findTargetServiceAccount(target, handle, signal) : undefined)
    );
  });
  // What was stored when the dialog started; a save makes the draft's base a new list.
  let baseline: readonly AccessEntry[] = props.initialEntries ?? [];
  const [draft, setDraft] = createSignal<AccessDraft>(emptyDraft(baseline));
  const [loadState, setLoadState] = createSignal<"ready" | "loading" | "failed">(
    props.initialEntries === undefined && props.loadEntries ? "loading" : "ready",
  );
  const loading = () => loadState() !== "ready";
  let loadAbort: AbortController | undefined;
  const load = async () => {
    const read = props.loadEntries;
    if (!read) return;
    loadAbort?.abort();
    const controller = new AbortController();
    loadAbort = controller;
    setLoadState("loading");
    try {
      const entries = await read(controller.signal);
      if (controller.signal.aborted) return;
      baseline = entries;
      setDraft(emptyDraft(entries));
      setLoadState("ready");
    } catch {
      if (!controller.signal.aborted) setLoadState("failed");
    }
  };
  if (loadState() === "loading") void load();
  onCleanup(() => loadAbort?.abort());
  const [saving, setSaving] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const rows = createMemo(() => draftRows(draft()));

  // ── Directory ─────────────────────────────────────────────────────────
  // Each person's e-mail and the number of signed-in people come from the directory the search uses, so the dialog
  // shows only what the viewer may see there. Until they arrive, or when the directory refuses, a row names its kind
  // and General speaks of everyone with an account; neither changes a row's size.
  const [mails, setMails] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [signedInCount, setSignedInCount] = createSignal<number>();
  const directory = new AbortController();
  onCleanup(() => directory.abort());
  const asked = new Set<string>();
  createEffect(() => {
    if (loading()) return;
    const ids = rows().flatMap((row) => (row.principal.type === "user" && !asked.has(row.principal.userId) ? [row.principal.userId] : []));
    if (ids.length === 0) return;
    for (const id of ids) asked.add(id);
    // One page after the other, so a long list never sends a burst of requests.
    void (async () => {
      for (let start = 0; start < ids.length; start += DIRECTORY_PAGE) {
        const page = ids.slice(start, start + DIRECTORY_PAGE);
        const result = await readDirectory({ kinds: "user", user_ids: page.join(","), per_page: String(page.length) }, directory.signal);
        if (!result) return;
        const found = result.items.flatMap((item) =>
          typeof item?.user?.id === "string" && typeof item.user.mail === "string" ? [[item.user.id, item.user.mail] as const] : [],
        );
        if (found.length > 0) setMails((current) => new Map([...current, ...found]));
      }
    })();
  });
  // The directory counts the people the viewer may see; a guest sees only themselves, so read-only viewers get no number.
  if (props.allowAuthenticated !== false && canEdit())
    void readDirectory({ kinds: "user", per_page: "1" }, directory.signal).then((result) => {
      const total = result?.pagination?.total;
      if (typeof total === "number") setSignedInCount(total);
    });
  const changes = createMemo(() => draftChanges(draft()));
  const lastManagers = createMemo(() => lastManagerKeys(draft(), props.effectiveEntries));
  const levels = (principal: Principal): ResolvedLevel[] =>
    resolveAllowedLevels(typeof props.allowedLevels === "function" ? props.allowedLevels(principal) : props.allowedLevels, access());
  // Code's own service account never manages: whoever edits the code would act with that right.
  const levelsFor = (principal: Principal, kind: ServiceAccountKind | undefined): ResolvedLevel[] =>
    isCodeAccount(kind) ? levels(principal).filter((level) => level.level !== "admin") : levels(principal);
  const rowLevels = (row: DraftRow) => levelsFor(row.principal, row.display.serviceAccountKind);
  const manageLabel = (principal: Principal) => levels(principal).find((level) => level.level === "admin")?.label ?? access().manage;
  const levelLabel = (principal: Principal, level: DraftLevel | null) =>
    !level
      ? ""
      : level.permission === "none"
        ? access().noAccess
        : (levels(principal).find((option) => option.key === levelKey(level.permission, level.scope))?.label ?? level.permission);
  /**
   * The level a new row starts with: the first the resource offers, with its scope. A service account of an object
   * starts with Edit where the resource offers it, as in the approved mockup: its code usually writes.
   */
  const firstLevel = (principal: Principal, kind?: ServiceAccountKind): DraftLevel => {
    const options = levelsFor(principal, kind);
    const option = (isCodeAccount(kind) && options.find((candidate) => candidate.level === "write" && !candidate.scope)) || options[0];
    return option ? { permission: option.level, ...(option.scope ? { scope: option.scope } : {}) } : { permission: "read" };
  };
  const nameOf = (row: DraftRow) =>
    row.principal.type === "authenticated"
      ? t().signedInLabel
      : row.principal.type === "public"
        ? t().publicLabel
        : principalLabel(
            {
              principal: row.principal,
              displayName: row.display.displayName || undefined,
              serviceAccountKind: row.display.serviceAccountKind,
            },
            locale(),
          );

  /**
   * The row a General switch controls. A stored denial wins, because it shuts the audience out whatever else is
   * stored; any further entry of that audience shows in the list, where it can be seen and removed.
   */
  const generalRow = (type: "authenticated" | "public") => {
    const matching = rows().filter((row) => row.principal.type === type);
    return matching.find((row) => row.previous?.permission === "none") ?? matching[0];
  };
  const isGeneralSwitch = (row: DraftRow) =>
    (row.principal.type === "authenticated" || row.principal.type === "public") && generalRow(row.principal.type)?.key === row.key;
  const peopleRows = () =>
    rows().filter(
      (row) => !isCodeAccount(row.display.serviceAccountKind) && !isApiKeyAccount(row.display.serviceAccountKind) && !isGeneralSwitch(row),
    );
  const objectAccountRows = () => rows().filter((row) => isCodeAccount(row.display.serviceAccountKind));
  const apiKeyRows = () => rows().filter((row) => isApiKeyAccount(row.display.serviceAccountKind));
  /** In read-only mode, who can change access: the people and groups that manage it, by name. */
  const readOnlyLine = () => {
    // The same managers the last-manager rule counts: unscoped, and not shadowed by a denial.
    const managing = managerKeys(draft(), props.effectiveEntries);
    const names = rows()
      .filter((row) => managing.has(row.key) && (row.principal.type === "user" || row.principal.type === "group"))
      .map((row) => nameOf(row));
    return names.length > 0
      ? t().readOnlyManagers({ names: new Intl.ListFormat(locale(), { type: "conjunction" }).format(names) })
      : t().readOnly;
  };
  const showGeneral = () =>
    props.allowAuthenticated !== false || props.allowPublic === true || rows().some((row) => generalPrincipal(row.principal));
  /** Read-only, the section shows only who is listed: no controls and no empty section. */
  const canAddObjectAccounts = () => findServiceAccount() !== undefined && canEdit();
  const showObjectAccounts = () => canAddObjectAccounts() || objectAccountRows().length > 0;

  const edit = (next: (current: AccessDraft) => AccessDraft) => {
    if (!canEdit() || saving()) return;
    setFailed(false);
    setDraft(next);
  };

  // ── What changes ──────────────────────────────────────────────────────
  const changeItems = (): AccessChange[] =>
    changes().map((change) => {
      const name = nameOf(change.row);
      const type = change.row.principal.type;
      if (type === "public")
        return {
          tone: change.kind === "remove" ? "neutral" : "warning",
          icon: "world",
          name,
          text: change.kind === "remove" ? t().publicChangeOff : t().publicChangeOn,
          detail: change.kind === "remove" ? undefined : (props.publicWarning ?? t().publicWarning),
        };
      if (type === "authenticated")
        return {
          tone: "neutral",
          icon: "building",
          name,
          text:
            change.kind === "remove" ? t().signedInChangeOff : t().peopleMay({ level: levelLabel(change.row.principal, change.row.next) }),
        };
      // Code acts with everything its level allows, not only with what it calls today.
      const codeDetail = (level: DraftLevel) =>
        isCodeAccount(change.row.display.serviceAccountKind)
          ? t().codeMayAll({ level: levelLabel(change.row.principal, level) })
          : undefined;
      if (change.kind === "add")
        return {
          tone: "add",
          name,
          text: t().gains({ level: levelLabel(change.row.principal, change.level) }),
          detail: codeDetail(change.level),
        };
      if (change.kind === "remove")
        return { tone: "remove", name, text: change.from.permission === "none" ? t().denialRemoved : t().loses };
      return {
        tone: "change",
        name,
        text: `: ${levelLabel(change.row.principal, change.from)} → ${levelLabel(change.row.principal, change.to)}`,
        detail: codeDetail(change.to),
      };
    });

  // ── Save ──────────────────────────────────────────────────────────────
  const confirmRemovals = async (pending: readonly DraftChange[]): Promise<boolean> => {
    // Turning off signed-in or public access takes access away as well.
    // Removing a denial lets other entries apply again; nobody loses access by it.
    const losing = pending.filter((change) => change.kind === "remove" && change.from.permission !== "none");
    if (losing.length === 0) return true;
    const names = new Intl.ListFormat(locale(), { type: "conjunction" }).format(losing.map((change) => nameOf(change.row)));
    const others = pending.length - losing.length;
    return (
      (await ask({
        title: t().confirmTitle,
        body: `${t().confirmLoses({ names, name: props.resourceName, count: losing.length })} ${others > 0 ? t().confirmOthers({ count: others }) : t().confirmAlone}`,
        confirm: t().confirmRemove,
        cancel: t().confirmBack,
      })) === true
    );
  };
  const save = async () => {
    if (changes().length === 0 || saving() || !canEdit()) return;
    // The save owns the draft from the first click: a second click or an edit while confirming changes nothing.
    setSaving(true);
    setFailed(false);
    try {
      const pending = saveOrder(changes());
      if (!(await confirmRemovals(pending)) || disposed) return;
      for (const change of pending) {
        const level = change.kind === "add" ? change.level : change.kind === "change" ? change.to : undefined;
        const permission = level?.permission;
        // The dialog never offers a denial, so a pending grant or change always names a grantable level.
        if (permission === "none") throw new Error("A denial is never granted from the dialog");
        if (change.kind === "add") {
          if (!permission) continue;
          const saved = await props.grantAccess(change.row.principal, permission, change.row.display, level?.scope);
          if (disposed) return;
          const display = change.row.display;
          setDraft((current) =>
            applied(current, change, {
              ...saved,
              displayName: saved.displayName ?? display.displayName,
              avatarHash: saved.avatarHash !== undefined ? saved.avatarHash : display.avatarHash,
              serviceAccountKind: saved.serviceAccountKind ?? display.serviceAccountKind,
              serviceAccountDescription: saved.serviceAccountDescription ?? display.serviceAccountDescription,
              serviceAccountHref: saved.serviceAccountHref ?? display.serviceAccountHref,
            }),
          );
        } else if (change.kind === "change") {
          if (!permission) continue;
          await props.updateAccess(change.row.entry!.id, permission, level?.scope);
          if (disposed) return;
          setDraft((current) => applied(current, change));
        } else {
          await props.revokeAccess(change.row.entry!.id);
          if (disposed) return;
          setDraft((current) => applied(current, change));
        }
      }
      close(true);
    } catch {
      if (!disposed) setFailed(true);
    } finally {
      if (!disposed) setSaving(false);
    }
  };
  const dismiss = async () => {
    if (saving()) return;
    if (changes().length > 0) {
      const discard = await ask({
        title: t().discardTitle,
        body: t().discardBody({ count: changes().length }),
        confirm: t().discard,
        cancel: t().keepEditing,
      });
      if (!discard || disposed) return;
    }
    close(changes().length === 0 && draft().base !== baseline);
  };

  // ── Rows ──────────────────────────────────────────────────────────────
  const kindLine = (row: DraftRow) => {
    // A service account of an object always reads as the server describes it, with its level.
    if (row.principal.type === "service_account" && isCodeAccount(row.display.serviceAccountKind)) return accountLine(row);
    if (row.entry && props.entryDetail) {
      const detail = props.entryDetail(row.entry);
      if (detail) return detail;
    }
    if (row.principal.type === "user") return mails().get(row.principal.userId) ?? t().person;
    if (row.principal.type === "group") return t().group;
    if (row.principal.type === "service_account")
      return isCodeAccount(row.display.serviceAccountKind)
        ? t().serviceAccount
        : ((row.display.serviceAccountKind && serviceAccountKindDisplay(row.display.serviceAccountKind, access()).label) ?? t().agent);
    return "";
  };
  /**
   * A service account of an object says what it is, as the server describes it, and what it may: "Service account of a
   * mailbox · may edit". Read-only, the level stands there alone instead of beside the row.
   */
  const accountLine = (row: DraftRow) => {
    const level = row.next ?? row.previous;
    return serviceAccountLine(locale(), {
      description: row.display.serviceAccountDescription,
      level: level && level.permission !== "none" ? levelLabel(row.principal, level) : undefined,
      readOnly: !canEdit(),
    });
  };
  /** The signed-in person, marked "You": every Cloud page names them in its shell data, so no app passes them. */
  const viewerUserId = readShellData()?.profile?.userId;
  const isViewer = (row: DraftRow) => row.principal.type === "user" && row.principal.userId === viewerUserId;
  const mark = (row: DraftRow): AccessMark | null => {
    if (!row.previous) return { tone: "ok", label: t().markNew };
    if (!row.next) return { tone: "bad", label: t().markRemoved };
    if (levelKey(row.previous.permission, row.previous.scope) !== levelKey(row.next.permission, row.next.scope))
      return { tone: "warn", label: t().markBefore({ level: levelLabel(row.principal, row.previous) }) };
    return null;
  };
  const canRestore = (row: DraftRow) =>
    managerCount(restoreRow(draft(), row), props.effectiveEntries) > 0 || managerCount(draft(), props.effectiveEntries) === 0;
  /** A level of the row's menu: the last manager keeps Manage, every other level is locked for it. */
  const levelOptions = (row: DraftRow) => {
    const protectedRow = lastManagers().has(row.key);
    return rowLevels(row).map((option) => {
      const locked = protectedRow && (option.level !== "admin" || option.scope !== undefined);
      return {
        ...option,
        disabled: locked,
        description: locked ? t().lastManagerOption({ level: manageLabel(row.principal) }) : option.description,
      };
    });
  };
  const chooseLevel = (row: DraftRow, key: string) => {
    const option = rowLevels(row).find((candidate) => candidate.key === key);
    if (option) edit((draftNow) => setLevel(draftNow, row, { permission: option.level, ...(option.scope ? { scope: option.scope } : {}) }));
  };

  // ── General ───────────────────────────────────────────────────────────
  // A stored denial is off: nobody of that audience gets in.
  const granted = (level: DraftLevel | null | undefined) => Boolean(level && level.permission !== "none");
  const generalOn = (type: "authenticated" | "public") => granted(generalRow(type)?.next);
  const toggleGeneral = (type: "authenticated" | "public", value: boolean) => {
    const principal: Principal = { type };
    edit((current) => {
      const existing = draftRows(current).find((candidate) => candidate.key === generalRow(type)?.key);
      if (value) {
        if (!existing?.entry) return addPrincipal(current, principal, { displayName: "" }, existing?.previous ?? firstLevel(principal));
        // A stored grant comes back with its level; a stored denial turns into the first level offered.
        return setLevel(current, existing, granted(existing.previous) ? existing.previous! : firstLevel(principal));
      }
      if (!existing) return current;
      // Switching off again restores a stored denial instead of removing it.
      return existing.entry && existing.previous?.permission === "none" ? restoreRow(current, existing) : removeRow(current, existing);
    });
  };
  const generalDescription = (type: "authenticated" | "public") => {
    const principal: Principal = { type };
    const level = generalRow(type)?.next ?? null;
    if (type === "public") return generalOn(type) ? t().publicOn : t().publicOff;
    if (!generalOn(type)) return t().signedInOff;
    const count = signedInCount();
    return count === undefined
      ? t().signedInOn({ level: levelLabel(principal, level) })
      : t().signedInCountOn({ count, level: levelLabel(principal, level) });
  };
  const generalMark = (type: "authenticated" | "public"): AccessMark | null => {
    const current = generalRow(type);
    if (!current) return null;
    if (!current.previous && current.next) return { tone: "warn", label: t().markBeforeOff };
    return mark(current);
  };

  // ── Service accounts by handle ────────────────────────────────────
  const foundDescriptions = new Map<string, string>();
  const withDescription = (principal: Principal, display: DraftDisplay): DraftDisplay => {
    const description = principal.type === "service_account" ? foundDescriptions.get(principal.serviceAccountId) : undefined;
    return description ? { ...display, serviceAccountDescription: description } : display;
  };
  const addFound = (account: FoundServiceAccount) => {
    edit((current) =>
      addPrincipal(
        current,
        account.principal,
        { ...account.display, ...(account.description ? { serviceAccountDescription: account.description } : {}) },
        firstLevel(account.principal, account.display.serviceAccountKind),
      ),
    );
  };

  const addSelected = (principal: Principal, display: DraftDisplay) =>
    edit((current) =>
      addPrincipal(current, principal, withDescription(principal, display), firstLevel(principal, display.serviceAccountKind)),
    );

  return {
    t,
    access,
    canEdit,
    findServiceAccount,
    draft,
    loadState,
    loading,
    load,
    saving,
    failed,
    rows,
    mails,
    signedInCount,
    changes,
    lastManagers,
    levels,
    levelsFor,
    rowLevels,
    manageLabel,
    levelLabel,
    firstLevel,
    nameOf,
    generalRow,
    peopleRows,
    objectAccountRows,
    apiKeyRows,
    readOnlyLine,
    showGeneral,
    canAddObjectAccounts,
    showObjectAccounts,
    edit,
    changeItems,
    save,
    dismiss,
    kindLine,
    accountLine,
    isViewer,
    mark,
    canRestore,
    levelOptions,
    chooseLevel,
    generalOn,
    toggleGeneral,
    generalDescription,
    generalMark,
    foundDescriptions,
    withDescription,
    addFound,
    addSelected,
  };
}

export type AccessDialogState = ReturnType<typeof createAccessDialogState>;
