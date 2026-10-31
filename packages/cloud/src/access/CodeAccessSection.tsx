import { announce, Button, NoticeCard, prompts, Skeleton, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { navigationApps } from "../browser/navigation-apps";
import { type CodeAccessAccount, CodeAccessAccountsDataSchema, CodeAccessRemoveDataSchema } from "../contracts/code-access";
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
  let controller: AbortController | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    controller?.abort();
  });

  const missing = createMemo(() => [...new Set(props.entries.map(accountId))].filter((id) => id && !accounts[id]).sort());
  const load = async (ids: string[]) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/resources/code-access/accounts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
        signal: current.signal,
      });
      if (!response.ok) throw new Error(response.statusText);
      const data = CodeAccessAccountsDataSchema.parse(await response.json());
      if (disposed || current.signal.aborted) return;
      // One write for the whole answer, and every requested account settles, so nothing is requested twice.
      const found = new Map(data.items.map((item) => [item.id, item]));
      setAccounts(
        Object.fromEntries(
          ids.map((id) => [id, found.get(id) ?? { id, ownerTitle: null, appId: null, icon: null, accent: null }] as const),
        ),
      );
    } catch {
      if (!disposed && !current.signal.aborted) setLoadError(true);
    } finally {
      if (controller === current) setLoading(false);
    }
  };
  createEffect(() => {
    const ids = missing();
    if (ids.length && !loadError()) void load(ids);
  });
  const ready = () => missing().length === 0;
  // Heading and hint line up with the rows' content, which the expanded layout insets from the small breakpoint on.
  const inset = () => (props.expanded ? "sm:px-2" : "");

  const nameOf = (entry: AccessEntry) => {
    const title = accounts[accountId(entry)]?.ownerTitle;
    return title ? t().codeOf({ title }) : t().codeHiddenOwner;
  };

  const remove = async (entry: AccessEntry) => {
    const appId = navigationApps().currentAppId;
    if (!entry.grantId || !appId || removing() !== null || !props.canEdit) return;
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
    if (!confirmed || disposed || !props.canEdit) return;
    setRemoving(entry.id);
    setFailures(entry.id, undefined);
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
      if (!disposed) setFailures(entry.id, error instanceof RemoveFailure ? error.message : t().codeRemoveFailed);
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
                        </span>
                      </>
                    }
                  >
                    {tile(entry)}
                    <span class="min-w-0 flex-1">
                      <span class={`block truncate font-medium ${props.expanded ? "text-[15px]" : "text-sm"}`}>{nameOf(entry)}</span>
                      <span class={`block truncate text-dimmed ${props.expanded ? "text-[13px]" : "text-xs"}`}>
                        {props.levelLabel(entry)}
                      </span>
                    </span>
                  </Show>
                  <Show when={props.canEdit && entry.grantId}>
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
                <Show when={failures[entry.id]}>
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
