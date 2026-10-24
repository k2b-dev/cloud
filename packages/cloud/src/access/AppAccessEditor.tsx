import { Button, bottomSheetAdaptiveOptions, dialogCore, IconButton, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import type { AppAccessRule } from "../contracts/app-access";
import type { AccessEntry } from "../contracts/shared";
import type { AppAccessChange, AppAccessSnapshot } from "../services/app-access-management";
import { AppAccessClientError, appAccessAdapter } from "./app-access-adapter";
import { appAccessMessages } from "./app-access-messages";
import PermissionEditor, { type GrantableLevel } from "./PermissionEditor";
import { principalKey } from "./PrincipalPicker";
import { principalLabel } from "./principal-label";

export type AppAccessEditorProps = {
  app: { id: string; name: string; access?: AppAccessRule };
  initial?: AppAccessSnapshot;
  repair?: boolean;
  /** Return to the current page so its normal authorization renders the new state. */
  onAccessLost?: () => void;
};

/** Application authors place this editor in their settings; Core uses it unchanged for explicit repair. */
export default function AppAccessEditor(props: AppAccessEditorProps) {
  const locale = useLocale(),
    t = () => appAccessMessages.resolve([locale()]).t;
  const descriptionId = createUniqueId();
  const adapter = appAccessAdapter(props.app.id, { repair: props.repair });
  const [snapshot, setSnapshot] = createSignal(props.initial);
  const [loading, setLoading] = createSignal(!props.initial);
  // A problem's optional lead sentence is set in bold, as in the approved notices.
  const [error, setError] = createSignal<{ lead?: string; text: string }>();
  const [blocked, setBlocked] = createSignal(false);
  const [forbidden, setForbidden] = createSignal(false);
  const [showInherited, setShowInherited] = createSignal(true);
  let section: HTMLElement | undefined;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  /** `revoked` is false when only managing ended and use is confirmed, so the reloaded page shows no removal notice. */
  const lost = (revoked = true) => {
    if (!controller.signal.aborted)
      (
        props.onAccessLost ??
        (() => {
          const url = new URL(window.location.href);
          if (revoked) url.searchParams.set("_cloud_access", "revoked");
          else url.searchParams.delete("_cloud_access");
          window.location.replace(url.href);
        })
      )();
  };
  const load = async (trigger?: HTMLButtonElement) => {
    const hadFocus = trigger !== undefined && document.activeElement === trigger;
    setLoading(true);
    try {
      const fresh = await adapter.read(controller.signal);
      const restoreFocus = hadFocus && (document.activeElement === trigger || document.activeElement === document.body);
      setSnapshot(fresh);
      setError(undefined);
      setBlocked(false);
      if (restoreFocus)
        queueMicrotask(() => {
          if (!controller.signal.aborted && document.activeElement === document.body)
            (
              section?.querySelector<HTMLElement>('input[role="combobox"]') ?? section?.querySelector<HTMLElement>("button:not(:disabled)")
            )?.focus();
        });
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof AppAccessClientError && failure.status === 403) {
          setForbidden(true);
          setSnapshot(undefined);
          setError({ text: t().forbidden });
        } else setError({ lead: t().loadFailedLead, text: t().loadFailed });
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  onMount(() => {
    if (!props.initial && props.app.access?.kind === "grants") void load();
  });
  const errorText = (error: AppAccessClientError, change: AppAccessChange) =>
    error.code === "LAST_MANAGER"
      ? t().lastManager
      : error.status === 403
        ? t().forbidden
        : error.code === "CONFLICT" && change.action === "grant"
          ? t().alreadyGranted
          : error.code === "CONFLICT" || error.code === "NOT_FOUND"
            ? t().listChanged
            : t().saveFailed;

  const perform = async (change: AppAccessChange) => {
    if (blocked()) throw new Error(t().uncertain);
    let result: { entry?: AccessEntry; canUse: boolean };
    try {
      result = await adapter.change(change, controller.signal);
    } catch (failure) {
      if (failure instanceof AppAccessClientError && failure.status < 500) {
        if (failure.status === 403) {
          setForbidden(true);
          setSnapshot(undefined);
          setError({ text: t().forbidden });
        } else if (failure.status === 400 || failure.status === 404 || failure.status === 409) {
          // The same request cannot succeed again: offer the canonical list instead of a retry.
          try {
            setSnapshot(await adapter.read(controller.signal));
            setError({ text: errorText(failure, change) });
          } catch (readFailure) {
            if (readFailure instanceof AppAccessClientError && readFailure.status === 403) {
              setSnapshot(undefined);
              setForbidden(true);
              lost();
            }
            setError({ text: t().uncertain });
          }
          setBlocked(true);
        }
        throw new Error(errorText(failure, change));
      }
      // A lost response can follow a commit. Read the canonical list before offering another write.
      let fresh: AppAccessSnapshot;
      try {
        fresh = await adapter.read(controller.signal);
      } catch (readFailure) {
        if (readFailure instanceof AppAccessClientError && readFailure.status === 403) {
          setSnapshot(undefined);
          setForbidden(true);
          setError({ text: t().forbidden });
          lost();
          throw new Error(t().forbidden);
        }
        setBlocked(true);
        setError({ text: t().uncertain });
        throw new Error(t().uncertain);
      }
      setSnapshot(fresh);
      const entry =
        change.action === "grant"
          ? fresh.entries.find((entry) => principalKey(entry.principal) === principalKey(change.principal))
          : fresh.entries.find((entry) => entry.id === change.accessId);
      const applied = change.action === "revoke" ? !entry : entry?.permission === change.permission;
      if (!applied) throw new Error(t().saveFailed);
      result = { entry, canUse: fresh.canUse };
    }
    if (!result.canUse && !props.repair) lost();
    else {
      try {
        setSnapshot(await adapter.read(controller.signal));
      } catch (failure) {
        // Use is confirmed here; only managing this list ended.
        if (failure instanceof AppAccessClientError && failure.status === 403) lost(false);
        else {
          setBlocked(true);
          setError({ text: t().savedRefreshFailed });
        }
      }
    }
    return result;
  };
  const beforeChange = async (entry: AccessEntry, next: GrantableLevel | null) => {
    if (props.repair || !snapshot()?.ownEntryIds.includes(entry.id) || (next !== null && entry.permission !== "admin")) return true;
    const own =
      snapshot()?.entries.filter((candidate) => candidate.id !== entry.id && snapshot()?.ownEntryIds.includes(candidate.id)) ?? [];
    const losesUse = next === null && own.length === 0;
    const losesManagement = !own.some((candidate) => candidate.permission === "admin");
    // Name only managers the platform counts, so an empty group or an expired account is never offered as the rescue.
    const others = (snapshot()?.entries ?? [])
      .filter((candidate) => candidate.id !== entry.id && (candidate.effectiveManager ?? candidate.permission === "admin"))
      .map((candidate) => principalLabel(candidate, locale()));
    const remaining = t().remainingManagers({
      managers: new Intl.ListFormat(locale(), { type: "conjunction" }).format(others),
      count: others.length,
    });
    return (
      (await dialogCore.open<boolean>(
        (close) => (
          <div class="mx-auto w-full max-w-[440px] p-5 text-primary max-md:pb-[calc(2rem+env(safe-area-inset-bottom,0px))]">
            <h2 class="mb-2 text-[17px] font-semibold">
              {entry.principal.type === "authenticated"
                ? t().removeAudienceTitle
                : next === null
                  ? t().removeSelfTitle
                  : t().changeSelfTitle}
            </h2>
            <p id={descriptionId} class="mb-4 text-[15px] text-secondary">
              {(entry.principal.type === "authenticated"
                ? t().removeAudience
                : losesUse
                  ? t().removeSelf
                  : losesManagement
                    ? t().removeSelfManagement
                    : next === null
                      ? t().removeSelfEntry
                      : t().changeSelfEntry)({ name: props.app.name })}{" "}
              {remaining}
            </p>
            <div class="flex justify-end gap-2">
              <Button variant="secondary" style={{ "min-height": "36px", "font-size": "15px" }} onClick={() => close(false)}>
                {t().cancel}
              </Button>
              <Button variant="danger" style={{ "min-height": "36px", "font-size": "15px" }} onClick={() => close(true)}>
                {next === null ? t().remove : t().change}
              </Button>
            </div>
          </div>
        ),
        {
          ...bottomSheetAdaptiveOptions,
          role: "alertdialog",
          ariaDescribedBy: descriptionId,
          panelClassName: `${bottomSheetAdaptiveOptions.panelClassName} md:!w-[440px] !border-0`,
          // Without ariaLabel, the dialog is labelled by its heading.
          signal: controller.signal,
          history: true,
        },
      )) === true
    );
  };
  const fixedDescription = () => {
    switch (props.app.access?.kind) {
      case "signedIn":
        return t().fixedSignedIn;
      case "noGuests":
        return t().fixedNoGuests;
      case "roles":
        return props.app.access.roles.length === 1 && props.app.access.roles[0] === "admin" ? t().fixedAdmins : t().fixedRoles;
      default:
        return t().legacy;
    }
  };
  return (
    <section ref={section} class="w-full max-w-[720px]" aria-label={t().access}>
      <h2 class="mb-1 text-[15px] font-semibold">{t().whoUses({ name: props.app.name })}</h2>
      <Show
        when={props.app.access?.kind === "grants"}
        fallback={<p class="max-w-[60ch] text-[15px] text-secondary">{fixedDescription()}</p>}
      >
        <p class="mb-4 max-w-[60ch] text-[15px] text-secondary">{t().description({ name: props.app.name })}</p>
        <div class="flex flex-col gap-4">
          <Show when={props.repair}>
            <NoticeCard tone="info" icon="ti ti-shield-check">
              <p>{t().repairNotice({ name: props.app.name })}</p>
            </NoticeCard>
          </Show>
          <Show when={props.repair && snapshot() && !snapshot()!.hasEffectiveManager}>
            <NoticeCard tone="warning" icon="ti ti-alert-triangle">
              <p>
                <strong class="font-semibold">{t().noManagerLead}</strong> {t().noManager}
              </p>
            </NoticeCard>
          </Show>
          {/* Repair already explains itself; the transition note is for the app's own managers. */}
          <Show when={!props.repair && showInherited() && snapshot()?.inheritedSignedIn}>
            <NoticeCard tone="info" icon="ti ti-info-circle">
              <div class="flex items-start gap-2">
                <p class="flex-1">{t().inherited({ name: props.app.name })}</p>
                <IconButton
                  variant="ghost"
                  size="sm"
                  class="!text-inherit"
                  onClick={() => {
                    setShowInherited(false);
                    // The button leaves with its notice; the search is where editing continues.
                    queueMicrotask(() => section?.querySelector<HTMLElement>('input[role="combobox"]')?.focus());
                  }}
                  label={t().closeNotice}
                >
                  <i class="ti ti-x text-[18px]" />
                </IconButton>
              </div>
            </NoticeCard>
          </Show>
          <Show when={error()}>
            {(problem) => (
              <NoticeCard tone="danger" icon="ti ti-alert-circle" role="alert">
                <div class="flex flex-wrap items-start gap-2">
                  <p class="flex-1">
                    <Show when={problem().lead}>
                      {(lead) => (
                        <>
                          <strong class="font-semibold">{lead()}</strong>{" "}
                        </>
                      )}
                    </Show>
                    {problem().text}
                  </p>
                  <Show when={!forbidden()}>
                    <Button
                      variant="secondary"
                      style={{ "min-height": "36px", "font-size": "15px" }}
                      loading={loading()}
                      onClick={(event) => void load(event.currentTarget)}
                    >
                      {t().reload}
                    </Button>
                  </Show>
                </div>
              </NoticeCard>
            )}
          </Show>
          <Show
            when={snapshot()}
            fallback={
              <Show when={loading()}>
                <div aria-busy="true" class="flex flex-col gap-1">
                  <For each={[0, 1, 2, 3]}>
                    {() => (
                      // The same grid as a loaded row, so the list keeps its place when the entries arrive.
                      <div class="grid min-h-[52px] grid-cols-[32px_minmax(0,1fr)_36px] items-center gap-x-3 gap-y-1.5 py-2 sm:flex sm:px-2 sm:py-1.5">
                        <span class="h-8 w-8 animate-pulse rounded-full bg-[var(--k2b-surface-muted)]" />
                        <span class="flex min-w-0 flex-1 flex-col gap-1.5">
                          <span class="h-3.5 w-2/5 animate-pulse rounded bg-[var(--k2b-surface-muted)]" />
                          <span class="h-3 w-1/4 animate-pulse rounded bg-[var(--k2b-surface-muted)]" />
                        </span>
                        <span class="col-start-2 row-start-2 h-9 animate-pulse rounded-[var(--ui-radius-control)] bg-[var(--k2b-surface-muted)] sm:w-44 sm:flex-none" />
                        <span class="w-9 shrink-0" />
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            }
          >
            {(state) => (
              <PermissionEditor
                expanded
                initialEntries={state().entries}
                effectiveEntries={(entries) =>
                  entries.filter((entry) => state().entries.find((candidate) => candidate.id === entry.id)?.effectiveManager !== false)
                }
                // Everyone matches all signed-in people, so that row is nobody's own marker.
                ownEntryIds={state().ownEntryIds.filter((id) =>
                  state().entries.some((entry) => entry.id === id && entry.principal.type !== "authenticated"),
                )}
                placeholder={t().add}
                signedIn={{ label: t().signedIn, description: t().signedInDescription }}
                entryDetail={(entry) => {
                  const count = state().entries.find((candidate) => candidate.id === entry.id)?.groupMemberCount;
                  return entry.principal.type === "group" && count !== undefined ? t().group({ count }) : undefined;
                }}
                canEdit={!blocked()}
                allowPublic={false}
                allowAuthenticated
                allowServiceAccounts
                beforeChange={beforeChange}
                allowedLevels={(principal) => {
                  const use = { level: "read" as const, label: t().use };
                  if (principal.type === "authenticated") return [use];
                  const manage = { level: "admin" as const, label: t().manage };
                  // New entries start at the first level; without a manager, the first change must add one.
                  return state().hasEffectiveManager ? [use, manage] : [manage, use];
                }}
                grantAccess={async (principal, permission) => {
                  if (permission !== "read" && permission !== "admin") throw new Error("Unsupported app permission");
                  const result = await perform({ action: "grant", principal, permission });
                  if (!result.entry) throw new Error(t().uncertain);
                  return result.entry;
                }}
                updateAccess={async (accessId, permission) => {
                  if (permission !== "read" && permission !== "admin") throw new Error("Unsupported app permission");
                  await perform({ action: "update", accessId, permission });
                }}
                revokeAccess={async (accessId) => {
                  await perform({ action: "revoke", accessId });
                }}
              />
            )}
          </Show>
        </div>
        <dl class="mt-6 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          <dt class="font-medium">{t().use}</dt>
          <dd class="mb-2 text-secondary sm:mb-0">{t().useDescription}</dd>
          <dt class="font-medium">{t().manage}</dt>
          <dd class="text-secondary">{t().manageDescription}</dd>
        </dl>
      </Show>
    </section>
  );
}
