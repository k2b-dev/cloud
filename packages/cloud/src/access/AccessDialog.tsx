import {
  AnchoredPopover,
  Button,
  ChangeList,
  type ChangeListItem,
  ChoiceList,
  CopyButton,
  dialogCore,
  IconButton,
  NoticeCard,
  PanelDialog,
  prompts,
  Skeleton,
  StatusBadge,
  Switch,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { CloudResourceRef } from "../contracts/capabilities";
import { type AccessEntry, CODE_ACCOUNT_HANDLE_PATTERN, type Principal, type ServiceAccountKind } from "../contracts/shared";
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
import { type AllowedLevel, type GrantableLevel, levelKey, type ResolvedLevel, resolveAllowedLevels } from "./PermissionEditor";
import PrincipalAvatar from "./PrincipalAvatar";
import PrincipalPicker, { type FoundServiceAccount } from "./PrincipalPicker";
import { principalKey } from "./principal-key";
import { principalLabel } from "./principal-label";
import { serviceAccountKindDisplay } from "./service-account-kind";
import { findTargetServiceAccount } from "./service-account-lookup";

export type { FoundServiceAccount };

export type AccessDialogProps = {
  /** The resource's name, shown in the title and in the confirmation. */
  resourceName: string;
  /** The resource whose access is being edited. Enables targeted Kennung lookup by default; Core rechecks Manage. */
  target?: CloudResourceRef;
  /** One line under the title, such as "Space · Spaces". */
  subtitle?: string;
  /** The stored entries. Pass `loadEntries` instead to open at once and show the dialog loading. */
  initialEntries?: AccessEntry[];
  /** Reads the stored entries while the dialog shows rows that are still loading; a failure offers Try again. */
  loadEntries?: (signal: AbortSignal) => Promise<AccessEntry[]>;
  /** `false` shows who has access without controls. */
  canEdit?: boolean;
  /** The same seams as `PermissionEditor`; the dialog calls them only when the person saves. */
  grantAccess: (principal: Principal, permission: GrantableLevel, display?: DraftDisplay, scope?: string) => Promise<AccessEntry>;
  updateAccess: (accessId: string, permission: GrantableLevel, scope?: string) => Promise<void>;
  revokeAccess: (accessId: string) => Promise<void>;
  /** Entries that still apply when one can shadow another; managers are counted among them. */
  effectiveEntries?: (entries: readonly AccessEntry[]) => readonly AccessEntry[];
  allowedLevels?: AllowedLevel[] | ((principal: Principal) => AllowedLevel[]);
  /** Offer "All signed-in people" under General. Defaults to true. */
  allowAuthenticated?: boolean;
  /** Offer "Public with link" under General. */
  allowPublic?: boolean;
  /** The link a public resource is reached by, offered to copy while public access is on. */
  publicLink?: string;
  /**
   * What public access lets visitors do, when it is more than viewing. The default says that nobody changes anything
   * without signing in; a resource that accepts anonymous input, such as a published form, must say so here.
   */
  publicWarning?: string;
  /** Offer agents in the search. Defaults to true. */
  allowAgents?: boolean;
  /** The signed-in person, marked "You" in the list. */
  viewerUserId?: string;
  /** A row's second line instead of its kind, such as a group's member count. */
  entryDetail?: (entry: AccessEntry) => string | undefined;
  /** Override the platform's targeted lookup, for example in an embedded test harness. */
  findServiceAccount?: (handle: string, signal: AbortSignal) => Promise<FoundServiceAccount | null>;
  /** A further section, such as the resource's object API keys. */
  extraSections?: JSX.Element;
  /**
   * Closes the dialog without asking, for example when the settings that opened it close. Nothing pending is sent
   * afterwards; changes already saved stay saved.
   */
  signal?: AbortSignal;
};

/** Opens the access dialog. Resolves `true` when changes were saved. */
export const openAccessDialog = async (props: AccessDialogProps): Promise<boolean> =>
  (await dialogCore.open<boolean>(
    (close, context) => (
      <AccessDialog {...props} close={(saved) => close(saved)} setDismissHandler={(handler) => context.setDismissHandler(handler)} />
    ),
    {
      panelClassName: "k2b-dialog k2b-dialog--large",
      signal: props.signal,
      ariaLabel: accessDialogMessages.resolve([document.documentElement.lang || "en"]).t.title({ name: props.resourceName }),
    },
  )) === true;

/**
 * The service accounts that Code of an object or an app runs as. They never reach the search by name, only by their
 * handle. Their kind stays `code` when displayed.
 */
const isCodeAccount = (kind: ServiceAccountKind | undefined) => kind === "code";
/** The account behind an object's API keys: shown as an API key, never as a service account. */
const isApiKeyAccount = (kind: ServiceAccountKind | undefined) => kind === "resource_bound";
const generalPrincipal = (principal: Principal) => principal.type === "authenticated" || principal.type === "public";

/**
 * Who may use one resource, as one list with "What changes" below it. Nothing applies before Save; a removal asks
 * again; the last entry that manages the resource keeps Manage.
 */
export function AccessDialog(
  props: AccessDialogProps & { close: (saved: boolean) => void; setDismissHandler?: (handler: () => void) => void },
) {
  const locale = useLocale();
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
  const [summaryOpen, setSummaryOpen] = createSignal(true);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const rows = createMemo(() => draftRows(draft()));
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
  const summary = (): ChangeListItem[] =>
    changes().map((change) => {
      const name = <b>{nameOf(change.row)}</b>;
      const type = change.row.principal.type;
      if (type === "public")
        return {
          tone: change.kind === "remove" ? "neutral" : "warning",
          icon: "ti ti-world",
          content: (
            <>
              {name}
              {change.kind === "remove" ? t().publicChangeOff : t().publicChangeOn}
            </>
          ),
          detail: change.kind === "remove" ? undefined : (props.publicWarning ?? t().publicWarning),
        };
      if (type === "authenticated")
        return {
          tone: "neutral",
          icon: "ti ti-building",
          content: (
            <>
              {name}
              {change.kind === "remove"
                ? t().signedInChangeOff
                : t().peopleMay({ level: levelLabel(change.row.principal, change.row.next) })}
            </>
          ),
        };
      // Code acts with everything its level allows, not only with what it calls today.
      const codeDetail = (level: DraftLevel) =>
        isCodeAccount(change.row.display.serviceAccountKind)
          ? t().codeMayAll({ level: levelLabel(change.row.principal, level) })
          : undefined;
      if (change.kind === "add")
        return {
          tone: "add",
          content: (
            <>
              {name}
              {t().gains({ level: levelLabel(change.row.principal, change.level) })}
            </>
          ),
          detail: codeDetail(change.level),
        };
      if (change.kind === "remove")
        return {
          tone: "remove",
          content: (
            <>
              {name}
              {change.from.permission === "none" ? t().denialRemoved : t().loses}
            </>
          ),
        };
      return {
        tone: "change",
        content: (
          <>
            {name}: {levelLabel(change.row.principal, change.from)} → {levelLabel(change.row.principal, change.to)}
          </>
        ),
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
      (await prompts.confirm(
        `${t().confirmLoses({ names, name: props.resourceName, count: losing.length })} ${others > 0 ? t().confirmOthers({ count: others }) : t().confirmAlone}`,
        { title: t().confirmTitle, variant: "danger", confirmText: t().confirmRemove, cancelText: t().confirmBack },
      )) === true
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
      props.close(true);
    } catch {
      if (!disposed) setFailed(true);
    } finally {
      if (!disposed) setSaving(false);
    }
  };
  const dismiss = async () => {
    if (saving()) return;
    if (changes().length > 0) {
      const discard = await prompts.confirm(t().discardBody({ count: changes().length }), {
        title: t().discardTitle,
        confirmText: t().discard,
        cancelText: t().keepEditing,
        variant: "danger",
      });
      if (!discard || disposed) return;
    }
    props.close(changes().length === 0 && draft().base !== baseline);
  };
  props.setDismissHandler?.(() => void dismiss());

  // ── Rows ──────────────────────────────────────────────────────────────
  const kindLine = (row: DraftRow) => {
    // A service account of an object always reads as the server describes it, with its level.
    if (row.principal.type === "service_account" && isCodeAccount(row.display.serviceAccountKind)) return accountLine(row);
    if (row.entry && props.entryDetail) {
      const detail = props.entryDetail(row.entry);
      if (detail) return detail;
    }
    if (row.principal.type === "user") return row.principal.userId === props.viewerUserId ? t().you : t().person;
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
    const description = row.display.serviceAccountDescription || t().serviceAccount;
    const level = row.next ?? row.previous;
    if (!level || level.permission === "none") return description;
    const label = levelLabel(row.principal, level);
    return canEdit() ? `${description} · ${t().accountMay({ level: label })}` : t().accountMayAlone({ level: label });
  };
  const mark = (row: DraftRow) => {
    if (!row.previous) return <StatusBadge class="shrink-0" tone="ok" icon={null} label={t().markNew} />;
    if (!row.next) return <StatusBadge class="shrink-0" tone="error" icon={null} label={t().markRemoved} />;
    if (levelKey(row.previous.permission, row.previous.scope) !== levelKey(row.next.permission, row.next.scope))
      return (
        <StatusBadge
          class="shrink-0"
          tone="warning"
          icon={null}
          label={t().markBefore({ level: levelLabel(row.principal, row.previous) })}
        />
      );
    return null;
  };
  /** What a level means when the resource gives no sentence of its own. */
  const defaultDescription = (level: GrantableLevel) =>
    level === "read" ? t().levelReadDescription : level === "write" ? t().levelWriteDescription : t().levelAdminDescription;
  /**
   * The level of one row as a menu of choices, each with what it means, as in the approved mockup. `onRemove` adds
   * "Remove" at its foot; the last manager keeps Manage and cannot be removed there either.
   */
  const LevelMenu = (menuProps: { row: DraftRow; onRemove?: (trigger: HTMLElement) => void }) => {
    const [open, setOpen] = createSignal(false);
    let trigger: HTMLButtonElement | undefined;
    let menu: HTMLDivElement | undefined;
    const row = () => menuProps.row;
    const protectedRow = () => lastManagers().has(row().key);
    const current = () => (row().next ? levelKey(row().next!.permission, row().next!.scope) : "");
    const options = () =>
      rowLevels(row()).map((option) => {
        const locked = protectedRow() && (option.level !== "admin" || option.scope !== undefined);
        return {
          value: option.key,
          label: option.label,
          icon: option.icon ? `ti ${option.icon.replace(/^ti\s+/, "")}` : undefined,
          disabled: locked,
          description: locked
            ? t().lastManagerOption({ level: manageLabel(row().principal) })
            : (option.description ?? defaultDescription(option.level)),
        };
      });
    return (
      <>
        <button
          ref={trigger}
          type="button"
          class="k2b-choice-trigger w-full"
          aria-label={t().levelFor({ name: nameOf(row()) })}
          aria-haspopup="dialog"
          aria-expanded={open()}
          disabled={!canEdit() || saving()}
          onClick={() => setOpen((value) => !value)}
        >
          <span class="k2b-choice-trigger__value">{levelLabel(row().principal, row().next)}</span>
          {/* On a phone the chevron moves closer, so the whole level fits beside a mark like "vorher Bearbeiten". */}
          <i class="ti ti-chevron-down max-sm:-ml-1.5" aria-hidden="true" />
        </button>
        {/* Mounted only while open, so a long list carries no menu per row. */}
        <Show when={open()}>
          <AnchoredPopover
            anchor={open() ? trigger : null}
            onClose={() => setOpen(false)}
            label={t().levelFor({ name: nameOf(row()) })}
            width="21rem"
            initialFocus={() =>
              menu?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]:not(:disabled)') ??
              menu?.querySelector<HTMLElement>('[role="radio"]:not(:disabled)')
            }
          >
            <div ref={menu} class="flex flex-col gap-2 p-2">
              <ChoiceList
                aria-label={t().levelFor({ name: nameOf(row()) })}
                value={current}
                options={options()}
                onValueChange={(key) => {
                  const option = rowLevels(row()).find((candidate) => candidate.key === key);
                  if (option)
                    edit((draftNow) =>
                      setLevel(draftNow, row(), { permission: option.level, ...(option.scope ? { scope: option.scope } : {}) }),
                    );
                  setOpen(false);
                }}
              />
              <Show when={menuProps.onRemove}>
                {(remove) => (
                  <div class="flex flex-wrap items-center gap-2 px-1 pt-1">
                    <Button
                      variant="text"
                      class="text-[var(--k2b-danger)]"
                      disabled={protectedRow() || saving()}
                      onClick={() => {
                        setOpen(false);
                        if (trigger) remove()(trigger);
                      }}
                    >
                      <i class="ti ti-user-minus" aria-hidden="true" />
                      {t().removeEntry}
                    </Button>
                    <Show when={protectedRow()}>
                      <span class="text-[13px] text-dimmed">{t().lastManagerHint({ level: manageLabel(row().principal) })}</span>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </AnchoredPopover>
        </Show>
      </>
    );
  };
  /** Undo may not leave the resource without a manager, for example by bringing back a denial. */
  const canRestore = (row: DraftRow) =>
    managerCount(restoreRow(draft(), row), props.effectiveEntries) > 0 || managerCount(draft(), props.effectiveEntries) === 0;
  const AccessRow = (rowProps: { row: DraftRow }) => {
    const row = () => rowProps.row;
    const protectedRow = () => lastManagers().has(row().key);
    /** Removes the row from the X or the level menu. A stored row keeps Undo in its place; an added row leaves. */
    const removeFrom = (control: HTMLElement) => {
      const item = control.closest("li");
      const added = !row().entry;
      edit((current) => removeRow(current, row()));
      queueMicrotask(() =>
        (added
          ? document.querySelector<HTMLInputElement>("dialog[open] input[role=combobox]")
          : item?.querySelector<HTMLButtonElement>("button[data-access-undo]")
        )?.focus(),
      );
    };
    return (
      <li class="flex items-center py-2 max-sm:gap-2 sm:gap-3" classList={{ "[&>:first-child]:opacity-50": !row().next }}>
        <PrincipalAvatar
          entry={{ principal: row().principal, avatarHash: row().display.avatarHash, serviceAccountKind: row().display.serviceAccountKind }}
          label={nameOf(row())}
        />
        <span class="min-w-0 flex-[1_1_10rem]">
          <span class="flex min-w-0 items-center gap-2 max-sm:text-sm sm:text-[15px] font-medium text-primary">
            {/* The server offers a link only to whom it may lead: the owner's Code page, or Administration › Code. */}
            <Show
              when={row().display.serviceAccountHref}
              fallback={
                <span data-access-name="" class="min-w-0 break-words">
                  {nameOf(row())}
                </span>
              }
            >
              {(href) => (
                // A new tab keeps the draft: nothing here is saved yet.
                <a data-access-name="" class="min-w-0 break-words hover:underline" href={href()} target="_blank" rel="noopener">
                  {nameOf(row())}
                </a>
              )}
            </Show>
            {/* Only breakpoint-scoped display classes: an app stylesheet that repeats `contents` or `inline-flex` comes later and would show both marks. */}
            <span class="max-sm:hidden sm:contents">{mark(row())}</span>
          </span>
          {/*
            A service account's line carries its level, so it wraps on a phone instead of cutting it off. On a phone the
            mark sits here too: one line height fits it, and it takes a slot of that height at the top of the line, so
            staging a change never makes the row taller and no row below moves.
          */}
          <span
            class="block text-[13px] leading-5 text-dimmed"
            classList={{
              truncate: !isCodeAccount(row().display.serviceAccountKind),
              "break-words": isCodeAccount(row().display.serviceAccountKind),
            }}
          >
            <Show when={mark(row())}>
              {(badge) => <span class="mr-1.5 h-5 items-center align-top max-sm:inline-flex sm:hidden">{badge()}</span>}
            </Show>
            {kindLine(row())}
          </span>
        </span>
        <Show
          when={row().next && canEdit()}
          fallback={
            <Show
              when={!row().next && canEdit()}
              fallback={
                // A service account names its level in the line under its name.
                <Show when={!isCodeAccount(row().display.serviceAccountKind)}>
                  <span class="shrink-0 text-sm text-secondary">{levelLabel(row().principal, row().next)}</span>
                </Show>
              }
            >
              {/* Undo takes the place of level and remove, so the row keeps its size and nothing below moves. */}
              <span class="ml-auto flex shrink-0 items-center justify-end sm:gap-1">
                <span class="flex justify-end max-sm:w-[6.875rem] sm:w-40">
                  <Button
                    variant="text"
                    data-access-undo=""
                    disabled={saving() || !canRestore(row())}
                    onClick={(event) => {
                      const item = event.currentTarget.closest("li");
                      edit((current) => restoreRow(current, row()));
                      // The row stays; focus goes back to its remove button, which takes Undo's place.
                      queueMicrotask(() => item?.querySelector<HTMLButtonElement>("button[data-access-remove]")?.focus());
                    }}
                  >
                    {t().undo}
                  </Button>
                </span>
                <span class="h-9 w-6" aria-hidden="true" />
              </span>
            </Show>
          }
        >
          <span class="ml-auto flex shrink-0 items-center sm:gap-1">
            <span class="max-sm:w-[6.875rem] sm:w-40">
              {/* A stored denial is shown, never offered: it can only be removed. */}
              <Show
                when={row().next?.permission !== "none"}
                fallback={<span class="text-sm text-secondary">{levelLabel(row().principal, row().next)}</span>}
              >
                <LevelMenu row={row()} onRemove={removeFrom} />
              </Show>
            </span>
            <IconButton
              label={protectedRow() ? t().lastManagerRemove({ level: manageLabel(row().principal) }) : t().remove({ name: nameOf(row()) })}
              variant="ghost"
              size="xs"
              disabled={saving() || protectedRow()}
              data-access-remove=""
              onClick={(event) => removeFrom(event.currentTarget)}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </span>
        </Show>
      </li>
    );
  };

  // ── General ───────────────────────────────────────────────────────────
  const GeneralRow = (rowProps: { type: "authenticated" | "public" }) => {
    const principal: Principal = { type: rowProps.type };
    const row = () => generalRow(rowProps.type);
    // A stored denial is off: nobody of that audience gets in.
    const granted = (level: DraftLevel | null | undefined) => Boolean(level && level.permission !== "none");
    const on = () => granted(row()?.next);
    const toggle = (value: boolean) =>
      edit((current) => {
        const existing = draftRows(current).find((candidate) => candidate.key === row()?.key);
        if (value) {
          if (!existing?.entry) return addPrincipal(current, principal, { displayName: "" }, existing?.previous ?? firstLevel(principal));
          // A stored grant comes back with its level; a stored denial turns into the first level offered.
          return setLevel(current, existing, granted(existing.previous) ? existing.previous! : firstLevel(principal));
        }
        if (!existing) return current;
        // Switching off again restores a stored denial instead of removing it.
        return existing.entry && existing.previous?.permission === "none" ? restoreRow(current, existing) : removeRow(current, existing);
      });
    const description = () => {
      const level = row()?.next ?? null;
      if (rowProps.type === "public") return on() ? t().publicOn : t().publicOff;
      return on() ? t().signedInOn({ level: levelLabel(principal, level) }) : t().signedInOff;
    };
    const generalMark = () => {
      const current = row();
      if (!current) return null;
      if (!current.previous && current.next) return <StatusBadge class="shrink-0" tone="warning" icon={null} label={t().markBeforeOff} />;
      return mark(current);
    };
    return (
      <li class="flex flex-wrap items-center gap-y-1 py-2 max-sm:gap-x-2 sm:gap-x-3">
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--k2b-surface-muted)] text-secondary"
          aria-hidden="true"
        >
          <i class={rowProps.type === "public" ? "ti ti-world" : "ti ti-building"} />
        </span>
        <span class="min-w-0 flex-[1_1_10rem]">
          <span class="flex min-w-0 items-center gap-2 max-sm:text-sm sm:text-[15px] font-medium text-primary">
            <span data-access-name="" class="truncate">
              {rowProps.type === "public" ? t().publicLabel : t().signedInLabel}
            </span>
            {/* As in a people row: beside the name on a wide screen, at the start of the line below on a phone. */}
            <span class="max-sm:hidden sm:contents">{generalMark()}</span>
          </span>
          <span class="block truncate text-[13px] leading-5 text-dimmed">
            <Show when={generalMark()}>
              {(badge) => <span class="mr-1.5 h-5 items-center align-top max-sm:inline-flex sm:hidden">{badge()}</span>}
            </Show>
            {description()}
          </span>
        </span>
        {/* On a phone the level moves under the description; the switch stays beside the name. */}
        <Show when={on() && rowProps.type === "authenticated" && canEdit() && row()}>
          {(current) => (
            <span class="max-sm:order-3 max-sm:w-full max-sm:pl-10 sm:w-40 sm:shrink-0">
              <LevelMenu row={current()} />
            </span>
          )}
        </Show>
        {/* Read-only shows the state in words, as the people rows show their level. */}
        <Show
          when={canEdit()}
          fallback={<span class="shrink-0 text-sm text-secondary">{on() ? levelLabel(principal, row()?.next ?? null) : t().off}</span>}
        >
          <Switch
            aria-label={rowProps.type === "public" ? t().publicLabel : t().signedInLabel}
            value={on}
            disabled={saving() || loading() || Boolean(row() && lastManagers().has(row()!.key))}
            onValueChange={toggle}
          />
        </Show>
      </li>
    );
  };

  // ── Service accounts by handle ────────────────────────────────────
  const [handleOpen, setHandleOpen] = createSignal(false);
  const [handle, setHandle] = createSignal("");
  const [lookup, setLookup] = createSignal<"idle" | "searching" | "none" | "failed">("idle");
  const [found, setFound] = createSignal<FoundServiceAccount | null>(null);
  let addingArea: HTMLLIElement | undefined;
  let lookupAbort: AbortController | undefined;
  onCleanup(() => lookupAbort?.abort());
  /** A complete handle is looked up as it is typed or pasted; the hit is offered below the field. */
  const findAccount = async (value: string) => {
    const find = findServiceAccount();
    if (!find) return;
    const controller = new AbortController();
    lookupAbort = controller;
    setLookup("searching");
    try {
      const result = await find(value, controller.signal);
      if (controller.signal.aborted || disposed) return;
      setFound(result);
      setLookup(result ? "idle" : "none");
      // The hit appears below the field; the sheet keeps both in view.
      queueMicrotask(() => addingArea?.scrollIntoView?.({ block: "nearest" }));
    } catch {
      if (!controller.signal.aborted && !disposed) setLookup("failed");
    }
  };
  const changeHandle = (value: string) => {
    // A changed handle ends the lookup for the old one, so its answer never appears.
    lookupAbort?.abort();
    setHandle(value);
    setFound(null);
    if (CODE_ACCOUNT_HANDLE_PATTERN.test(value.trim())) void findAccount(value.trim());
    else setLookup("idle");
  };
  const openAdding = () => {
    setHandleOpen(true);
    // On a phone the sheet brings the field and its hit into view itself.
    queueMicrotask(() => addingArea?.scrollIntoView?.({ block: "nearest" }));
  };
  const closeAdding = () => {
    lookupAbort?.abort();
    setHandleOpen(false);
    setHandle("");
    setFound(null);
    setLookup("idle");
  };
  /** Descriptions of service accounts the search for people found, so their row keeps the server's line. */
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
    closeAdding();
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().title({ name: props.resourceName })}
        subtitle={props.subtitle}
        close={() => void dismiss()}
        closeDisabled={saving()}
      />
      <PanelDialog.Body>
        <div class="flex flex-col gap-3">
          <Show
            when={canEdit()}
            fallback={
              <Show when={!loading()}>
                <p class="text-[13px] text-dimmed">{readOnlyLine()}</p>
              </Show>
            }
          >
            <Show when={!loading()}>
              <PrincipalPicker
                existing={rows()
                  .filter((row) => row.next)
                  .map((row) => row.principal)}
                allowAuthenticated={false}
                allowPublic={false}
                allowServiceAccounts={props.allowAgents !== false}
                serviceAccountKinds={["agent", "standalone"]}
                serviceAccountStatus="active"
                placeholder={t().search}
                disabled={saving()}
                // Someone already on the list stays in the results, greyed with their level, so the search never looks
                // like it missed them.
                takenReason={(principal) => {
                  const listed = rows().find((row) => row.next && principalKey(row.principal) === principalKey(principal));
                  return listed ? t().alreadyHas({ level: levelLabel(listed.principal, listed.next) }) : undefined;
                }}
                empty={(query) => (
                  <span class="flex flex-col items-center gap-1 py-2 text-center">
                    <i class="ti ti-search-off text-lg text-dimmed" aria-hidden="true" />
                    <span>{t().nobodyNamed({ query })}</span>
                    <span class="text-dimmed">{t().searchHint}</span>
                  </span>
                )}
                findServiceAccount={
                  findServiceAccount() &&
                  (async (value, signal) => {
                    const account = await findServiceAccount()!(value, signal);
                    if (account?.description && account.principal.type === "service_account")
                      foundDescriptions.set(account.principal.serviceAccountId, account.description);
                    // The hit says where it goes, since it joins Service accounts rather than the list below the search.
                    return (
                      account && { ...account, description: t().serviceAccountJoins({ kind: account.description ?? t().serviceAccount }) }
                    );
                  })
                }
                onSelect={(principal, display) =>
                  edit((current) =>
                    addPrincipal(
                      current,
                      principal,
                      withDescription(principal, display),
                      firstLevel(principal, display.serviceAccountKind),
                    ),
                  )
                }
              />
            </Show>
          </Show>

          <PanelDialog.Section
            title={
              <>
                {t().people} <span class="font-normal text-dimmed">{loading() ? "" : peopleRows().filter((row) => row.next).length}</span>
              </>
            }
          >
            <Show
              when={loadState() === "ready"}
              fallback={
                <Show
                  when={loadState() === "failed"}
                  fallback={
                    <ul class="flex flex-col" aria-busy="true">
                      <span class="sr-only" role="status">
                        {t().loading}
                      </span>
                      <For each={["max-w-[62%]", "max-w-[48%]", "max-w-[58%]", "max-w-[52%]"]}>
                        {(width) => (
                          <li class="flex items-center gap-3 py-2" aria-hidden="true">
                            <Skeleton class="h-8 w-8 shrink-0 rounded-full" />
                            <Skeleton class={`h-3 min-w-0 flex-1 ${width}`} />
                            <Skeleton class="ml-auto h-8 w-28 shrink-0 sm:w-40" />
                          </li>
                        )}
                      </For>
                    </ul>
                  }
                >
                  <NoticeCard tone="danger" role="alert">
                    <span>{t().loadFailed}</span>{" "}
                    <Button variant="secondary" size="sm" onClick={() => void load()}>
                      {t().retry}
                    </Button>
                  </NoticeCard>
                </Show>
              }
            >
              <Show when={peopleRows().length > 0} fallback={<p class="text-[13px] text-dimmed">{t().nobodyListed}</p>}>
                <ul class="flex flex-col">
                  {/* Rows are keyed by principal, so a staged change keeps the row, its controls and the focus. */}
                  <For each={peopleRows().map((row) => row.key)}>
                    {(key) => <Show when={rows().find((row) => row.key === key)}>{(row) => <AccessRow row={row()} />}</Show>}
                  </For>
                </ul>
              </Show>
            </Show>
          </PanelDialog.Section>

          <Show when={!loading() && showGeneral()}>
            <PanelDialog.Section title={t().general}>
              <ul class="flex flex-col">
                <Show when={props.allowAuthenticated !== false || generalRow("authenticated")}>
                  <GeneralRow type="authenticated" />
                </Show>
                <Show when={props.allowPublic === true || generalRow("public")}>
                  <GeneralRow type="public" />
                  <Show when={(generalRow("public")?.next?.permission ?? "none") !== "none"}>
                    <li class="flex flex-col gap-2 pb-2 sm:pl-11">
                      <NoticeCard tone="warning">{props.publicWarning ?? t().publicWarning}</NoticeCard>
                      <Show when={props.publicLink}>
                        {(link) => (
                          <div class="flex items-center gap-2 [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1">
                            <TextInput aria-label={access().anyoneWithLink} value={() => link()} readOnly />
                            <CopyButton text={link()} />
                          </div>
                        )}
                      </Show>
                    </li>
                  </Show>
                </Show>
              </ul>
            </PanelDialog.Section>
          </Show>

          <Show when={!loading() && showObjectAccounts()}>
            <PanelDialog.Section
              title={
                <>
                  {t().serviceAccounts} <span class="font-normal text-dimmed">{objectAccountRows().filter((row) => row.next).length}</span>
                </>
              }
              actions={
                // Beside the title at every width, as in the approved mockup; gone while the field is open.
                <Show when={canAddObjectAccounts() && !handleOpen()}>
                  {/* A phone has room beside the title only for the short label; the name stays complete. */}
                  <Button variant="secondary" size="sm" disabled={saving()} aria-label={t().addServiceAccount} onClick={openAdding}>
                    <i class="ti ti-plus" aria-hidden="true" />
                    <span class="max-sm:hidden">{t().addServiceAccount}</span>
                    <span class="sm:hidden">{t().add}</span>
                  </Button>
                </Show>
              }
            >
              {/* Only rows or the open field make a list, so nothing stands empty before the text below. */}
              <Show when={objectAccountRows().length > 0 || handleOpen()}>
                <ul class="flex flex-col">
                  <For each={objectAccountRows().map((row) => row.key)}>
                    {(key) => <Show when={rows().find((row) => row.key === key)}>{(row) => <AccessRow row={row()} />}</Show>}
                  </For>
                  <Show when={handleOpen()}>
                    <li ref={addingArea} class="flex flex-col gap-2 py-2">
                      <form
                        class="flex items-center gap-2 [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const account = found();
                          const value = handle().trim();
                          if (account) addFound(account);
                          else if (lookup() === "searching") return;
                          // Enter asks again for a complete handle, so a failed lookup can be retried.
                          else if (CODE_ACCOUNT_HANDLE_PATTERN.test(value)) void findAccount(value);
                          else setLookup("none");
                        }}
                      >
                        <TextInput
                          icon="ti ti-code"
                          aria-label={t().serviceAccountHandle}
                          placeholder={t().serviceAccountHandlePlaceholder}
                          value={handle}
                          onValueChange={changeHandle}
                          autofocus
                        />
                        <Button variant="text" size="sm" onClick={closeAdding}>
                          {t().cancel}
                        </Button>
                      </form>
                      <Show when={found()}>
                        {(account) => (
                          <button
                            type="button"
                            class="flex w-full items-center gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-2 text-left hover:bg-[var(--ui-surface-muted)]"
                            disabled={saving()}
                            onClick={() => addFound(account())}
                          >
                            <PrincipalAvatar
                              entry={{
                                principal: account().principal,
                                avatarHash: account().display.avatarHash,
                                serviceAccountKind: account().display.serviceAccountKind,
                              }}
                              label={account().display.displayName}
                            />
                            <span class="min-w-0 flex-[1_1_10rem]">
                              {/* A long title wraps on a phone instead of pushing the mark out of the sheet. */}
                              <span class="block min-w-0 break-words max-sm:text-sm sm:text-[15px] font-medium text-primary">
                                {account().display.displayName}
                              </span>
                              <span class="block break-words text-[13px] text-dimmed">{account().description || t().serviceAccount}</span>
                            </span>
                            <StatusBadge class="shrink-0" tone="neutral" icon={null} label={access().codeServiceAccount} />
                          </button>
                        )}
                      </Show>
                      <Show when={lookup() !== "idle"}>
                        <p class="text-[13px] text-dimmed" role="status">
                          {lookup() === "searching"
                            ? t().serviceAccountSearching
                            : lookup() === "none"
                              ? t().serviceAccountNotFound
                              : t().serviceAccountLookupFailed}
                        </p>
                      </Show>
                    </li>
                  </Show>
                </ul>
              </Show>
              {/* As in the approved mockup: one note under the rows, or the empty text; neither while adding. */}
              <Show when={!handleOpen()}>
                <p class="text-[13px] text-dimmed">
                  {objectAccountRows().length > 0 ? t().serviceAccountNote({ name: props.resourceName }) : t().serviceAccountsEmpty}
                </p>
              </Show>
            </PanelDialog.Section>
          </Show>

          {/* An object's API keys: each has its own account and level, as in the approved mockup. */}
          <Show when={!loading() && apiKeyRows().length > 0}>
            <PanelDialog.Section
              title={
                <>
                  {t().apiKeys} <span class="font-normal text-dimmed">{apiKeyRows().filter((row) => row.next).length}</span>
                </>
              }
            >
              <ul class="flex flex-col">
                <For each={apiKeyRows().map((row) => row.key)}>
                  {(key) => <Show when={rows().find((row) => row.key === key)}>{(row) => <AccessRow row={row()} />}</Show>}
                </For>
              </ul>
            </PanelDialog.Section>
          </Show>

          {props.extraSections}

          <Show when={changes().length > 0 && summaryOpen()}>
            <section class="flex flex-col gap-2 pt-1" aria-live="polite">
              <h3 class="text-sm font-semibold text-primary">
                {t().whatChanges} <span class="font-normal text-dimmed">{changes().length}</span>
              </h3>
              <ChangeList label={t().whatChanges} items={summary()} />
            </section>
          </Show>
          <Show when={failed()}>
            <NoticeCard tone="danger" role="alert">
              <span>{t().saveFailed({ count: changes().length })}</span>{" "}
              <Button variant="secondary" size="sm" onClick={() => void save()}>
                {t().retry}
              </Button>
            </NoticeCard>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Show
          when={canEdit()}
          fallback={
            <div class="flex w-full justify-end">
              <Button variant="secondary" onClick={() => void dismiss()}>
                {t().close}
              </Button>
            </div>
          }
        >
          <div class="flex w-full flex-wrap items-center justify-end gap-2">
            <span class="mr-auto flex basis-full items-center gap-2 text-sm text-secondary sm:basis-auto" role="status">
              <Show when={changes().length > 0} fallback={t().noChanges}>
                <b>{t().changeCount({ count: changes().length })}</b>
                <Button variant="text" size="sm" onClick={() => setSummaryOpen((open) => !open)} aria-expanded={summaryOpen()}>
                  {summaryOpen() ? t().hideChanges : t().showChanges}
                </Button>
              </Show>
            </span>
            <Button variant="secondary" disabled={saving()} onClick={() => void dismiss()}>
              {t().cancel}
            </Button>
            <Button disabled={changes().length === 0} loading={saving()} onClick={() => void save()}>
              {t().save}
            </Button>
          </div>
        </Show>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default AccessDialog;
