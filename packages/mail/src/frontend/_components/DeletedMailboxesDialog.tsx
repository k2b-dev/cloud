import { query as queries } from "@k2b/stdlib/solid";
import { Button, dialogCore, PanelDialog, Placeholder, panelDialogOptions, SettingsCollection, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { DeletedMailbox, DeletedMailboxPage } from "../../contracts";
import { mailOverviewMessages } from "../mail-overview-messages";
import { assertCursorProgress } from "../pagination";
import { readApiError } from "./api-response";

/** The deleted mailboxes the person administers, each with its way back. */
function DeletedMailboxesDialog(props: { close: (mailboxId?: string) => void }) {
  const locale = useLocale();
  const text = createMemo(() => mailOverviewMessages.resolve([locale()]).t);
  const date = createMemo(() => new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }));
  const results = queries.createInfinite<string, DeletedMailboxPage, string>({
    source: () => "deleted-mailboxes",
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.mailboxes.deleted.$get({ query: { limit: "100", cursor } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, text().failedLoadDeletedMailboxes));
      const page = await response.json();
      assertCursorProgress(cursor, page.nextCursor, "deleted-mailbox");
      return page;
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const mailboxes = createMemo(() => {
    const merged = new Map<string, DeletedMailbox>();
    for (const page of results.pages()) for (const mailbox of page.items) merged.set(mailbox.id, mailbox);
    return [...merged.values()];
  });
  return (
    <PanelDialog>
      <PanelDialog.Header title={text().deletedMailboxes} icon="ti ti-trash" close={() => props.close()} />
      <PanelDialog.Body>
        <Show
          when={!results.error() && !(results.loading() && mailboxes().length === 0)}
          fallback={
            <Show when={results.error()} fallback={<Placeholder state="loading" variant="panel" title={text().loadingDeletedMailboxes} />}>
              {(error) => (
                <Placeholder
                  state="error"
                  variant="panel"
                  title={text().failedLoadDeletedMailboxes}
                  description={error().message}
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => void results.refresh()}>
                      {text().retry}
                    </Button>
                  }
                />
              )}
            </Show>
          }
        >
          <SettingsCollection
            title={text().deletedMailboxesKept}
            description={text().deletedMailboxesDescription}
            empty={text().noDeletedMailboxes}
          >
            <For each={mailboxes()}>
              {(mailbox) => (
                <SettingsCollection.Item
                  title={mailbox.name}
                  description={text().deletedOn({ date: date().format(new Date(mailbox.deletedAt)) })}
                  icon={<i class="ti ti-mail" aria-hidden="true" />}
                >
                  <SettingsCollection.Item.Actions>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      aria-label={text().restoreNamedMailbox({ name: mailbox.name })}
                      onClick={() => props.close(mailbox.id)}
                    >
                      <i class="ti ti-arrow-back-up" aria-hidden="true" /> {text().restore}
                    </Button>
                  </SettingsCollection.Item.Actions>
                </SettingsCollection.Item>
              )}
            </For>
          </SettingsCollection>
          <Show when={results.hasMore()}>
            <Button variant="secondary" size="sm" type="button" loading={results.loadingMore()} onClick={() => void results.loadMore()}>
              {text().loadMore}
            </Button>
          </Show>
        </Show>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

/** Resolves with the mailbox the person chose to restore, or nothing when they closed the dialog. */
export const openDeletedMailboxesDialog = (): Promise<string | undefined> =>
  dialogCore.open<string>((close) => <DeletedMailboxesDialog close={close} />, panelDialogOptions);
