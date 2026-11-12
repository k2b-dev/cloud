import { openCommand, registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { query } from "@k2b/stdlib/solid";
import { prompts, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import { mailCommandMessages } from "../../command-messages";
import type { MailConversationContext } from "../../contracts";
import { readApiError } from "./api-response";
import { mailRemainingMessages } from "./mail-remaining-messages";

/** One linked item as the head's chip lists it: its title, icon and the link that opens it. */
export type MailLinkedItem = { id: string; title: string; icon: string; href: string; detail?: string };

/**
 * The items other apps linked to the open conversation, and the commands that link, create, or unlink one. The head
 * shows them as one chip; "…" → Link and the command palette offer the commands to people who may change the
 * conversation.
 */
export function createMailConversationLinks(props: {
  mailboxId: () => string;
  conversationId: () => string | null;
  requestUrl: () => string;
  subject: () => string;
  /** Only people with mailbox-wide access see what the conversation is linked with. */
  enabled: () => boolean;
  canWrite: () => boolean;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  let mounted = true;
  onCleanup(() => {
    mounted = false;
  });
  const context = query.create<readonly [string, string], MailConversationContext>({
    source: () => [props.mailboxId(), props.conversationId() ?? ""] as const,
    enabled: () => Boolean(props.conversationId()) && props.enabled(),
    load: async ([mailboxId, conversationId], { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].context.$get(
        // The head needs only the linked items; one contact keeps the contact lookup small.
        { param: { mailboxId, conversationId }, query: { contactsLimit: "1" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().spacesUnavailable));
      return response.json();
    },
  });
  const current = () => {
    const page = context.data();
    return page && page.conversationId === props.conversationId() ? page : null;
  };
  const items = createMemo<MailLinkedItem[]>(() => {
    const page = current();
    if (page?.spaces.status !== "ready") return [];
    return page.spaces.items.flatMap((item) => {
      const href = item.links.find((link) => link.rel === "open")?.href;
      return href
        ? [{ id: item.ref.id, title: item.title, icon: item.icon ?? "ti ti-checkbox", href, detail: item.metadata?.[0]?.value }]
        : [];
    });
  });
  const state = (): "loading" | "error" | "ready" => {
    if (!props.enabled()) return "ready";
    const page = current();
    if (!page) return context.error() ? "error" : "loading";
    return page.spaces.status === "ready" ? "ready" : "error";
  };
  const truncated = () => current()?.spaces.status === "ready" && current()!.spaces.truncated;
  const refresh = async () => {
    try {
      await context.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().linkedSpacesRefreshFailed);
    }
  };
  const commandOptions = () => {
    const source = new URL(props.requestUrl(), "https://mail.invalid");
    return { returnTo: `${source.pathname}${source.search}${source.hash}` };
  };
  const create = async (kind: "task" | "event") => {
    const conversationId = props.conversationId();
    if (!conversationId) return;
    try {
      await openCommand(`spaces.${kind}.compose`, { source: { type: "mail.conversation", id: conversationId } }, commandOptions());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().couldNotLoadSpaces);
    }
  };
  const linkExisting = async () => {
    const mailboxId = props.mailboxId();
    const conversationId = props.conversationId();
    if (!conversationId) return;
    const linked = new Set(items().map((item) => item.id));
    const selected = await prompts.search<{ id: string }>(
      async ({ query: text, abortSignal }) => {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].spaces.items.$get(
          { param: { mailboxId, conversationId }, query: { query: text } },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, t().couldNotSearchSpaces));
        return (await response.json())
          .filter((item) => !linked.has(item.ref.id))
          .map((item) => ({
            id: item.ref.id,
            value: { id: item.ref.id },
            label: item.title,
            desc: item.metadata?.[0]?.value,
            icon: item.icon ?? "ti ti-checkbox",
          }));
      },
      {
        title: t().linkSpaceItem,
        icon: "ti ti-link",
        placeholder: t().searchTasksAndEvents,
        minQueryLength: 0,
        noResultsText: t().noWritableSpaceItems,
        size: "small",
      },
    );
    if (!selected?.value || !mounted || props.mailboxId() !== mailboxId || props.conversationId() !== conversationId) return;
    const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].spaces.link.$post({
      param: { mailboxId, conversationId },
      json: { itemId: selected.value.id },
    });
    if (!response.ok) return void toast.error(await readApiError(response, t().couldNotLinkSpaceItem));
    await refresh();
  };
  const unlink = async (itemId: string) => {
    const mailboxId = props.mailboxId();
    const conversationId = props.conversationId();
    if (!conversationId) return;
    const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].spaces.unlink.$post({
      param: { mailboxId, conversationId },
      json: { itemId },
    });
    if (!response.ok) return void toast.error(await readApiError(response, t().couldNotUnlinkSpaceItem));
    await refresh();
  };
  const canLink = () => props.enabled() && props.canWrite() && state() === "ready";

  createEffect(() => {
    // Readers get no commands that link or create items, here or in the command palette.
    const id = props.conversationId();
    if (!id || !canLink()) return;
    const copy = mailCommandMessages.resolve([locale()]).t;
    onCleanup(
      registerContextAwareCommand({
        id: `mail.${id}.spaces.link`,
        scope: "selection",
        title: copy.linkSpaceTitle,
        description: copy.linkSpaceDescription,
        icon: "ti ti-link",
        action: linkExisting,
      }),
    );
    for (const kind of ["task", "event"] as const)
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `mail.${id}.${kind}`,
          title: kind === "task" ? copy.sourceTask : copy.sourceEvent,
          description: props.subject() ? copy.sourceDescriptionFor({ subject: props.subject() }) : copy.sourceDescription,
          icon: kind === "task" ? "ti ti-checkbox" : "ti ti-calendar-event",
          action: { command: `spaces.${kind}.compose`, input: { source: { type: "mail.conversation", id } }, options: commandOptions() },
        }),
      );
  });

  return { items, state, truncated, retry: refresh, canLink, create, linkExisting, unlink };
}
