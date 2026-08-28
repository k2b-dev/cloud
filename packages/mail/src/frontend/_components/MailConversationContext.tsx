import { mutation, query } from "@k2b/stdlib/solid";
import { Button, DetailPanel, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createMemo, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailConversationContext } from "../../contracts";
import { assertCursorProgress } from "../pagination";
import { readApiError } from "./api-response";
import { createContact, listWritableContactBooks } from "./contact-capabilities";
import { buildMailContactParticipantRows } from "./mail-contact-context";
import { buildExactParticipantSearchHref } from "./mail-navigation";
import { mailRemainingMessages } from "./mail-remaining-messages";

export default function MailConversationContext(props: { mailboxId: string; conversationId: string; requestUrl: string; active: boolean }) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
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

  const participantRows = createMemo(() => {
    const current = context();
    if (!current || current.contacts.status !== "ready") return [];
    return buildMailContactParticipantRows({
      participants: current.participants,
      contacts: current.contacts.items,
      matchedEmails: current.contacts.matchedEmails,
    });
  });

  const createParticipantContact = mutation.create<
    void,
    { participant: { email: string; displayName: string | null }; book: { id: string; name: string }; conversationId: string },
    { idempotencyKey: string }
  >({
    onBefore: () => ({ idempotencyKey: crypto.randomUUID() }),
    mutation: async ({ participant, book, conversationId }, { abortSignal, idempotencyKey }) => {
      await createContact(
        {
          bookId: book.id,
          label: participant.displayName || participant.email,
          emails: [{ label: messages().email, email: participant.email }],
        },
        idempotencyKey,
        abortSignal,
      );
      if (conversationId === props.conversationId) {
        try {
          await contexts.invalidate();
        } catch (error) {
          void prompts.error(error instanceof Error ? error.message : messages().contactsRefreshFailed, {
            title: messages().contactCreatedRefreshFailed,
          });
        }
      }
    },
    onError: (error) => void prompts.error(error.message, { title: messages().couldNotCreateContact }),
  });

  const chooseBookAndCreate = async (participant: { email: string; displayName: string | null }) => {
    const selected = await prompts.search<{ id: string; name: string }>(
      async ({ query, abortSignal }) => {
        const result = await listWritableContactBooks({ query: query.trim() || undefined, limit: 25 }, abortSignal);
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
    if (!selected?.value) return;
    createParticipantContact.mutate({ participant, book: selected.value, conversationId: props.conversationId });
  };

  const reconcileSpacesAfterWrite = async (mailboxId: string, conversationId: string, title: string) => {
    if (mailboxId !== props.mailboxId || conversationId !== props.conversationId) return;
    try {
      await contexts.invalidate();
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : messages().linkedSpacesRefreshFailed, { title });
    }
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
    if (!selected?.value) return;
    const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].spaces.link.$post({
      param: { mailboxId, conversationId },
      json: { itemId: selected.value.id },
    });
    if (!response.ok) return void prompts.error(await readApiError(response, messages().couldNotLinkSpaceItem));
    await reconcileSpacesAfterWrite(mailboxId, conversationId, messages().spaceItemLinkedRefreshFailed);
  };

  const unlinkSpaceItem = async (itemId: string) => {
    const mailboxId = props.mailboxId;
    const conversationId = props.conversationId;
    const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].spaces.unlink.$post({
      param: { mailboxId, conversationId },
      json: { itemId },
    });
    if (!response.ok) return void prompts.error(await readApiError(response, messages().couldNotUnlinkSpaceItem));
    await reconcileSpacesAfterWrite(mailboxId, conversationId, messages().spaceItemUnlinkedRefreshFailed);
  };

  const createSpaceItem = async (kind: "task" | "event") => {
    const mailboxId = props.mailboxId;
    const conversationId = props.conversationId;
    const destinationsResponse = await apiClient.mailboxes[":mailboxId"]["calendar-destinations"].$get({
      param: { mailboxId },
    });
    if (!destinationsResponse.ok) return void prompts.error(await readApiError(destinationsResponse, messages().couldNotLoadSpaces));
    const destinations = await destinationsResponse.json();
    const selected = await prompts.search<{ id: string; name: string }>(
      ({ query }) =>
        Promise.resolve(
          destinations.items
            .filter((space) => space.name.toLowerCase().includes(query.toLowerCase()))
            .map((space) => ({ value: space, label: space.name, icon: "ti ti-layout-kanban" })),
        ),
      {
        title: messages().chooseSpaceTitle,
        icon: "ti ti-layout-kanban",
        placeholder: messages().searchWritableSpaces,
        minQueryLength: 0,
        noResultsText: messages().noWritableSpacesFound,
        size: "small",
      },
    );
    if (!selected?.value) return;
    const destination = selected.value;
    const spaceResponse = await apiClient.mailboxes[":mailboxId"].spaces[":spaceId"].$get({
      param: { mailboxId, spaceId: destination.id },
      query: { conversationId },
    });
    if (!spaceResponse.ok) return void prompts.error(await readApiError(spaceResponse, messages().couldNotLoadSpaceKanbans));
    const space = await spaceResponse.json();
    const kanbans = space.columns.filter((column) => !column.isDone);
    const defaultKanban = kanbans[0];
    if (!defaultKanban) return void prompts.error(messages().noOpenKanban);
    const titleField = { type: "text" as const, label: messages().title, required: true, maxLength: 200 };
    const kanbanField = {
      type: "select" as const,
      label: messages().kanban,
      required: true,
      default: defaultKanban.id,
      options: kanbans.map((kanban) => ({ id: kanban.id, label: kanban.name })),
    };
    const json =
      kind === "task"
        ? await (async () => {
            const values = await prompts.form({
              title: messages().newSpaceTask,
              icon: "ti ti-checkbox",
              confirmText: messages().create,
              fields: { title: titleField, columnId: kanbanField, deadline: { type: "datetime", label: messages().deadline } },
            });
            return values?.columnId && values.title
              ? {
                  kind,
                  spaceId: destination.id,
                  columnId: values.columnId,
                  title: values.title,
                  ...(values.deadline ? { deadline: new Date(values.deadline).toISOString() } : {}),
                }
              : null;
          })()
        : await (async () => {
            const values = await prompts.form({
              title: messages().newSpaceEvent,
              icon: "ti ti-calendar-event",
              confirmText: messages().create,
              fields: {
                title: titleField,
                startsAt: { type: "datetime", label: messages().starts, required: true },
                endsAt: { type: "datetime", label: messages().ends, required: true },
              },
            });
            return values?.title && values.startsAt && values.endsAt
              ? {
                  kind,
                  spaceId: destination.id,
                  columnId: defaultKanban.id,
                  title: values.title,
                  startsAt: new Date(values.startsAt).toISOString(),
                  endsAt: new Date(values.endsAt).toISOString(),
                }
              : null;
          })();
    if (!json) return;
    const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].spaces.items.$post({
      param: { mailboxId, conversationId },
      json,
    });
    if (!response.ok) return void prompts.error(await readApiError(response, messages().couldNotCreateSpaceItem({ kind })));
    await reconcileSpacesAfterWrite(mailboxId, conversationId, messages().spaceItemCreatedRefreshFailed({ kind }));
  };

  onCleanup(() => createParticipantContact.abort());

  return (
    <>
      <section aria-label={messages().contacts} class="bg-[var(--ui-surface)] p-3">
        <Show
          when={context()}
          fallback={
            <Show when={contexts.error()} fallback={<Placeholder state="loading" align="center" title={messages().loadingContacts} />}>
              {(error) => (
                <Placeholder
                  state="error"
                  align="center"
                  title={messages().contactsUnavailable}
                  description={error().message}
                  icon="ti ti-address-book-off"
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => void contexts.refresh()}>
                      {messages().retry}
                    </Button>
                  }
                />
              )}
            </Show>
          }
        >
          <Show
            when={!contexts.error()}
            fallback={
              <Placeholder
                state="error"
                align="center"
                title={messages().contactsUnavailable}
                description={contexts.error()?.message ?? ""}
                icon="ti ti-address-book-off"
                action={
                  <Button variant="secondary" size="sm" type="button" onClick={() => void contexts.refresh()}>
                    {messages().retry}
                  </Button>
                }
              />
            }
          >
            <Show
              when={context()?.contacts.status === "ready"}
              fallback={
                <Placeholder
                  state="error"
                  align="center"
                  title={messages().contactsUnavailable}
                  description={messages().contactContextRefreshFailed}
                  icon="ti ti-address-book-off"
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => void contexts.refresh()}>
                      {messages().retry}
                    </Button>
                  }
                />
              }
            >
              <Show
                when={participantRows().length > 0}
                fallback={<Placeholder align="center" title={messages().noExternalParticipants} icon="ti ti-user-off" />}
              >
                <div class="flex flex-col gap-2">
                  <For each={participantRows()}>
                    {(participant) => (
                      <article class="min-w-0">
                        <Show
                          when={participant.contacts.length > 0}
                          fallback={
                            <Show
                              when={!participant.hasMatch}
                              fallback={
                                <div class="flex min-w-0 items-start gap-2 px-2 py-1.5">
                                  <i class="ti ti-user mt-0.5 text-dimmed" aria-hidden="true" />
                                  <div class="min-w-0 flex-1">
                                    <p class="truncate text-sm font-medium text-primary">{participant.displayName || participant.email}</p>
                                    <p class="truncate text-xs text-dimmed">{messages().matchingContactAvailable}</p>
                                  </div>
                                </div>
                              }
                            >
                              <DetailPanel.Action
                                type="button"
                                disabled={createParticipantContact.loading()}
                                onClick={() => void chooseBookAndCreate(participant)}
                                leading={<i class="ti ti-user-plus text-[var(--app-accent)]" aria-hidden="true" />}
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
                                const relatedMailHref = buildExactParticipantSearchHref(new URL(props.requestUrl), participant.email);
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
              </Show>
            </Show>
          </Show>
        </Show>
      </section>
      <section aria-label="Spaces" class="space-y-1 bg-[var(--ui-surface)] p-3">
        <Show
          when={context()}
          fallback={
            <Show when={contexts.error()} fallback={<Placeholder state="loading" align="center" title={messages().loadingSpaces} />}>
              {(error) => (
                <Placeholder
                  state="error"
                  align="center"
                  title={messages().spacesUnavailable}
                  description={error().message}
                  icon="ti ti-layout-kanban-off"
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => void contexts.refresh()}>
                      {messages().retry}
                    </Button>
                  }
                />
              )}
            </Show>
          }
        >
          {(current) => (
            <Show
              when={current().spaces.status === "ready"}
              fallback={<Placeholder state="error" align="center" title={messages().spacesUnavailable} icon="ti ti-layout-kanban-off" />}
            >
              <For each={current().spaces.status === "ready" ? current().spaces.items : []}>
                {(item) => {
                  const openHref = item.links.find((link) => link.rel === "open")?.href;
                  if (!openHref) return null;
                  return (
                    <DetailPanel.Action
                      href={openHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      leading={<i class={item.icon ?? "ti ti-checkbox"} aria-hidden="true" />}
                      title={item.title}
                      description={item.metadata?.find((entry) => entry.label === "Space")?.value}
                      menuLabel={messages().moreActionsFor({ name: item.title })}
                      menuItems={[
                        {
                          label: messages().unlink,
                          icon: "ti ti-unlink",
                          action: () => void unlinkSpaceItem(item.ref.id),
                        },
                      ]}
                    />
                  );
                }}
              </For>
              <Show when={current().spaces.status === "ready" && current().spaces.truncated}>
                <p class="px-2 py-1 text-xs text-dimmed">{messages().moreLinkedSpaceItems}</p>
              </Show>
              <DetailPanel.Action
                type="button"
                onClick={() => void linkExistingSpaceItem()}
                leading={<i class="ti ti-link-plus text-[var(--k2b-action)]" aria-hidden="true" />}
                title={messages().linkSpaces}
                trailing={<span class="text-[0.6875rem] font-normal">{messages().existingItem}</span>}
              />
              <DetailPanel.Action
                type="button"
                onClick={() => void createSpaceItem("task")}
                leading={<i class="ti ti-checkbox text-[var(--k2b-action)]" aria-hidden="true" />}
                title={messages().spacesTask}
                trailing={<span class="text-[0.6875rem] font-normal">{messages().newItem}</span>}
              />
              <DetailPanel.Action
                type="button"
                onClick={() => void createSpaceItem("event")}
                leading={<i class="ti ti-calendar-event text-[var(--k2b-action)]" aria-hidden="true" />}
                title={messages().spacesEvent}
                trailing={<span class="text-[0.6875rem] font-normal">{messages().newItem}</span>}
              />
            </Show>
          )}
        </Show>
      </section>
    </>
  );
}
