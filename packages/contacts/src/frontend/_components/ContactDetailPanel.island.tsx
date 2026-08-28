import type { Paginated } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Avatar, Button, ButtonLink, DescriptionList, DetailPanel, Dropdown, IconButton, Placeholder, Tag, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact, ContactNote, ContactRef } from "../../service";
import { resolveContactInitials, resolveContactName, safeWebsiteHref } from "../../shared";
import { readErrorMessage } from "./api";
import { createContactDetailActions } from "./ContactDetailPanel.actions";
import ContactFavoriteButton from "./ContactFavoriteButton";
import ContactNotesSection from "./ContactNotesSection";
import ContactOrgTreeView from "./ContactOrgTreeView";
import ContactQuickEdit from "./ContactQuickEdit";
import { detailMessages } from "./detail-messages";
import { createContactQuerySource, isCurrentQuerySnapshot, parseContactQuerySource } from "./contact-query-source";
import { contactFavoriteKey, listenForContactFavoriteChanges } from "./contacts-favorites";
import { listenForContactsLiveInvalidation, requiresSelectedContactRefresh } from "./contacts-live";
import {
  CONTACT_DETAIL_EVENT,
  type ContactDetailPayload,
  clearSelectedContactInUrl,
  getSelectedContactFromUrl,
  requestContactNoteComposer,
  setSelectedContactInUrl,
} from "./context";

type Props = {
  initialContact: Contact | null;
  initialContactId: string | null;
  initialBookId: string | null;
  initialNotesPage: Paginated<ContactNote>;
  contacts: Contact[];
  bookNames: Record<string, string>;
  writableBooks: Array<{ id: string; name: string }>;
  /** Books where the current user is an admin (controls e.g. note deletion). */
  adminBookIds: string[];
  currentUserId: string;
  showEmpty?: boolean;
  initialFavoriteKeys: string[];
};

const formatBirthday = (value: string | null, locale: string) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale);
};

const formatAddress = (address: Contact["addresses"][number]) => {
  const cityLine = [address.postalCode, address.city].filter(Boolean).join(" ");
  const regionLine = [address.stateRegion, address.countryCode].filter(Boolean).join(" · ");
  return [address.recipientName, address.companyName, address.line1, address.line2, cityLine, regionLine].filter(Boolean) as string[];
};

type DetailTarget = {
  source: string;
  bookId: string;
  contactId: string;
};

type DetailSnapshot = {
  source: string;
  contact: Contact | null;
  favorite: boolean;
};

