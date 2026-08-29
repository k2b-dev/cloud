import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, dialogCore, PanelDialog, Placeholder, panelDialogOptions, prompts, toast, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact, ContactDuplicateMatch } from "../../service";
import { resolveContactName } from "../../shared";
import { readErrorMessage } from "./api";
import { detailMessages } from "./detail-messages";

function DuplicateReviewDialog(props: { bookId: string; close: (changed: boolean) => void }) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const contactSummary = (contact: Contact) =>
    [contact.companyName, contact.emails[0]?.email, contact.phones[0]?.phone].filter(Boolean).join(" · ") || t().noAdditionalContactDetails;
  const reasonLabel = (reason: ContactDuplicateMatch["reasons"][number]): string => {
    if (reason === "email") return t().reasonSameEmail;
    if (reason === "phone") return t().reasonSamePhone;
    return t().reasonSameName;
  };
  const [changed, setChanged] = createSignal(false);
  const [reconcileError, setReconcileError] = createSignal<string | null>(null);
  const [reconciling, setReconciling] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  let disposed = false;

  const matches = query.create<string, ContactDuplicateMatch[]>({
    source: () => props.bookId,
    load: async (bookId, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].contacts.duplicates.$get({ param: { bookId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readErrorMessage(response, t().inspectDuplicatesFailed));
      return await response.json();
    },
  });
  const reconcile = async () => {
    if (disposed) return;
    setReconciling(true);
    setReconcileError(null);
    try {
      await matches.invalidate();
      if (!disposed) setReconciling(false);
    } catch {
      if (disposed) return;
      setReconciling(false);
      setReconcileError(t().mergedReloadFailed);
    }
  };

  const mergeMutation = mutations.create<
    Contact,
    { bookId: string; keepId: string; removeId: string; keepUpdatedAt: string; removeUpdatedAt: string }
  >({
    mutation: async (selection, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].contacts.duplicates.merge.$post(
        {
          param: { bookId: selection.bookId },
          json: {
            keepId: selection.keepId,
            removeId: selection.removeId,
            keepUpdatedAt: selection.keepUpdatedAt,
            removeUpdatedAt: selection.removeUpdatedAt,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().mergeContactsFailed));
      return await response.json();
    },
    onSuccess: () => {
      setChanged(true);
      toast.success(t().contactsMerged);
      void reconcile();
    },
    onError: (error) => void prompts.error(error.message),
  });
  onCleanup(() => {
    disposed = true;
    mergeMutation.abort();
  });
  const coverageBlocked = () => reconciling() || reconcileError() !== null;

  const keep = async (contact: Contact, duplicate: Contact) => {
    if (disposed || confirming() || mergeMutation.loading() || coverageBlocked()) return;
    setConfirming(true);
    try {
      const confirmed = await prompts.confirm(
        t().mergeConfirm({ keep: resolveContactName(contact), remove: resolveContactName(duplicate) }),
        { title: t().mergeContactsTitle, icon: "ti ti-users-minus", confirmText: t().merge },
      );
      if (!confirmed || disposed) return;
      void mergeMutation.mutate({
        bookId: props.bookId,
        keepId: contact.id,
        removeId: duplicate.id,
        keepUpdatedAt: contact.updatedAt,
        removeUpdatedAt: duplicate.updatedAt,
      });
    } finally {
      if (!disposed) setConfirming(false);
    }
  };
  const close = () => {
    if (!coverageBlocked()) props.close(changed());
  };

  return (
    <PanelDialog>
      <PanelDialog.Header title={t().reviewDuplicates} subtitle={t().reviewDuplicatesSubtitle} icon="ti ti-users-group" close={close} />
      <PanelDialog.Body>
        <Show when={!matches.loading()} fallback={<Placeholder icon="ti ti-loader-2" title={t().checkingContacts} variant="panel" />}>
          <Show
            when={!matches.error() || matches.data() !== undefined}
            fallback={
              <div class="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
                <Placeholder
                  icon="ti ti-alert-circle"
                  title={t().couldNotCheckDuplicates}
                  description={t().duplicatesErrorRecovery}
                  variant="panel"
                />
                <Button variant="secondary" size="sm" onClick={() => void matches.refresh()}>
                  <i class="ti ti-refresh" /> {t().retry}
                </Button>
              </div>
            }
          >
            <Show
              when={(matches.data() ?? []).length > 0}
              fallback={
                <Placeholder
                  icon="ti ti-user-check"
                  title={t().noDuplicatesFound}
                  description={t().noDuplicatesDescription}
                  variant="panel"
                />
              }
            >
              <div class="flex flex-col gap-2">
                <For each={matches.data() ?? []}>
                  {(match) => (
                    <section class="paper p-3">
                      <p class="mb-2 text-xs text-dimmed">{match.reasons.map(reasonLabel).join(" · ")}</p>
                      <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
                        <For each={[match.first, match.second]}>
                          {(contact, index) => {
                            const other = () => (index() === 0 ? match.second : match.first);
                            return (
                              <div class="min-w-0 p-1">
                                <p class="truncate text-sm font-medium text-primary">{resolveContactName(contact)}</p>
                                <p class="mt-0.5 truncate text-xs text-dimmed">{contactSummary(contact)}</p>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  class="mt-3 w-full"
                                  disabled={mergeMutation.loading() || confirming() || coverageBlocked()}
                                  onClick={() => void keep(contact, other())}
                                >
                                  {t().keepThisRecord}
                                </Button>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </section>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
        <Show when={reconciling()}>
          <p class="text-xs text-dimmed" role="status">
            {t().reloadingMatches}
          </p>
        </Show>
        <Show when={reconcileError()}>
          <div class="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-300" role="status">
            <span>{reconcileError()}</span>
            <Button type="button" variant="secondary" size="xs" onClick={() => void reconcile()} disabled={reconciling()}>
              {t().retryReload}
            </Button>
          </div>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span class="text-xs text-dimmed">{t().matchCount({ count: (matches.data() ?? []).length })}</span>
        <Button variant="secondary" size="sm" onClick={close} disabled={coverageBlocked()}>
          {t().done}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openContactDuplicatesDialog = (bookId: string) =>
  dialogCore.open<boolean>((close) => <DuplicateReviewDialog bookId={bookId} close={close} />, {
    ...panelDialogOptions,
    cancelBehavior: "ignore",
  });
