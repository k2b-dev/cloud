import { announce, Button, NoticeCard, prompts, Skeleton, useLocale } from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { z } from "zod";
import { navigationApps } from "../browser/navigation-apps";
import {
  CODE_ACCESS_ACCOUNTS_MAX,
  type CodeAccessAccount,
  CodeAccessAccountsDataSchema,
  CodeAccessRemoveDataSchema,
  type CodeGrantDetail,
  CodeGrantDetailSchema,
} from "../contracts/code-access";
import type { AccessEntry } from "../contracts/shared";
import { accessMessages } from "./messages";

/** A `code` service account's entry. Such entries never appear as ordinary share rows. */
export const isCodeAccessEntry = (entry: AccessEntry): entry is AccessEntry & { principal: { type: "service_account" } } =>
  entry.principal.type === "service_account" && entry.serviceAccountKind === "code";

class RemoveFailure extends Error {}
const accountId = (entry: AccessEntry) => (entry.principal.type === "service_account" ? entry.principal.serviceAccountId : "");
const isHexColor = (value: string | null) => value !== null && /^#[0-9a-f]{6}$/i.test(value);

/**
 * "Code with access" in the shared rights editor: every Code account with an explicit grant at this
 * resource, named after its owner as the person sees it right now. Code gets access only when someone
 * turns it on; here it can only be removed, through Core and the application's `code.access.rm`.
 */