export default function ContactDetailPanel(props: Props) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const initialTarget =
    props.initialContactId && props.initialBookId
      ? {
          source: createContactQuerySource({ bookId: props.initialBookId, contactId: props.initialContactId, revision: 0 }),
          bookId: props.initialBookId,
          contactId: props.initialContactId,
        }
      : null;
  const [target, setTarget] = createSignal<DetailTarget | null>(initialTarget);
  const [exactSeed, setExactSeed] = createSignal<DetailSnapshot | null>(null);
  const [detailMode, setDetailMode] = createSignal<"details" | "tree">("details");
  const [quickEditing, setQuickEditing] = createSignal(false);
  const [orgTreeSource, setOrgTreeSource] = createSignal<string | null>(null);
  const [favoriteEvents, setFavoriteEvents] = createSignal(new Map<string, boolean>());
  const favoriteFor = (contact: Pick<Contact, "bookId" | "id">) => {
    const key = contactFavoriteKey(contact.bookId, contact.id);
    const events = favoriteEvents();
    return events.has(key) ? (events.get(key) ?? false) : props.initialFavoriteKeys.includes(key);
  };
  const [selectedFavorite, setSelectedFavorite] = createSignal(props.initialContact ? favoriteFor(props.initialContact) : false);
  let nextRevision = 0;

  const detailQuery = query.create<string | null, DetailSnapshot | null>({
    source: () => target()?.source ?? null,
    enabled: () => target() !== null,
    initial:
      initialTarget && props.initialContact
        ? {
            source: initialTarget.source,
            data: {
              source: initialTarget.source,
              contact: props.initialContact,
              favorite: favoriteFor(props.initialContact),
            },
          }
        : undefined,
    load: async (source, { abortSignal }) => {
      if (!source) return null;
      const seed = exactSeed();
      if (seed?.source === source) {
        setExactSeed(null);
        return seed;
      }
      const { bookId, contactId } = parseContactQuerySource(source);
      const request = { bookId, contactId };
      const response = await apiClient.books[":bookId"].contacts[":contactId"].$get({ param: request }, { init: { signal: abortSignal } });
      if (response.status === 403 || response.status === 404) return { source, contact: null, favorite: false };
      if (!response.ok) throw new Error(await readErrorMessage(response, t().refreshContactFailed));
      const contact = await response.json();
      const favoriteResponse = await apiClient.favorites[":bookId"][":contactId"].$get(
        { param: request },
        { init: { signal: abortSignal } },
      );
      if (!favoriteResponse.ok) throw new Error(await readErrorMessage(favoriteResponse, t().loadFavoriteFailed));
      return { source, contact, favorite: (await favoriteResponse.json()).favorite };
    },
  });

  const detailSnapshot = createMemo(() => {
    const selected = target();
    const loaded = detailQuery.data();
    return selected && isCurrentQuerySnapshot(loaded, selected.source) ? loaded : null;
  });
  const contact = createMemo(() => detailSnapshot()?.contact ?? null);
  const contactId = () => target()?.contactId ?? null;
  const bookId = () => target()?.bookId ?? null;

  const retrySelectedContact = () => void detailQuery.refresh();

  const findContact = (id: string | null, selectedBookId: string | null) => {
    if (!id || !selectedBookId) return null;
    const found = props.contacts.find((item) => item.id === id && item.bookId === selectedBookId);
    if (found) return found;
    if (props.initialContact && props.initialContact.id === id && props.initialContact.bookId === selectedBookId) {
      return props.initialContact;
    }
    return null;
  };

  const selectTarget = (
    selectedBookId: string | null,
    selectedContactId: string | null,
    seed?: { contact: Contact; favorite: boolean },
  ) => {
    setDetailMode("details");
    setQuickEditing(false);
    setOrgTreeSource(null);
    if (!selectedBookId || !selectedContactId) {
      setExactSeed(null);
      setTarget(null);
      return;
    }
    const source = createContactQuerySource({ bookId: selectedBookId, contactId: selectedContactId, revision: ++nextRevision });
    setExactSeed(seed ? { source, contact: seed.contact, favorite: seed.favorite } : null);
    setTarget({ source, bookId: selectedBookId, contactId: selectedContactId });
  };

  const syncFromUrl = () => {
    const selected = getSelectedContactFromUrl();
    const found = findContact(selected.contactId, selected.bookId);
    selectTarget(selected.bookId, selected.contactId, found ? { contact: found, favorite: favoriteFor(found) } : undefined);
  };

  createEffect(() => {
    const snapshot = detailSnapshot();
    if (!snapshot) return;
    const loadedSource = snapshot.source;
    if (!snapshot.contact) {
      queueMicrotask(() => {
        if (detailSnapshot()?.source === loadedSource) clearSelectedContactInUrl("replace");
      });
      return;
    }
    setSelectedFavorite(snapshot.favorite);
    const selected = getSelectedContactFromUrl();
    if (selected.contactId !== snapshot.contact.id || selected.bookId !== snapshot.contact.bookId) {
      const updated = snapshot.contact;
      queueMicrotask(() => {
        if (detailSnapshot()?.source !== loadedSource) return;
        setSelectedContactInUrl({
          contactId: updated.id,
          bookId: updated.bookId,
          contact: updated,
          favorite: snapshot.favorite,
          history: "replace",
        });
      });
    }
  });

  onMount(() => {
    const handleSelect = (event: Event) => {
      const payload = (event as CustomEvent<ContactDetailPayload>).detail;
      const found = payload.item ?? findContact(payload.itemKey, payload.bookId);
      selectTarget(
        payload.bookId,
        payload.itemKey,
        found
          ? {
              contact: found,
              favorite: favoriteEvents().has(contactFavoriteKey(found.bookId, found.id))
                ? favoriteFor(found)
                : (payload.favorite ?? favoriteFor(found)),
            }
          : undefined,
      );
    };

    const handlePopState = () => syncFromUrl();
    const stopFavoriteChanges = listenForContactFavoriteChanges((change) => {
      const key = contactFavoriteKey(change.bookId, change.contactId);
      setFavoriteEvents((current) => {
        const next = new Map(current);
        next.set(key, change.favorite);
        return next;
      });
      if (change.contactId === contactId() && change.bookId === bookId()) setSelectedFavorite(change.favorite);
    });

    window.addEventListener(CONTACT_DETAIL_EVENT, handleSelect);
    window.addEventListener("popstate", handlePopState);
    const stopLiveInvalidations = listenForContactsLiveInvalidation("detail", (event) => {
      const selectedContactId = contactId();
      const selectedBookId = bookId();
      if (!selectedContactId || !selectedBookId) return;
      if (event.type === "contact.deleted" && event.contactId === selectedContactId && event.bookId === selectedBookId) {
        clearSelectedContactInUrl("replace");
        return Promise.resolve();
      }
      if (event.type === "contact.moved" && event.contactId === selectedContactId && event.sourceBookId === selectedBookId) {
        selectTarget(event.targetBookId, selectedContactId);
        return detailQuery.invalidate();
      }
      if (requiresSelectedContactRefresh(event, selectedBookId)) {
        return detailQuery.invalidate();
      }
    });

    onCleanup(() => {
      stopLiveInvalidations();
      stopFavoriteChanges();
      window.removeEventListener(CONTACT_DETAIL_EVENT, handleSelect);
      window.removeEventListener("popstate", handlePopState);
    });
  });

  const actions = createContactDetailActions({
    bookId,
    writableBooks: props.writableBooks,
    orgTreeSource,
    setOrgTreeSource,
    setDetailMode,
    invalidateDetail: detailQuery.invalidate,
  });

  return (
    <Show
      when={contact()}
      fallback={
        <Show
          when={detailQuery.error()}
          fallback={
            <Show
              when={detailQuery.loading() || detailQuery.refreshing()}
              fallback={
                props.showEmpty === false ? null : (
                  <Placeholder icon="ti ti-id" class="h-full min-h-0 justify-center" description={<>{t().selectContactHint}</>} />
                )
              }
            >
              <Placeholder state="loading" variant="panel" class="h-full min-h-0 justify-center" title={t().loadingContact} />
            </Show>
          }
        >
          {(error) => (
            <Placeholder
              state="error"
              variant="panel"
              align="left"
              class="h-full min-h-0 justify-center"
              title={t().couldNotLoadContact}
              description={error().message}
              action={
                <Button variant="secondary" size="sm" onClick={retrySelectedContact}>
                  {t().tryAgain}
                </Button>
              }
            />
          )}
        </Show>
      }
    >
      {(selectedContact) => {
        const c = selectedContact;
        const hasReach = () => c().emails.length > 0 || c().phones.length > 0 || c().websites.length > 0;
        const hasPrimaryActions = () => !!(c().emails[0] || c().phones[0] || actions.canEdit());
        const hasWork = () => !!(c().companyName || c().department || c().jobTitle || c().vatId);
        const hasFormalName = () => !!(c().label && (c().firstName || c().lastName));
        const hasPersonal = () => hasFormalName() || !!(c().birthday || c().salutation || c().pronouns || c().preferredLanguage);
        const hasOrgTree = () => c().parentContactId !== null || c().members.length > 0;
        const hasContactInformation = () => hasReach() || c().addresses.length > 0;
        const hasAdditionalDetails = () => c().bankAccounts.length > 0 || hasPersonal() || hasWork();
        const hasOrganization = () => !!(c().parent || hasOrgTree() || actions.canEdit());
        const keyDetailItems = () => [
          {
            term: t().name,
            description: [c().firstName, c().lastName].filter(Boolean).join(" ") || resolveContactName(c(), t().unnamedContact),
          },
          ...(c().companyName ? [{ term: t().company, description: c().companyName }] : []),
          ...(c().jobTitle ? [{ term: t().jobTitle, description: c().jobTitle }] : []),
          { term: t().book, description: props.bookNames[c().bookId] ?? c().bookId },
          ...(c().tags.length > 0
            ? [
                {
                  term: t().tags,
                  description: (
                    <span class="flex flex-wrap gap-1.5">
                      <For each={c().tags}>
                        {(tag) => (
                          <Tag color={tag.color} icon="ti ti-point" size="lg">
                            {tag.name}
                          </Tag>
                        )}
                      </For>
                    </span>
                  ),
                },
              ]
            : []),
        ];
        return (
          <Show
            when={detailMode() === "tree" && actions.orgTree()}
            fallback={
              <DetailPanel>
                <DetailPanel.Header
                  leading={<Avatar name={resolveContactName(c(), t().unnamedContact)} fallback={resolveContactInitials(c())} size="sm" />}
                  title={resolveContactName(c(), t().unnamedContact)}
                  subtitle={[c().jobTitle, c().companyName, props.bookNames[c().bookId]].filter(Boolean).join(" · ")}
                  primaryActions={
                    hasPrimaryActions() ? (
                      <nav aria-label={t().contactActions} class="flex flex-wrap gap-2">
                        <Show when={c().emails[0]}>
                          {(email) => (
                            <ButtonLink href={`mailto:${email().email}`} variant="secondary" size="sm">
                              <i class="ti ti-mail" aria-hidden="true" /> {t().email}
                            </ButtonLink>
                          )}
                        </Show>
                        <Show when={c().phones[0]}>
                          {(phone) => (
                            <ButtonLink href={`tel:${phone().phone}`} variant="secondary" size="sm">
                              <i class="ti ti-phone" aria-hidden="true" /> {t().call}
                            </ButtonLink>
                          )}
                        </Show>
                        <Show when={actions.canEdit()}>
                          <Button variant="secondary" size="sm" onClick={() => requestContactNoteComposer(c().id)}>
                            <i class="ti ti-message" aria-hidden="true" /> {t().comment}
                          </Button>
                        </Show>
                      </nav>
                    ) : undefined
                  }
                  actions={
                    <>
                      <ContactFavoriteButton bookId={c().bookId} contactId={c().id} initialFavorite={selectedFavorite()} />
                      <Dropdown.Root
                        position="bottom-left"
                        items={[
                          {
                            label: t().downloadVCard,
                            icon: "ti ti-download",
                            href: `/api/contacts/books/${encodeURIComponent(c().bookId)}/contacts/${encodeURIComponent(c().id)}/export.vcf`,
                          },
                          ...(actions.canEdit()
                            ? [
                                {
                                  label: t().editAllFields,
                                  icon: "ti ti-pencil",
                                  action: () => actions.openEditDialog(c()),
                                },
                              ]
                            : []),
                          ...(actions.canMove()
                            ? [
                                {
                                  label: t().moveToAnotherBook,
                                  icon: "ti ti-folder-symlink",
                                  action: () => actions.moveToBook(c()),
                                },
                              ]
                            : []),
                        ]}
                      >
                        <Dropdown.Trigger iconOnly label={t().moreContactActions} tooltip={t().moreContactActions}>
                          <i class="ti ti-dots" aria-hidden="true" />
                        </Dropdown.Trigger>
                      </Dropdown.Root>
                      <IconButton label={t().closeDetailPanel} onClick={() => clearSelectedContactInUrl()}>
                        <i class="ti ti-x" aria-hidden="true" />
                      </IconButton>
                    </>
                  }
                />

                <DetailPanel.Body scrollPreserveKey="contacts-detail">
                  <DetailPanel.Summary
                    title={t().overview}
                    actions={
                      actions.canEdit() && !quickEditing() ? (
                        <Button variant="ghost" size="sm" onClick={() => setQuickEditing(true)}>
                          <i class="ti ti-pencil" aria-hidden="true" /> {t().quickEdit}
                        </Button>
                      ) : undefined
                    }
                  >
                    <Show when={quickEditing()} fallback={<DescriptionList layout="rows" size="sm" items={keyDetailItems()} />}>
                      <ContactQuickEdit
                        contact={c()}
                        onCancel={() => setQuickEditing(false)}
                        onSaved={(updated) => {
                          setQuickEditing(false);
                          setSelectedContactInUrl({
                            contactId: updated.id,
                            bookId: updated.bookId,
                            contact: updated,
                          });
                        }}
                        onEditAll={() => {
                          setQuickEditing(false);
                          void actions.openEditDialog(c());
                        }}
                      />
                    </Show>
                  </DetailPanel.Summary>

                  <Show when={hasContactInformation()}>
                    <DetailPanel.Group label={t().contactInformation}>
                      <Show when={hasReach()}>
                        <DetailPanel.Section title={t().reach} icon="ti ti-at" tone="accent">
                          <div class="flex flex-col gap-1">
                            <For each={c().emails}>
                              {(email) => (
                                <DetailPanel.Action
                                  href={`mailto:${email.email}`}
                                  leading={<i class="ti ti-mail" aria-hidden="true" />}
                                  title={<span class="break-all">{email.email}</span>}
                                  description={email.label ?? t().email}
                                />
                              )}
                            </For>
                            <For each={c().phones}>
                              {(phone) => (
                                <DetailPanel.Action
                                  href={`tel:${phone.phone}`}
                                  leading={<i class="ti ti-phone" aria-hidden="true" />}
                                  title={phone.phone}
                                  description={phone.label ?? t().phone}
                                />
                              )}
                            </For>
                            <For each={c().websites}>
                              {(website) => (
                                <Show
                                  when={safeWebsiteHref(website.url)}
                                  fallback={
                                    <div class="flex min-w-0 items-start gap-3 px-2 py-2 text-sm">
                                      <i class="ti ti-world mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
                                      <span class="min-w-0">
                                        <span class="block break-all text-secondary">{website.url}</span>
                                        <span class="block text-xs text-dimmed">{website.label ?? t().website}</span>
                                      </span>
                                    </div>
                                  }
                                >
                                  {(href) => (
                                    <DetailPanel.Action
                                      href={href()}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      leading={<i class="ti ti-world" aria-hidden="true" />}
                                      title={<span class="break-all">{website.url}</span>}
                                      description={website.label ?? t().website}
                                      trailing={<i class="ti ti-external-link" aria-hidden="true" />}
                                    />
                                  )}
                                </Show>
                              )}
                            </For>
                          </div>
                        </DetailPanel.Section>
                      </Show>

                      <Show when={c().addresses.length > 0}>
                        <DetailPanel.Section title={t().addresses} icon="ti ti-map-pin" tone="neutral" collapsible>
                          <div class="flex flex-col gap-3">
                            <For each={c().addresses}>
                              {(address) => (
                                <div class="flex items-start gap-3 px-2 py-1 text-sm text-primary">
                                  <i class="ti ti-map-pin mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
                                  <div class="min-w-0 flex-1">
                                    <Show when={address.label}>
                                      <p class="text-xs text-dimmed">{address.label}</p>
                                    </Show>
                                    <For each={formatAddress(address)}>{(line) => <p class="leading-snug">{line}</p>}</For>
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </DetailPanel.Section>
                      </Show>
                    </DetailPanel.Group>
                  </Show>

                  <Show when={hasAdditionalDetails()}>
                    <DetailPanel.Group label={t().additionalDetails}>
                      <Show when={c().bankAccounts.length > 0}>
                        <DetailPanel.Section title={t().bankDetails} icon="ti ti-building-bank" tone="neutral" collapsible>
                          <div class="flex flex-col gap-3">
                            <For each={c().bankAccounts}>
                              {(account) => (
                                <div class="flex items-start gap-3 px-2 py-1 text-sm text-primary">
                                  <i class="ti ti-building-bank mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
                                  <div class="min-w-0 flex-1">
                                    <Show when={account.label}>
                                      <p class="text-xs text-dimmed">{account.label}</p>
                                    </Show>
                                    <p class="leading-snug">{account.accountHolderName}</p>
                                    <p class="break-all font-mono text-xs leading-snug">{account.iban}</p>
                                    <Show when={account.bic || account.bankName}>
                                      <p class="text-xs leading-snug text-dimmed">
                                        {[account.bankName, account.bic].filter(Boolean).join(" · ")}
                                      </p>
                                    </Show>
                                    <Show when={account.note}>
                                      <p class="text-xs leading-snug text-dimmed">{account.note}</p>
                                    </Show>
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </DetailPanel.Section>
                      </Show>

                      <Show when={hasPersonal()}>
                        <DetailPanel.Section title={t().personal} icon="ti ti-user" tone="neutral" collapsible defaultOpen>
                          <DescriptionList
                            layout="rows"
                            size="sm"
                            items={[
                              ...(hasFormalName() && c().firstName ? [{ term: t().firstName, description: c().firstName }] : []),
                              ...(hasFormalName() && c().lastName ? [{ term: t().lastName, description: c().lastName }] : []),
                              ...(c().birthday
                                ? [{ term: t().birthday, description: formatBirthday(c().birthday, locale()) ?? c().birthday }]
                                : []),
                              ...(c().salutation ? [{ term: t().salutation, description: c().salutation }] : []),
                              ...(c().pronouns ? [{ term: t().pronouns, description: c().pronouns }] : []),
                              ...(c().preferredLanguage ? [{ term: t().language, description: c().preferredLanguage }] : []),
                            ]}
                          />
                        </DetailPanel.Section>
                      </Show>

                      <Show when={hasWork()}>
                        <DetailPanel.Section title={t().work} icon="ti ti-briefcase" tone="accent" collapsible defaultOpen>
                          <DescriptionList
                            layout="rows"
                            size="sm"
                            items={[
                              ...(c().companyName ? [{ term: t().company, description: c().companyName }] : []),
                              ...(c().department ? [{ term: t().department, description: c().department }] : []),
                              ...(c().jobTitle ? [{ term: t().jobTitle, description: c().jobTitle }] : []),
                              ...(c().vatId
                                ? [
                                    {
                                      term: t().vatId,
                                      description: <span class="break-all font-mono">{c().vatId}</span>,
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        </DetailPanel.Section>
                      </Show>
                    </DetailPanel.Group>
                  </Show>

                  <Show when={hasOrganization()}>
                    <DetailPanel.Group label={t().organizationContext}>
                      <DetailPanel.Section
                        title={t().organization}
                        icon="ti ti-hierarchy"
                        tone="accent"
                        actions={
                          <>
                            <Show when={hasOrgTree()}>
                              <Button variant="ghost" size="sm" loading={actions.orgTreeLoading()} onClick={() => actions.openOrgTree(c())}>
                                <i class="ti ti-hierarchy" aria-hidden="true" /> {t().tree}
                              </Button>
                            </Show>
                            <Show when={actions.canEdit()}>
                              <Button variant="ghost" size="sm" onClick={() => actions.openAddMemberDialog(c())}>
                                <i class="ti ti-plus" aria-hidden="true" /> {t().addMember}
                              </Button>
                            </Show>
                          </>
                        }
                      >
                        <div class="flex flex-col gap-1">
                          <Show when={c().parent}>
                            {(parent) => (
                              <DetailPanel.Action
                                type="button"
                                onClick={() =>
                                  setSelectedContactInUrl({
                                    contactId: parent().id,
                                    bookId: c().bookId,
                                    contact: null,
                                  })
                                }
                                leading={<i class="ti ti-arrow-up" aria-hidden="true" />}
                                title={resolveContactName(parent(), t().unnamedContact)}
                                description={t().parentContact}
                                trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                              />
                            )}
                          </Show>
                          <Show when={c().members.length > 0}>
                            <ul class="flex flex-col gap-1">
                              <For each={c().members}>
                                {(member) => (
                                  <li class="group flex items-center gap-1">
                                    <DetailPanel.Action
                                      type="button"
                                      class="min-w-0 flex-1"
                                      onClick={() =>
                                        setSelectedContactInUrl({
                                          contactId: member.id,
                                          bookId: c().bookId,
                                          contact: null,
                                        })
                                      }
                                      leading={
                                        <span
                                          class="contact-avatar flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium"
                                          aria-hidden="true"
                                        >
                                          {(resolveContactName(member as ContactRef, t().unnamedContact) || "?").charAt(0).toUpperCase()}
                                        </span>
                                      }
                                      title={resolveContactName(member as ContactRef, t().unnamedContact)}
                                      description={[member.companyName, member.jobTitle].filter(Boolean).join(" · ") || undefined}
                                      trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                                    />
                                    <Show when={actions.canEdit()}>
                                      <Tooltip.Anchor content={t().removeFromMembers}>
                                        <IconButton
                                          variant="ghost"
                                          size="xs"
                                          onClick={() => actions.unlinkMember(member, c())}
                                          class="shrink-0 text-dimmed opacity-100 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                                          label={t().removeMemberLabel({ name: resolveContactName(member as ContactRef, t().unnamedContact) })}
                                        >
                                          <i class="ti ti-unlink" aria-hidden="true" />
                                        </IconButton>
                                      </Tooltip.Anchor>
                                    </Show>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                          <Show when={!c().parent && c().members.length === 0}>
                            <p class="px-2 py-1 text-sm text-dimmed">{t().noHierarchyYet}</p>
                          </Show>
                        </div>
                      </DetailPanel.Section>
                    </DetailPanel.Group>
                  </Show>

                  <Show when={`${c().bookId}:${c().id}`} keyed>
                    {(_contactKey) => (
                      <ContactNotesSection
                        bookId={c().bookId}
                        contactId={c().id}
                        currentUserId={props.currentUserId}
                        initialNotesPage={
                          c().id === props.initialContactId && c().bookId === props.initialBookId ? props.initialNotesPage : undefined
                        }
                        canWrite={actions.canEdit()}
                      />
                    )}
                  </Show>
                </DetailPanel.Body>
              </DetailPanel>
            }
          >
            {(tree) => (
              <ContactOrgTreeView
                tree={tree()}
                onSelect={(node) => actions.selectOrgTreeNode(node, c().bookId)}
                onBack={() => {
                  actions.closeOrgTree();
                }}
              />
            )}
          </Show>
        );
      }}
    </Show>
  );
}
