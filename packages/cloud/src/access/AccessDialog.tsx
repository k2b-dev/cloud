import {
  Button,
  ChangeList,
  type ChangeListItem,
  CopyButton,
  dialogCore,
  NoticeCard,
  PanelDialog,
  prompts,
  Skeleton,
  StatusBadge,
  Switch,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { CloudResourceRef } from "../contracts/capabilities";
import type { AccessEntry, Principal } from "../contracts/shared";
import { AccessLevelMenu, AccessRowControls, AccessRowFrame } from "./AccessRow";
import { accessDialogMessages } from "./access-dialog-messages";
import { type AccessMark, createAccessDialogState, isApiKeyAccount, isCodeAccount } from "./access-dialog-state";
import { addPrincipal, type DraftDisplay, type DraftRow, removeRow, restoreRow, setLevel } from "./access-draft";
import { type AllowedLevel, type GrantableLevel, levelKey } from "./PermissionEditor";
import PrincipalPicker, { type FoundServiceAccount } from "./PrincipalPicker";
import { principalKey } from "./principal-key";
import { ServiceAccountSection } from "./ServiceAccountSection";

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
 * Who may use one resource, as one list with "What changes" below it. Nothing applies before Save; a removal asks
 * again; the last entry that manages the resource keeps Manage.
 */
export function AccessDialog(
  props: AccessDialogProps & { close: (saved: boolean) => void; setDismissHandler?: (handler: () => void) => void },
) {
  const locale = useLocale();
  const state = createAccessDialogState(
    props,
    locale,
    (question) =>
      prompts.confirm(question.body, {
        title: question.title,
        variant: "danger",
        confirmText: question.confirm,
        cancelText: question.cancel,
      }),
    (saved) => props.close(saved),
  );
  const {
    t,
    access,
    canEdit,
    findServiceAccount,
    loadState,
    loading,
    load,
    saving,
    failed,
    rows,
    changes,
    lastManagers,
    rowLevels,
    manageLabel,
    levelLabel,
    nameOf,
    generalRow,
    peopleRows,
    objectAccountRows,
    apiKeyRows,
    readOnlyLine,
    showGeneral,
    showObjectAccounts,
    edit,
    firstLevel,
    save,
    dismiss,
    kindLine,
    isViewer,
    canRestore,
    foundDescriptions,
    withDescription,
    addFound,
  } = state;
  const [summaryOpen, setSummaryOpen] = createSignal(true);

  // ── What changes ──────────────────────────────────────────────────────
  const summary = (): ChangeListItem[] =>
    state.changeItems().map((item) => ({
      tone: item.tone,
      ...(item.icon ? { icon: `ti ti-${item.icon}` } : {}),
      content: (
        <>
          <b>{item.name}</b>
          {item.text}
        </>
      ),
      detail: item.detail,
    }));
  props.setDismissHandler?.(() => void dismiss());

  // ── Rows ──────────────────────────────────────────────────────────────
  const badge = (value: AccessMark | null) =>
    value && (
      <StatusBadge
        class="shrink-0"
        tone={value.tone === "bad" ? "error" : value.tone === "warn" ? "warning" : "ok"}
        icon={null}
        label={value.label}
      />
    );
  const mark = (row: DraftRow) => badge(state.mark(row));
  const LevelMenu = (menuProps: { row: DraftRow; onRemove?: (trigger: HTMLElement) => void }) => {
    const row = () => menuProps.row;
    const protectedRow = () => lastManagers().has(row().key);
    return (
      <AccessLevelMenu
        name={nameOf(row())}
        value={row().next ? levelKey(row().next!.permission, row().next!.scope) : ""}
        valueLabel={levelLabel(row().principal, row().next)}
        options={rowLevels(row()).map((option) => {
          const locked = protectedRow() && (option.level !== "admin" || option.scope !== undefined);
          return {
            value: option.key,
            label: option.label,
            level: option.level,
            icon: option.icon,
            disabled: locked,
            description: locked ? t().lastManagerOption({ level: manageLabel(row().principal) }) : option.description,
          };
        })}
        onChange={(key) => {
          const option = rowLevels(row()).find((candidate) => candidate.key === key);
          if (option)
            edit((draftNow) => setLevel(draftNow, row(), { permission: option.level, ...(option.scope ? { scope: option.scope } : {}) }));
        }}
        disabled={!canEdit() || saving()}
        onRemove={menuProps.onRemove}
        removeDisabled={protectedRow() || saving()}
        removeHint={protectedRow() ? t().lastManagerHint({ level: manageLabel(row().principal) }) : undefined}
      />
    );
  };
  /** Undo may not leave the resource without a manager, for example by bringing back a denial. */
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
      <AccessRowFrame
        rowKey={row().key}
        dimmed={!row().next}
        avatar={{ principal: row().principal, avatarHash: row().display.avatarHash, serviceAccountKind: row().display.serviceAccountKind }}
        name={nameOf(row())}
        href={row().display.serviceAccountHref}
        nameAside={
          <>
            <Show when={isViewer(row())}>
              <span class="shrink-0 text-[13px] font-normal text-dimmed">{t().you}</span>
            </Show>
            {mark(row())}
          </>
        }
        lineLead={
          <>
            <Show when={mark(row())}>
              {(badge) => <span class="mr-1.5 h-5 items-center align-top max-sm:inline-flex sm:hidden">{badge()}</span>}
            </Show>
            {/* On a phone "You" leads the line, after the mark, so the name and a mark always stay whole. */}
            <Show when={isViewer(row())}>
              <span class="max-sm:inline sm:hidden">{`${t().you} · `}</span>
            </Show>
          </>
        }
        line={kindLine(row())}
        wrapLine={isCodeAccount(row().display.serviceAccountKind)}
        end={
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
            <AccessRowControls
              menu={
                // A stored denial is shown, never offered: it can only be removed.
                <Show
                  when={row().next?.permission !== "none"}
                  fallback={<span class="text-sm text-secondary">{levelLabel(row().principal, row().next)}</span>}
                >
                  <LevelMenu row={row()} onRemove={removeFrom} />
                </Show>
              }
              name={nameOf(row())}
              removeLabel={protectedRow() ? t().lastManagerRemove({ level: manageLabel(row().principal) }) : undefined}
              removeDisabled={saving() || protectedRow()}
              onRemove={removeFrom}
            />
          </Show>
        }
      />
    );
  };

  // ── General ───────────────────────────────────────────────────────────
  const GeneralRow = (rowProps: { type: "authenticated" | "public" }) => {
    const row = () => generalRow(rowProps.type);
    const on = () => state.generalOn(rowProps.type);
    const toggle = (value: boolean) => state.toggleGeneral(rowProps.type, value);
    const description = () => state.generalDescription(rowProps.type);
    const generalMark = () => badge(state.generalMark(rowProps.type));
    const principal: Principal = { type: rowProps.type };
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
          {/* While the list loads the state is not known, so the line waits in its own height instead of claiming "Off". */}
          <Show
            when={!loading()}
            fallback={
              <span class="flex h-5 items-center" aria-hidden="true">
                <Skeleton class="h-3 w-48 max-w-full" />
              </span>
            }
          >
            <span class="block truncate text-[13px] leading-5 text-dimmed">
              <Show when={generalMark()}>
                {(badge) => <span class="mr-1.5 h-5 items-center align-top max-sm:inline-flex sm:hidden">{badge()}</span>}
              </Show>
              {description()}
            </span>
          </Show>
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
  // ── Service accounts by handle ────────────────────────────────────
  let body: HTMLDivElement | undefined;
  const revealRow = (principal: Principal) => {
    const key = rows().find((row) => row.next && principalKey(row.principal) === principalKey(principal))?.key;
    Array.from(body?.querySelectorAll<HTMLElement>("li[data-access-key]") ?? [])
      .find((item) => item.dataset.accessKey === key)
      ?.scrollIntoView?.({ block: "nearest" });
  };
  /** Descriptions of service accounts the search for people found, so their row keeps the server's line. */
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().title({ name: props.resourceName })}
        subtitle={props.subtitle}
        close={() => void dismiss()}
        closeDisabled={saving()}
      />
      <PanelDialog.Body>
        <div ref={body} class="flex flex-col gap-3">
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
                onSelect={(principal, display) => {
                  edit((current) =>
                    addPrincipal(
                      current,
                      principal,
                      withDescription(principal, display),
                      firstLevel(principal, display.serviceAccountKind),
                    ),
                  );
                  // A service account or an API key joins its own section further down; on a phone the sheet brings
                  // the new row into view, as it does for the handle field.
                  if (isCodeAccount(display.serviceAccountKind) || isApiKeyAccount(display.serviceAccountKind))
                    queueMicrotask(() => revealRow(principal));
                }}
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
                            <Skeleton class="ml-auto h-8 max-sm:w-28 shrink-0 sm:w-40" />
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

          {/* As in the approved mockup, General keeps its place while the list loads; its switches wait for the list. */}
          <Show when={loadState() !== "failed" && showGeneral()}>
            <PanelDialog.Section title={t().general}>
              <ul class="flex flex-col">
                <Show when={props.allowAuthenticated !== false || generalRow("authenticated")}>
                  <GeneralRow type="authenticated" />
                </Show>
                <Show when={props.allowPublic === true || generalRow("public")}>
                  <GeneralRow type="public" />
                  <Show when={(generalRow("public")?.next?.permission ?? "none") !== "none"}>
                    <li class="flex flex-col gap-2 pb-2 sm:pl-11">
                      <NoticeCard tone="warning" icon>
                        {props.publicWarning ?? t().publicWarning}
                      </NoticeCard>
                      <Show when={props.publicLink}>
                        {(link) => (
                          // As in the approved mockup, Copy stands as high as the link beside it.
                          <div class="flex items-stretch gap-2 [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1">
                            <TextInput aria-label={access().anyoneWithLink} value={() => link()} readOnly />
                            <CopyButton text={link()} iconOnly={false} variant="secondary" size="md" />
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
            <ServiceAccountSection
              find={findServiceAccount()}
              resourceName={props.resourceName}
              count={objectAccountRows().filter((row) => row.next).length}
              hasRows={objectAccountRows().length > 0}
              readOnly={!canEdit()}
              disabled={saving()}
              add={addFound}
            >
              <For each={objectAccountRows().map((row) => row.key)}>
                {(key) => <Show when={rows().find((row) => row.key === key)}>{(row) => <AccessRow row={row()} />}</Show>}
              </For>
            </ServiceAccountSection>
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
            <span class="mr-auto flex max-sm:basis-full items-center gap-2 text-sm text-secondary sm:basis-auto" role="status">
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
            <Button disabled={changes().length === 0 || saving()} aria-busy={saving() ? "true" : undefined} onClick={() => void save()}>
              {/*
                As in the approved mockup, the button says that it saves. Both labels share one cell, and an invisible copy
                of the busy label holds its width at rest, so the button keeps its size and nothing beside it moves.
              */}
              <span
                class="grid after:invisible after:col-start-1 after:row-start-1 after:h-0 after:overflow-hidden after:pl-[calc(1em+0.375rem)] after:content-[attr(data-busy)]"
                data-busy={t().saving}
              >
                <span class="col-start-1 row-start-1" classList={{ invisible: saving() }}>
                  {t().save}
                </span>
                <Show when={saving()}>
                  <span class="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5">
                    <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                    {t().saving}
                  </span>
                </Show>
              </span>
            </Button>
          </div>
        </Show>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default AccessDialog;