export default function CodeAccessSection(props: {
  entries: AccessEntry[];
  canEdit: boolean;
  expanded?: boolean;
  /** The label of an entry's level, in the editor's own vocabulary. */
  levelLabel: (entry: AccessEntry) => string;
  /** The editor's label for managing the resource. */
  manageLabel: string;
  onRemoved: (entry: AccessEntry) => void;
}) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  // Owner presentation is read once per account and kept while the section lives; a new account loads on its own.
  const [accounts, setAccounts] = createStore<Record<string, CodeAccessAccount>>({});
  const [loadError, setLoadError] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [removing, setRemoving] = createSignal<string | null>(null);
  const [failures, setFailures] = createStore<Record<string, string | undefined>>({});
  const headingId = createUniqueId();
  // The share dialog belongs to the target application: the shell names it, and every Cloud layout marks its
  // canvas with it. Without either, the section stays read-only instead of offering a removal that cannot run.
  const [targetAppId, setTargetAppId] = createSignal<string>();
  // Loading starts once the target is known, so owners and grant details arrive in one pass.
  const [mounted, setMounted] = createSignal(false);
  onMount(() =>
    batch(() => {
      setTargetAppId(navigationApps().currentAppId ?? document.querySelector("[data-app-id]")?.getAttribute("data-app-id") ?? undefined);
      setMounted(true);
    }),
  );
  const canRemove = (entry: AccessEntry) => props.canEdit && Boolean(entry.grantId) && targetAppId() !== undefined;
  // A failed removal and its retry leave with editing, like the editor's own rows. A removal that fails after
  // editing stopped belongs to that ended session and never reappears when editing returns.
  let editingSession = 0;
  createEffect(
    on(
      () => props.canEdit,
      (editable) => {
        if (editable) return;
        editingSession += 1;
        for (const id of Object.keys(failures)) setFailures(id, undefined);
      },
    ),
  );
  let controller: AbortController | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    controller?.abort();
  });

  // Managers also see what each grant was switched on for and by whom. Core answers only for grants the target's own
  // code.access.list returns to this person, so a non-manager gets nothing and keeps the level line.
  const [details, setDetails] = createStore<Record<string, CodeGrantDetail | null>>({});
  const wantsDetails = () => props.canEdit && targetAppId() !== undefined;
  const missing = createMemo(() => [...new Set(props.entries.map(accountId))].filter((id) => id && !accounts[id]).sort());
  const missingDetails = createMemo(() =>
    wantsDetails()
      ? props.entries.flatMap((entry) =>
          entry.grantId && details[entry.grantId] === undefined ? [{ grantId: entry.grantId, principal: accountId(entry) }] : [],
        )
      : [],
  );
  const loadDetails = async (grants: { grantId: string; principal: string }[], appId: string, signal: AbortSignal) => {
    const found = new Map<string, CodeGrantDetail>();
    for (let start = 0; start < grants.length; start += CODE_ACCESS_ACCOUNTS_MAX) {
      const response = await fetch("/api/code/access/target", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, grants: grants.slice(start, start + CODE_ACCESS_ACCOUNTS_MAX) }),
        signal,
      });
      if (!response.ok) throw new Error(response.statusText);
      for (const item of z.object({ data: z.array(CodeGrantDetailSchema) }).parse(await response.json()).data)
        found.set(item.grantId, item);
    }
    return found;
  };
  const load = async (ids: string[], grants: { grantId: string; principal: string }[]) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setLoading(true);
    setLoadError(false);
    try {
      const found = new Map<string, CodeAccessAccount>();
      // Within the route's public bound per request; a long share list takes several.
      for (let start = 0; start < ids.length; start += CODE_ACCESS_ACCOUNTS_MAX) {
        const response = await fetch("/api/resources/code-access/accounts", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: ids.slice(start, start + CODE_ACCESS_ACCOUNTS_MAX) }),
          signal: current.signal,
        });
        if (!response.ok) throw new Error(response.statusText);
        for (const item of CodeAccessAccountsDataSchema.parse(await response.json()).items) found.set(item.id, item);
      }
      if (disposed || current.signal.aborted) return;
      // One write per answer, and everything requested settles, so nothing is requested twice, also after a retry.
      if (ids.length)
        setAccounts(
          Object.fromEntries(
            ids.map((id) => [id, found.get(id) ?? { id, ownerTitle: null, appId: null, icon: null, accent: null }] as const),
          ),
        );
      const appId = targetAppId();
      if (!grants.length || !appId) return;
      const grantDetails = await loadDetails(grants, appId, current.signal);
      if (disposed || current.signal.aborted) return;
      setDetails(Object.fromEntries(grants.map(({ grantId }) => [grantId, grantDetails.get(grantId) ?? null] as const)));
    } catch {
      if (!disposed && !current.signal.aborted) setLoadError(true);
    } finally {
      if (controller === current) setLoading(false);
    }
  };
  createEffect(() => {
    const ids = missing();
    const grants = missingDetails();
    // One load at a time; whatever is still missing when it ends starts the next one.
    if (mounted() && !loading() && (ids.length || grants.length) && !loadError()) void load(ids, grants);
  });
  const ready = () => missing().length === 0 && missingDetails().length === 0;
  const date = (iso: string) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(iso));
  const detailOf = (entry: AccessEntry) => (entry.grantId ? details[entry.grantId] : undefined) ?? undefined;
  // Heading and hint line up with the rows' content, which the expanded layout insets from the small breakpoint on.
  const inset = () => (props.expanded ? "sm:px-2" : "");

  const nameOf = (entry: AccessEntry) => {
    const title = accounts[accountId(entry)]?.ownerTitle;
    return title ? t().codeOf({ title }) : t().codeHiddenOwner;
  };

  const remove = async (entry: AccessEntry) => {
    const appId = targetAppId();
    if (!canRemove(entry) || !appId || removing() !== null) return;
    const name = nameOf(entry);
    const owner = accounts[accountId(entry)]?.ownerTitle;
    const confirmed = await prompts.confirm(
      <>
        <p>{t().codeRemoveBody}</p>
        <p class="mt-2">
          {owner ? t().codeRemoveRestore({ owner, level: props.manageLabel }) : t().codeRemoveRestoreHidden({ level: props.manageLabel })}
        </p>
      </>,
      { title: t().codeRemoveTitle({ name }), confirmText: t().removeAccess, variant: "danger" },
    );
    if (!confirmed || disposed || !canRemove(entry)) return;
    setRemoving(entry.id);
    setFailures(entry.id, undefined);
    const session = editingSession;
    try {
      const response = await fetch("/api/resources/code-access/remove", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, grantId: entry.grantId }),
      });
      if (response.status === 403) throw new RemoveFailure(t().codeRemoveForbidden);
      if (!response.ok) throw new RemoveFailure(t().codeRemoveFailed);
      const result = CodeAccessRemoveDataSchema.safeParse(await response.json().catch(() => null));
      if (!result.success) throw new RemoveFailure(t().codeRemoveFailed);
      if (!result.data.removed) throw new RemoveFailure(t().codeNotRemoved);
      if (disposed) return;
      announce(t().codeRemoved({ name }));
      props.onRemoved(entry);
    } catch (error) {
      // Only this section's own wording reaches the row; a network error reads like any other failure.
      if (!disposed && session === editingSession)
        setFailures(entry.id, error instanceof RemoveFailure ? error.message : t().codeRemoveFailed);
    } finally {
      if (!disposed) setRemoving(null);
    }
  };

  const tile = (entry: AccessEntry) => {
    const account = () => accounts[accountId(entry)];
    const accent = () => account()?.accent ?? null;
    return (
      <span
        aria-hidden="true"
        class={`inline-flex shrink-0 items-center justify-center rounded-lg ${props.expanded ? "size-8 text-lg" : "size-7 text-base"} ${
          isHexColor(accent())
            ? "bg-[color-mix(in_srgb,var(--code-owner-accent)_12%,var(--k2b-surface))] text-[var(--code-owner-accent)]"
            : "bg-[var(--ui-surface-muted)] text-secondary"
        }`}
        style={isHexColor(accent()) ? { "--code-owner-accent": accent()! } : undefined}
      >
        <i class={account()?.icon ?? "ti ti-code"} />
      </span>
    );
  };

  return (
    <Show when={props.entries.length > 0}>
      <section class="flex flex-col" aria-labelledby={headingId} aria-busy={!ready() && !loadError() ? "true" : undefined}>
        <h3 id={headingId} class={`mb-1 flex items-center gap-1.5 text-xs font-semibold text-secondary ${inset()}`}>
          {t().codeWithAccess}
          <Show when={ready()}>
            <span class="font-normal text-dimmed">{props.entries.length}</span>
          </Show>
        </h3>
        <Show
          when={!loadError() || ready()}
          fallback={
            <NoticeCard tone="danger" icon="ti ti-cloud-off" role="alert" class="mt-1">
              <span>{t().codeLoadFailed}</span>
              <div class="mt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={loading()}
                  onClick={() => {
                    setLoadError(false);
                  }}
                >
                  <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                </Button>
              </div>
            </NoticeCard>
          }
        >
          <For each={props.entries}>
            {(entry) => (
              <div>
                <div
                  class={`flex items-center gap-3 rounded-[var(--ui-radius-control)] ${props.expanded ? "min-h-[52px] py-2 sm:px-2" : "min-h-11 py-1.5"}`}
                  aria-busy={removing() === entry.id ? "true" : undefined}
                  data-code-access-row=""
                >
                  <Show
                    when={ready()}
                    fallback={
                      <>
                        <Skeleton class={`shrink-0 rounded-lg ${props.expanded ? "size-8" : "size-7"}`} />
                        {/* The same line boxes as the loaded name and level, so nothing moves when they arrive. */}
                        <span class="min-w-0 flex-1">
                          <span class={`block ${props.expanded ? "text-[15px]" : "text-sm"}`}>
                            <Skeleton class="inline-block h-3.5 w-1/2 rounded align-middle" />
                          </span>
                          <span class={`block ${props.expanded ? "text-[13px]" : "text-xs"}`}>
                            <Skeleton class="inline-block h-3 w-1/4 rounded align-middle" />
                          </span>
                          <Show when={wantsDetails() && entry.grantId}>
                            <span class={`block ${props.expanded ? "text-[13px]" : "text-xs"}`}>
                              <Skeleton class="inline-block h-3 w-1/3 rounded align-middle" />
                            </span>
                          </Show>
                        </span>
                      </>
                    }
                  >
                    {tile(entry)}
                    <span class="min-w-0 flex-1">
                      <span class={`block truncate font-medium ${props.expanded ? "text-[15px]" : "text-sm"}`}>{nameOf(entry)}</span>
                      <Show
                        when={detailOf(entry)}
                        fallback={
                          <span class={`block truncate text-dimmed ${props.expanded ? "text-[13px]" : "text-xs"}`}>
                            {props.levelLabel(entry)}
                          </span>
                        }
                      >
                        {(detail) => (
                          <>
                            {/* Operation at this target, as the checker read it from the Code. */}
                            {/* These lines wrap on narrow screens instead of hiding who switched it on. */}
                            <span class={`block break-words text-dimmed ${props.expanded ? "text-[13px]" : "text-xs"}`}>
                              <code class="font-mono text-[0.95em] font-medium text-secondary">{detail().operations.join(", ")}</code>
                            </span>
                            <Show when={detail().activatedAt}>
                              {(at) => (
                                <span class={`block break-words text-dimmed ${props.expanded ? "text-[13px]" : "text-xs"}`}>
                                  {detail().activatedBy
                                    ? t().codeActivatedBy({ name: detail().activatedBy!.name, date: date(at()) })
                                    : t().codeActivatedOn({ date: date(at()) })}
                                </span>
                              )}
                            </Show>
                          </>
                        )}
                      </Show>
                    </span>
                  </Show>
                  <Show when={canRemove(entry)}>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="shrink-0"
                      disabled={!ready() || (removing() !== null && removing() !== entry.id)}
                      loading={removing() === entry.id}
                      aria-label={t().codeRemoveLabel({ name: nameOf(entry) })}
                      onClick={() => void remove(entry)}
                    >
                      {t().codeRemove}
                    </Button>
                  </Show>
                </div>
                <Show when={props.canEdit && failures[entry.id]}>
                  {(message) => (
                    <div role="alert" class={`text-[13px] text-danger ${props.expanded ? "pl-11 sm:pl-13" : "pl-10"}`}>
                      {message()}{" "}
                      <Button variant="text" disabled={removing() !== null} onClick={() => void remove(entry)}>
                        {t().retry}
                      </Button>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </For>
          {/* Static copy, so it already holds its place while the rows load. */}
          <p class={`mt-1 text-[13px] text-dimmed ${inset()}`}>{t().codeHint}</p>
          <Show when={!ready()}>
            <span class="sr-only" role="status">
              {t().codeLoading}
            </span>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
