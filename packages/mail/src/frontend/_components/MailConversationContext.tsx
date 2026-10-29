import { openCommand, registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { mutation, query } from "@k2b/stdlib/solid";
import { Button, DetailPanel, Placeholder, prompts, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { apiClient } from "../../api/client";
import { mailCommandMessages } from "../../command-messages";
import { canCreateDirectoryContacts } from "../../contact-directory";
import type { MailConversationContext } from "../../contracts";
import { assertCursorProgress } from "../pagination";
import { readApiError } from "./api-response";
import { buildMailContactParticipantRows } from "./mail-contact-context";
import { useMailContactDirectory } from "./mail-contact-directory-context";
import { createRetryToasts } from "./mail-feedback";
import { buildExactParticipantSearchHref } from "./mail-navigation";
import { mailRemainingMessages } from "./mail-remaining-messages";

/** The two places of the conversation's context in the details panel, from one request. */
export type MailContextParts = {
  people: JSX.Element;
  showPeople: () => boolean;
  peopleNames: () => string[];
  spaces: JSX.Element;
  /** The command that creates a Spaces task, with more ways to link in its menu; empty for readers. */
  spacesAdd: JSX.Element;
  spacesCount: () => number | undefined;
  spacesState: () => "loading" | "error" | "ready";
};

export default function MailConversationContext(props: {
  mailboxId: string;
  conversationId: string;
  requestUrl: string;
  active: boolean;
  subject?: string;
  /** False hides the commands that link or create Spaces items. */
  canWrite?: boolean;
  createTaskLabel?: string;
  moreLinkLabel?: string;
  unavailableText?: string;
  /** Places people and Spaces items separately; without it, both render one after the other. */
  children?: (parts: MailContextParts) => JSX.Element;
}) {
  let mounted = true;
  onCleanup(() => {
    mounted = false;
  });
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const retryToast = createRetryToasts();
  const contactDirectory = useMailContactDirectory();
  const canCreateContact = canCreateDirectoryContacts(contactDirectory);
  const contexts = query.createInfinite<string, MailConversationContext, string>({
    source: () => props.conversationId,
    enabled: () => props.active,
    loadPage: async (conversationId, { cursor, abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].context.$get(
        {
          param: { mailboxId: props.mailboxId, conversationId },
          query: { contactsLimit: "50", contactsCursor: cursor },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().contactsUnavailable));
      const page = await response.json();
      if (page.contacts.status === "ready") assertCursorProgress(cursor, page.contacts.nextCursor, messages().contacts);
      return page;
    },
    getNextCursor: (page) => (page.contacts.status === "ready" ? page.contacts.nextCursor : null),
  });
  const context = createMemo(() => {
    const [first, ...rest] = contexts.pages();
    if (!first || first.conversationId !== props.conversationId) return null;
    if (first.contacts.status !== "ready") return first;
    const contacts = new Map(first.contacts.items.map((contact) => [`${contact.bookId}:${contact.contactId}`, contact]));
    const matchedEmails = new Set(first.contacts.matchedEmails);
    let nextCursor = first.contacts.nextCursor;
    for (const page of rest) {
      if (page.conversationId !== props.conversationId) continue;
      if (page.contacts.status !== "ready") continue;
      for (const contact of page.contacts.items) contacts.set(`${contact.bookId}:${contact.contactId}`, contact);
      for (const email of page.contacts.matchedEmails) matchedEmails.add(email);
      nextCursor = page.contacts.nextCursor;
    }
    return { ...first, contacts: { ...first.contacts, items: [...contacts.values()], matchedEmails: [...matchedEmails], nextCursor } };
  });

  // The page's directory decides the first frame; once loaded, the current answer wins, so a provider installed since
  // the page loaded shows its contacts and one removed since hides them.
  const showContacts = createMemo(() => {
    const current = context();
    return current ? current.contacts.status !== "absent" : contactDirectory.resolve !== null;
  });

  const participantRows = createMemo(() => {
    const current = context();
    if (!current || current.contacts.status !== "ready") return [];
    return buildMailContactParticipantRows({
      participants: current.participants,
      contacts: current.contacts.items,
      matchedEmails: current.contacts.matchedEmails,
    });
  });

  // The idempotency key belongs to the intent, so Retry repeats the same creation instead of adding a second contact.
  type ParticipantContactIntent = {
    participant: { email: string; displayName: string | null };
    book: { id: string; name: string };
    conversationId: string;
    idempotencyKey: string;
  };
  const createParticipantContact = mutation.create<void, ParticipantContactIntent, { intent: ParticipantContactIntent }>({
    onBefore: (intent) => ({ intent }),
    mutation: async ({ participant, book, conversationId, idempotencyKey }, { abortSignal }) => {
      const capabilities = await importOnDemand(() => import("./contact-capabilities"));
      if (!capabilities) throw new DOMException("Contact code unavailable", "AbortError");
      if (abortSignal.aborted) return;
      await capabilities.createContact(
        contactDirectory.create,
        {
          bookId: book.id,
          label: participant.displayName || participant.email,
          emails: [{ label: messages().email, email: participant.email }],
        },
        idempotencyKey,
        abortSignal,
      );
      if (conversationId === props.conversationId)
        await refreshContext(messages().contactCreatedRefreshFailed, messages().contactsRefreshFailed);
    },
    onError: (error, context) =>
      retryToast(error.message, {
        title: messages().couldNotCreateContact,
        retryLabel: messages().retry,
        retry: () => context && createParticipantContact.mutate(context.intent),
      }),
  });
  /** The change was saved, only this context is stale, so Retry repeats the refresh, not the change. */
  const refreshContext = async (title: string, fallback: string): Promise<void> => {
    try {
      await contexts.invalidate();
    } catch (error) {
      retryToast(error instanceof Error ? error.message : fallback, {
        title,
        retryLabel: messages().retry,
        retry: () => refreshContext(title, fallback),
      });
    }
  };

  const [contactOpening, setContactOpening] = createSignal(false);
  const chooseBookAndCreate = async (participant: { email: string; displayName: string | null }) => {
    if (contactOpening() || createParticipantContact.loading()) return;
    setContactOpening(true);
    try {
      const capabilities = await importOnDemand(() => import("./contact-capabilities"));
      if (!capabilities || !mounted) return;
      const selected = await prompts.search<{ id: string; name: string }>(
        async ({ query, abortSignal }) => {
          const result = await capabilities.listWritableContactBooks(
            contactDirectory.listWritableBooks,
            { query: query.trim() || undefined, limit: 25 },
            abortSignal,
          );
          return result.data.map((book) => ({
            value: { id: book.id, name: book.name },
            label: book.name,
            desc: book.description ?? undefined,
            icon: "ti ti-address-book",
          }));
        },
        {
          title: messages().chooseContactBook,
          icon: "ti ti-address-book",
          placeholder: messages().searchWritableContactBooks,
          minQueryLength: 0,
          noResultsText: messages().noWritableContactBooks,
          size: "small",
        },
      );
      if (!selected?.value || !mounted) return;
      await createParticipantContact.mutate({
        participant,
        book: selected.value,
        conversationId: props.conversationId,
        idempotencyKey: crypto.randomUUID(),
      });
    } finally {
      if (mounted) setContactOpening(false);
    }
  };

  const reconcileSpacesAfterWrite = async (mailboxId: string, conversationId: string, title: string) => {
    if (mailboxId !== props.mailboxId || conversationId !== props.conversationId) return;
    await refreshContext(title, messages().linkedSpacesRefreshFailed);
  };

  const linkExistingSpaceItem = async () => {
    const mailboxId = props.mailboxId;
    const conversationId = props.conversationId;
    const current = context();
    const linkedItemIds = new Set(current?.spaces.status === "ready" ? current.spaces.items.map((item) => item.ref.id) : []);
    const selected = await prompts.search<{ id: string; title: string }>(
      async ({ query, abortSignal }) => {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].spaces.items.$get(
          {
            param: { mailboxId, conversationId },
            query: { query },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, messages().couldNotSearchSpaces));
        return (await response.json())
          .filter((item) => !linkedItemIds.has(item.ref.id))
          .map((item) => ({
            value: { id: item.ref.id, title: item.title },
            label: item.title,
            desc: item.metadata?.find((entry) => entry.label === "Space")?.value,
            icon: item.icon ?? "ti ti-checkbox",
          }));
      },
      {
        title: messages().linkSpaceItem,
        icon: "ti ti-link",
        placeholder: messages().searchTasksAndEvents,
        minQueryLength: 0,
        noResultsText: messages().noWritableSpaceItems,
        size: "small",
      },
    );
    if (!selected?.value || !mounted || !props.active || props.mailboxId !== mailboxId || props.conversationId !== conversationId) return;
    const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].spaces.link.$post({
      param: { mailboxId, conversationId },
      json: { itemId: selected.value.id },
    });
    if (!response.ok) return void toast.error(await readApiError(response, messages().couldNotLinkSpaceItem));
    await reconcileSpacesAfterWrite(mailboxId, conversationId, messages().spaceItemLinkedRefreshFailed);
  };

  const unlinkSpaceItem = async (itemId: string) => {
    const mailboxId = props.mailboxId;
    const conversationId = props.conversationId;
    const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].spaces.unlink.$post({
      param: { mailboxId, conversationId },
      json: { itemId },
    });
    if (!response.ok) return void toast.error(await readApiError(response, messages().couldNotUnlinkSpaceItem));
    await reconcileSpacesAfterWrite(mailboxId, conversationId, messages().spaceItemUnlinkedRefreshFailed);
  };

  const createSpaceItem = async (kind: "task" | "event") => {
    try {
      await openCommand(`spaces.${kind}.compose`, { source: { type: "mail.conversation", id: props.conversationId } }, commandOptions());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : messages().couldNotLoadSpaces);
    }
  };
  const commandOptions = () => {
    const source = new URL(props.requestUrl, "https://mail.invalid");
    return { returnTo: `${source.pathname}${source.search}${source.hash}` };
  };
  createEffect(() => {
    // Readers get no commands that link or create Spaces items, here or in the command palette.
    if (!props.active || props.canWrite === false || context()?.spaces.status !== "ready") return;
    const id = props.conversationId;
    const t = mailCommandMessages.resolve([locale()]).t;
    onCleanup(
      registerContextAwareCommand({
        id: `mail.${id}.spaces.link`,
        scope: "selection",
        title: t.linkSpaceTitle,
        description: t.linkSpaceDescription,
        icon: "ti ti-link",
        action: linkExistingSpaceItem,
      }),
    );
    for (const kind of ["task", "event"] as const)
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `mail.${id}.${kind}`,
          title: kind === "task" ? t.sourceTask : t.sourceEvent,
          description: props.subject ? t.sourceDescriptionFor({ subject: props.subject }) : t.sourceDescription,
          icon: kind === "task" ? "ti ti-checkbox" : "ti ti-calendar-event",
          action: { command: `spaces.${kind}.compose`, input: { source: { type: "mail.conversation", id } }, options: commandOptions() },
        }),
      );
  });

  onCleanup(() => createParticipantContact.abort());

  const spacesItems = createMemo(() => {
    const current = context();
    return current?.spaces.status === "ready" ? current.spaces.items.filter((item) => item.links.some((link) => link.rel === "open")) : [];
  });
  const spacesState = (): "loading" | "error" | "ready" => {
    const current = context();
    if (!current) return contexts.error() ? "error" : "loading";
    return current.spaces.status === "ready" ? "ready" : "error";
  };
  const peopleState = (): "loading" | "error" | "ready" => {
    const current = context();
    if (!current) return contexts.error() ? "error" : "loading";
    return contexts.error() || current.contacts.status !== "ready" ? "error" : "ready";
  };
  const spacesTruncated = () => {
    const current = context();
    return current?.spaces.status === "ready" && current.spaces.truncated;
  };
  const retry = () => void contexts.refresh();

  const people = (
    <Switch>
      <Match when={peopleState() === "loading"}>
        <Placeholder state="loading" variant="inline" align="left" title={messages().loadingContacts} />
      </Match>
      <Match when={peopleState() === "error"}>
        <Placeholder
          state="error"
          variant="compact"
          align="left"
          title={messages().contactsUnavailable}
          description={contexts.error()?.message ?? messages().contactContextRefreshFailed}
          onRetry={retry}
        />
      </Match>
      <Match when={participantRows().length === 0}>
        <p class="mail-details-none">{messages().noExternalParticipants}</p>
      </Match>
      <Match when={true}>
        <>
          <div class="flex flex-col gap-2">
            <For each={participantRows()}>
              {(participant) => (
                <article class="min-w-0">
                  <Show
                    when={participant.contacts.length > 0}
                    fallback={
                      <Show
                        when={!participant.hasMatch && canCreateContact}
                        fallback={
                          <div class="flex min-w-0 items-start gap-2 px-2 py-1.5">
                            <i class="ti ti-user mt-0.5 text-dimmed" aria-hidden="true" />
                            <div class="min-w-0 flex-1">
                              <p class="truncate text-sm font-medium text-primary">{participant.displayName || participant.email}</p>
                              <Show when={participant.hasMatch || participant.displayName}>
                                <p class="truncate text-xs text-dimmed">
                                  {participant.hasMatch ? messages().matchingContactAvailable : participant.email}
                                </p>
                              </Show>
                            </div>
                          </div>
                        }
                      >
                        <DetailPanel.Action
                          type="button"
                          aria-busy={contactOpening() || createParticipantContact.loading() || undefined}
                          onClick={() => void chooseBookAndCreate(participant)}
                          leading={
                            <Show
                              when={contactOpening() || createParticipantContact.loading()}
                              fallback={<i class="ti ti-user-plus app-accent-text" aria-hidden="true" />}
                            >
                              <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
                            </Show>
                          }
                          title={participant.email}
                          trailing={<span class="text-[0.6875rem] font-normal">{messages().newContact}</span>}
                        />
                      </Show>
                    }
                  >
                    <div class="flex flex-col gap-1">
                      <Show when={participant.showParticipantHeading}>
                        <div class="px-2 py-1">
                          <p class="truncate text-xs font-medium text-secondary">{participant.displayName || participant.email}</p>
                          <Show when={participant.displayName}>
                            <p class="truncate text-xs text-dimmed" title={participant.email}>
                              {participant.email}
                            </p>
                          </Show>
                        </div>
                      </Show>
                      <For each={participant.contacts}>
                        {(contact) => {
                          const relatedMailHref = buildExactParticipantSearchHref(
                            new URL(props.requestUrl, "https://mail.invalid"),
                            participant.email,
                          );
                          const description = () =>
                            [
                              participant.showParticipantHeading ? null : participant.email,
                              contact.jobTitle,
                              contact.companyName,
                              contact.bookName,
                            ]
                              .filter(Boolean)
                              .join(" · ");
                          return (
                            <div class="min-w-0">
                              <Show
                                when={contact.openHref}
                                fallback={
                                  <div class="flex min-w-0 items-start gap-2 px-2 py-1.5">
                                    <i class="ti ti-address-book mt-0.5 text-dimmed" aria-hidden="true" />
                                    <div class="min-w-0 flex-1">
                                      <p class="truncate text-sm font-medium text-primary">{contact.displayName}</p>
                                      <Show when={description()}>
                                        <p class="truncate text-xs text-dimmed">{description()}</p>
                                      </Show>
                                    </div>
                                  </div>
                                }
                              >
                                {(href) => (
                                  <Show
                                    when={relatedMailHref}
                                    fallback={
                                      <DetailPanel.Action
                                        href={href()}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        leading={<i class="ti ti-address-book" aria-hidden="true" />}
                                        title={contact.displayName}
                                        description={description() || undefined}
                                      />
                                    }
                                  >
                                    {(mailHref) => (
                                      <DetailPanel.Action
                                        href={href()}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        leading={<i class="ti ti-address-book" aria-hidden="true" />}
                                        title={contact.displayName}
                                        description={description() || undefined}
                                        menuLabel={messages().moreActionsFor({ name: contact.displayName })}
                                        menuItems={[
                                          {
                                            label: messages().relatedMail,
                                            icon: "ti ti-mail",
                                            href: mailHref(),
                                            external: true,
                                          },
                                        ]}
                                      />
                                    )}
                                  </Show>
                                )}
                              </Show>
                              <Show when={contact.phones[0]}>
                                {(phone) => (
                                  <DetailPanel.Action
                                    href={`tel:${phone().phone}`}
                                    leading={<i class="ti ti-phone" aria-hidden="true" />}
                                    title={phone().phone}
                                    description={messages().phone}
                                  />
                                )}
                              </Show>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </article>
              )}
            </For>
          </div>
          <Show when={contexts.hasMore()}>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              class="mt-3"
              loading={contexts.loadingMore()}
              loadingLabel={messages().loadingMore}
              onClick={() => void contexts.loadMore()}
            >
              {messages().loadMore}
            </Button>
          </Show>
        </>
      </Match>
    </Switch>
  );

  const spaces = (
    <>
      <Switch>
        <Match when={spacesState() === "loading"}>
          <Placeholder state="loading" variant="inline" align="left" title={messages().loadingSpaces} />
        </Match>
        <Match when={spacesState() === "error"}>
          <Placeholder
            state="error"
            variant="compact"
            align="left"
            title={props.unavailableText ?? messages().spacesUnavailable}
            onRetry={retry}
          />
        </Match>
      </Switch>
      <For each={spacesItems()}>
        {(item) => {
          const openHref = item.links.find((link) => link.rel === "open")?.href;
          if (!openHref) return null;
          const row = {
            href: openHref,
            target: "_blank",
            rel: "noopener noreferrer",
            leading: <i class={item.icon ?? "ti ti-checkbox"} aria-hidden="true" />,
            title: item.title,
            description: item.metadata?.find((entry) => entry.label === "Space")?.value,
          };
          // Readers see the linked item without the command that unlinks it.
          return (
            <Show when={props.canWrite !== false} fallback={<DetailPanel.Action {...row} />}>
              <DetailPanel.Action
                {...row}
                menuLabel={messages().moreActionsFor({ name: item.title })}
                menuItems={[{ label: messages().unlink, icon: "ti ti-unlink", action: () => void unlinkSpaceItem(item.ref.id) }]}
              />
            </Show>
          );
        }}
      </For>
      <Show when={spacesTruncated()}>
        <p class="mail-details-none">{messages().moreLinkedSpaceItems}</p>
      </Show>
    </>
  );

  const spacesAdd = (
    <>
      <Show when={props.canWrite !== false && spacesState() === "ready"}>
        <DetailPanel.Action
          type="button"
          class="mail-details-add"
          onClick={() => void createSpaceItem("task")}
          leading={<i class="ti ti-plus" aria-hidden="true" />}
          title={props.createTaskLabel ?? messages().spacesTask}
          menuLabel={props.moreLinkLabel ?? messages().linkSpaces}
          menuItems={[
            { label: messages().linkSpaces, icon: "ti ti-link-plus", action: () => void linkExistingSpaceItem() },
            { label: messages().spacesEvent, icon: "ti ti-calendar-event", action: () => void createSpaceItem("event") },
          ]}
        />
      </Show>
    </>
  );

  const parts: MailContextParts = {
    people,
    showPeople: showContacts,
    peopleNames: () => participantRows().map((participant) => participant.displayName || participant.email),
    spaces,
    spacesAdd,
    spacesCount: () => (spacesState() === "ready" ? spacesItems().length : undefined),
    spacesState,
  };
  return (
    <Show
      when={props.children}
      fallback={
        <>
          <Show when={showContacts()}>
            <section aria-label={messages().contacts}>{people}</section>
          </Show>
          <section aria-label={messages().spaces}>
            {spaces}
            {spacesAdd}
          </section>
        </>
      }
    >
      {(render) => render()(parts)}
    </Show>
  );
}
