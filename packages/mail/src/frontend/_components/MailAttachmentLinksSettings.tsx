import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, Placeholder, prompts, StatusBadge, toast, useLocale } from "@k2b/ui";
import { createMemo, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { AttachmentLink, AttachmentLinkPage } from "../../contracts";
import { assertCursorProgress } from "../pagination";
import { readApiError } from "./api-response";
import { mailSettingsMessages } from "./mail-settings-messages";

const linkStatus = (link: AttachmentLink): "active" | "expired" | "exhausted" | "revoked" => {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) return "expired";
  if (link.maxDownloads !== null && link.downloadCount >= link.maxDownloads) return "exhausted";
  return "active";
};

export default function MailAttachmentLinksSettings(props: { mailboxId: string; dateConfig: DateContext }) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const linkStatusLabel = (status: ReturnType<typeof linkStatus>) => {
    if (status === "active") return messages().linkStatusActive;
    if (status === "expired") return messages().linkStatusExpired;
    if (status === "exhausted") return messages().linkStatusExhausted;
    return messages().linkStatusRevoked;
  };
  const linkPages = query.createInfinite<string, AttachmentLinkPage, string>({
    source: () => props.mailboxId,
    loadPage: async (mailboxId, { cursor, abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["attachment-links"].$get(
        {
          param: { mailboxId },
          query: { limit: "50", cursor },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadAttachmentLinks));
      const page = await response.json();
      assertCursorProgress(cursor, page.nextCursor, "attachment links");
      return page;
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const links = createMemo(() => {
    const merged = new Map<string, AttachmentLink>();
    for (const page of linkPages.pages()) for (const link of page.items) merged.set(link.id, link);
    return [...merged.values()];
  });

  const revoke = mutations.create<string, AttachmentLink>({
    mutation: async (link, context) => {
      const confirmed = await prompts.confirm(
        messages().revokeLinkDescription({ filename: link.filename ?? messages().attachmentFallback }),
        { title: messages().revokePublicLink, confirmText: messages().revokeLink, variant: "danger" },
      );
      if (!confirmed) return "";
      const response = await apiClient.mailboxes[":mailboxId"]["attachment-links"][":linkId"].$delete(
        { param: { mailboxId: props.mailboxId, linkId: link.id } },
        { init: { signal: context.abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedRevokeAttachmentLink));
      return link.id;
    },
    onSuccess: (linkId) => {
      if (!linkId) return;
      toast.success(messages().publicLinkRevoked);
      void linkPages.invalidate().catch((error) =>
        prompts.error(error instanceof Error ? error.message : messages().sharedLinksRefreshFailed, {
          title: messages().linkRevokedRefreshFailed,
        }),
      );
    },
    onError: (error) => prompts.error(error.message),
  });

  onCleanup(() => {
    revoke.abort();
  });

  return (
    <section class="flex flex-col gap-2">
      <p class="text-xs text-dimmed">{messages().attachmentLinksDescription}</p>
      <Show when={!linkPages.loading()} fallback={<Placeholder state="loading" title={messages().loadingSharedLinks} />}>
        <Show
          when={!linkPages.error()}
          fallback={
            <Placeholder
              variant="panel"
              icon="ti ti-alert-triangle"
              title={messages().couldNotLoadSharedLinks}
              description={linkPages.error()?.message}
              action={
                <Button variant="secondary" size="sm" type="button" onClick={() => void linkPages.refresh()}>
                  {messages().retry}
                </Button>
              }
            />
          }
        >
          <Show
            when={links().length > 0}
            fallback={
              <Placeholder
                variant="panel"
                icon="ti ti-link-off"
                title={messages().noSharedLinks}
                description={messages().noSharedLinksDescription}
              />
            }
          >
            <div class="flex flex-col gap-2">
              <For each={links()}>
                {(link) => {
                  const status = () => linkStatus(link);
                  return (
                    <div class="paper flex min-w-0 items-center gap-3 p-3">
                      <i class="ti ti-file-symlink shrink-0 text-dimmed" aria-hidden="true" />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium text-primary">{link.filename ?? link.contentType}</span>
                        <span class="block text-xs text-dimmed">
                          {messages().downloadCount({ count: link.downloadCount })}
                          {link.maxDownloads === null ? "" : ` ${messages().downloadLimit({ count: link.maxDownloads })}`}
                          {link.expiresAt
                            ? ` · ${messages().expiresAt({ date: dates.formatDateTime(link.expiresAt, props.dateConfig) })}`
                            : ` · ${messages().noExpiry}`}
                          {link.passwordProtected ? ` · ${messages().passwordProtected}` : ""}
                        </span>
                      </span>
                      <StatusBadge tone={status() === "active" ? "ok" : "neutral"} label={linkStatusLabel(status())} />
                      <Show when={status() === "active"}>
                        <Button variant="ghost" size="sm" type="button" disabled={revoke.loading()} onClick={() => revoke.mutate(link)}>
                          <i class="ti ti-link-off" aria-hidden="true" /> {messages().revoke}
                        </Button>
                      </Show>
                    </div>
                  );
                }}
              </For>
              <Show when={linkPages.hasMore()}>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  class="self-start"
                  disabled={linkPages.loadingMore()}
                  onClick={() => void linkPages.loadMore()}
                >
                  {linkPages.loadingMore() ? messages().loading : messages().loadMore}
                </Button>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
