import { accessMemberEntries } from "@k2b/cloud/access/ui";
import { useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { AccessMember } from "@k2b/cloud/contracts";
import type { GeoAvailabilityData } from "@k2b/cloud/contracts/geo";
import { documentNavigate, refreshCurrentPath } from "@k2b/ssr/nav";
import type { Paginated } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import {
  Avatar,
  Button,
  ButtonLink,
  DetailAccess,
  DetailPanel,
  FactGroup,
  type FactGroupItem,
  Format,
  IconButton,
  InlineGuidance,
  Placeholder,
  Section,
  Tag,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact, ContactNote, ContactRef } from "../../service";
import { resolveContactName, safeWebsiteHref } from "../../shared";
import { readErrorMessage } from "./api";
import ContactAddressEditor from "./ContactAddressEditor";
import ContactAddressMap from "./ContactAddressMap";
import { createContactDetailActions } from "./ContactDetailPanel.actions";
import ContactFavoriteButton from "./ContactFavoriteButton";
import ContactNotesSection from "./ContactNotesSection";
import ContactOrgTreeView from "./ContactOrgTreeView";
import ContactQuickEdit from "./ContactQuickEdit";
import { contactFormMessages } from "./contact-form-messages";
import { announceContactOutcome } from "./contact-outcome";
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
import { detailMessages } from "./detail-messages";

type Props = {
  initialContact: Contact | null;
  initialContactId: string | null;
  initialBookId: string | null;
  initialAddressId?: string | null;
  initialNotesPage?: Paginated<ContactNote>;
  contacts: Contact[];
  bookNames: Record<string, string>;
  writableBooks: Array<{ id: string; name: string }>;
  /** Books where the current user is an admin (controls e.g. note deletion). */
  adminBookIds: string[];
  /** Books whose access list the current user may read: access of their own, decided on the server. */
  memberBookIds: string[];
  currentUserId: string;
  showEmpty?: boolean;
  initialFavoriteKeys: string[];
  /** Core's geo setup and budget for this reader, from the same SSR request. */
  geoAvailability?: GeoAvailabilityData;
  /** The reader's time zone, so reset times read the same on the server and in the browser. */
  timeZone: string;
};

// K17 area colours, only in a topic's symbol tile: contact blue-green, people grey. Never a status hue, never plum.
const CONTACT_AREA_COLOR = "#0f766e";
const RELATION_AREA_COLOR = "#52525b";

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
  const form = () => contactFormMessages.resolve([locale()]).t;
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
  const [addressId, setAddressId] = createSignal(props.initialAddressId ?? null);
  const [quickEditing, setQuickEditing] = createSignal(false);
  // Who has access belongs to the contact's book: it loads after the first paint, once per book, and only for
  // people with access of their own.
  const accessBookId = () => {
    const bookId = target()?.bookId;
    return bookId && props.memberBookIds.includes(bookId) ? bookId : null;
  };
  const [accessWanted, setAccessWanted] = createSignal(false);
  onMount(() => setAccessWanted(true));
  // Loaded lists stay for the page, so going back to a book shows its list at once without another read.
  const [accessCache, setAccessCache] = createSignal<ReadonlyMap<string, AccessMember[]>>(new Map());
  const accessMembers = query.create<string, AccessMember[]>({
    source: () => accessBookId() ?? "",
    enabled: () => {
      const bookId = accessBookId();
      return accessWanted() && bookId !== null && !accessCache().has(bookId);
    },
    load: async (bookId, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].access.members.$get({ param: { bookId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readErrorMessage(response, t().accessLoadFailed));
      const members = await response.json();
      setAccessCache((cache) => new Map(cache).set(bookId, members));
      return members;
    },
  });
  /** Forgets a book's list and reads it again, after a retry or a change in the book's settings. */
  const reloadAccess = (bookId: string) => {
    setAccessCache((cache) => {
      const next = new Map(cache);
      next.delete(bookId);
      return next;
    });
    void accessMembers.refresh();
  };
  // Managing access is the book's settings; its code loads on first use.
  const openBookAccess = async (bookId: string) => {
    const settings = await importOnDemand(() => import("./BookSettingsDialog"));
    if (!settings) return;
    const result = await settings.openBookSettingsDialog({ bookId, initialTab: "access" });
    reloadAccess(bookId);
    if (result.workspaceChanged && !result.deleted) refreshCurrentPath();
  };
  const accessState = (bookId: string) => (accessCache().has(bookId) ? "ready" : accessMembers.error() ? "error" : "loading");
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
  let addressReturnFocus: { addressId: string; contactId: string; bookId: string } | undefined;
  createEffect(() => {
    const current = contact();
    if (addressId() || !current || !addressReturnFocus) return;
    const focus = addressReturnFocus;
    addressReturnFocus = undefined;
    queueMicrotask(() => {
      if (addressId() || contact()?.id !== focus.contactId || contact()?.bookId !== focus.bookId) return;
      const action = document.querySelector<HTMLElement>(`[data-contact-address-edit="${CSS.escape(focus.addressId)}"]`);
      const destination = action ?? document.querySelector<HTMLElement>(".contacts-reader .k2b-detail-panel__heading h2");
      if (!destination) return;
      if (!action) destination.tabIndex = -1;
      destination.focus();
    });
  });
  createEffect(() => {
    const current = contact();
    if (!current?.emails.length) return;
    const name = resolveContactName(current, t().unnamedContact);
    onCleanup(
      registerContextAwareCommand({
        scope: "selection",
        id: `contacts.${current.id}.compose`,
        title: t().composeToContact({ name }),
        description: t().composeToContactDescription,
        icon: "ti ti-mail-plus",
        action: { command: "mail.compose", input: { contact: { type: "contacts.contact", id: current.id } } },
      }),
    );
  });
  const contactId = () => target()?.contactId ?? null;
  const bookId = () => target()?.bookId ?? null;

  const retrySelectedContact = () => void detailQuery.refresh();

  const selectTarget = (
    selectedBookId: string | null,
    selectedContactId: string | null,
    seed?: { contact: Contact; favorite: boolean },
    selectedAddressId?: string | null,
  ) =>
    batch(() => {
      const returningFromAddress = addressId();
      if (
        returningFromAddress &&
        !selectedAddressId &&
        target()?.bookId === selectedBookId &&
        target()?.contactId === selectedContactId &&
        selectedBookId &&
        selectedContactId
      ) {
        addressReturnFocus = { addressId: returningFromAddress, contactId: selectedContactId, bookId: selectedBookId };
      }
      // Change selection and query source together, before a focus return can observe the old snapshot.
      setAddressId(selectedAddressId ?? null);
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
    });

  const syncFromUrl = () => {
    const selected = getSelectedContactFromUrl();
    selectTarget(selected.bookId, selected.contactId, undefined, selected.addressId);
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
          addressId: addressId(),
        });
      });
    }
  });

  onMount(() => {
    const handleSelect = (event: Event) => {
      const payload = (event as CustomEvent<ContactDetailPayload>).detail;
      const found = payload.item;
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
        payload.addressId,
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

  const cloudId = useCloudIdCopy();
  const actions = createContactDetailActions({
    bookId,
    writableBooks: props.writableBooks,
    orgTreeSource,
    setOrgTreeSource,
    setDetailMode,
    invalidateDetail: detailQuery.invalidate,
    geoAvailability: props.geoAvailability,
  });

  createEffect(() => {
    const current = contact();
    if (!current) return;
    announceContactOutcome(current, t());
    const description = resolveContactName(current, t().unnamedContact);
    if (actions.canEdit())
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `contacts.${current.id}.edit`,
          title: t().editContactCommand({ name: description }),
          description: t().editContactDescription,
          icon: "ti ti-edit",
          shortcut: "e",
          action: () => actions.openEditDialog(current),
        }),
      );
    if (actions.canMove())
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `contacts.${current.id}.move`,
          title: t().moveToAnotherBook,
          description: t().moveContactDescription({ name: description }),
          icon: "ti ti-folder",
          action: () => actions.moveToBook(current),
        }),
      );
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
        const hasWork = () => !!(c().companyName || c().department || c().jobTitle || c().vatId);
        const hasFormalName = () => !!(c().label && (c().firstName || c().lastName));
        const hasPersonal = () => hasFormalName() || !!(c().birthday || c().salutation || c().pronouns || c().preferredLanguage);
        const hasOrgTree = () => c().parentContactId !== null || c().members.length > 0;
        const accessShown = () => accessBookId() === c().bookId;
        // K9: at most two framed actions in a row; a third waits beside them as an icon button.
        const framedReach = () => (c().emails[0] ? 1 : 0) + (c().phones[0] ? 1 : 0);
        const hasOrganization = () => !!(c().parent || hasOrgTree() || actions.canEdit());
        // K17: the facts beside the topics, quiet label and strong value, one pencil per group, copy where people
        // carry a value elsewhere. Every fact of the former sections stays; nothing is folded away any more.
        const reachItems = (): FactGroupItem[] => [
          ...c().emails.map((email) => ({
            label: email.label ?? t().email,
            value: (
              <a class="contacts-fact-link" href={`mailto:${email.email}`}>
                {email.email}
              </a>
            ),
            copy: email.email,
          })),
          ...c().phones.map((phone) => ({
            label: phone.label ?? t().phone,
            value: (
              <a class="contacts-fact-link tabular-nums" href={`tel:${phone.phone}`}>
                {phone.phone}
              </a>
            ),
            copy: phone.phone,
          })),
          ...c().websites.map((website) => {
            const href = safeWebsiteHref(website.url);
            return {
              label: website.label ?? t().website,
              value: href ? (
                <a class="contacts-fact-link" href={href} target="_blank" rel="noopener noreferrer">
                  {website.url}
                </a>
              ) : (
                website.url
              ),
              copy: website.url,
            };
          }),
        ];
        const personalItems = (): FactGroupItem[] => [
          ...(hasFormalName() && c().firstName ? [{ label: t().firstName, value: c().firstName }] : []),
          ...(hasFormalName() && c().lastName ? [{ label: t().lastName, value: c().lastName }] : []),
          ...(c().birthday
            ? [{ label: t().birthday, value: <Format.Date value={c().birthday} fallback={c().birthday ?? undefined} /> }]
            : []),
          ...(c().salutation ? [{ label: t().salutation, value: c().salutation }] : []),
          ...(c().pronouns ? [{ label: t().pronouns, value: c().pronouns }] : []),
          ...(c().preferredLanguage ? [{ label: t().language, value: c().preferredLanguage }] : []),
        ];
        const workItems = (): FactGroupItem[] => [
          ...(c().companyName ? [{ label: t().company, value: c().companyName }] : []),
          ...(c().department ? [{ label: t().department, value: c().department }] : []),
          ...(c().jobTitle ? [{ label: t().jobTitle, value: c().jobTitle }] : []),
          ...(c().vatId ? [{ label: t().vatId, value: <span class="font-mono">{c().vatId}</span>, copy: c().vatId ?? undefined }] : []),
        ];
        const bankItems = (account: Contact["bankAccounts"][number]): FactGroupItem[] => [
          { label: form().accountHolder, value: account.accountHolderName },
          { label: form().iban, value: <span class="font-mono">{account.iban}</span>, copy: account.iban },
          ...(account.bic || account.bankName
            ? [{ label: form().bankName, value: [account.bankName, account.bic].filter(Boolean).join(" · ") }]
            : []),
          ...(account.note ? [{ label: form().note, value: account.note }] : []),
        ];
        const keyDetailItems = (): FactGroupItem[] => [
          {
            label: t().name,
            value: [c().firstName, c().lastName].filter(Boolean).join(" ") || resolveContactName(c(), t().unnamedContact),
          },
          ...(c().companyName ? [{ label: t().company, value: c().companyName }] : []),
          ...(c().jobTitle ? [{ label: t().jobTitle, value: c().jobTitle }] : []),
          { label: t().book, value: props.bookNames[c().bookId] ?? c().bookId },
          ...(c().tags.length > 0
            ? [
                {
                  label: t().tags,
                  value: (
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
        const orgTreeFeedback = (
          <Show when={actions.orgTreeLoading() || actions.orgTreeError()}>
            <div class="h-16 shrink-0 overflow-y-auto">
              <Show when={actions.orgTreeError()} fallback={<InlineGuidance loading>{t().loadingOrganization}</InlineGuidance>}>
                {(error) => (
                  <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
                    {error().message}{" "}
                    <Button variant="text" size="xs" onClick={() => void actions.retryOrgTree()}>
                      {t().retry}
                    </Button>
                  </InlineGuidance>
                )}
              </Show>
            </div>
          </Show>
        );
        const closeAddressEditor = (updated?: Contact) => {
          setSelectedContactInUrl({
            contactId: c().id,
            bookId: c().bookId,
            contact: updated ?? c(),
            history: "replace",
          });
        };
        return (
          <Show
            when={addressId()}
            fallback={
              <Show
                when={detailMode() === "tree" && actions.orgTree()}
                fallback={
                  <article class="contacts-reader" data-scroll-preserve="contacts-detail" data-print-region>
                    <DetailPanel.Header
                      leading={<Avatar name={resolveContactName(c(), t().unnamedContact)} size="sm" />}
                      title={resolveContactName(c(), t().unnamedContact)}
                      subtitle={[c().jobTitle, c().companyName].filter(Boolean).join(" · ")}
                      primaryActions={
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
                            <Show
                              when={framedReach() < 2}
                              fallback={
                                <IconButton
                                  size="sm"
                                  label={t().editAddress}
                                  tooltip={t().editAddress}
                                  onClick={() => actions.openEditDialog(c())}
                                >
                                  <i class="ti ti-pencil" aria-hidden="true" />
                                </IconButton>
                              }
                            >
                              <Button variant="secondary" size="sm" onClick={() => actions.openEditDialog(c())}>
                                <i class="ti ti-pencil" aria-hidden="true" /> {t().editAddress}
                              </Button>
                            </Show>
                          </Show>
                        </nav>
                      }
                      menu={[
                        ...(actions.canEdit()
                          ? [{ label: t().comment, icon: "ti ti-message", action: () => requestContactNoteComposer(c().id) }]
                          : []),
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
                        ...cloudId.section({ type: "contacts.contact", id: c().id }),
                      ]}
                      menuLabel={t().moreContactActions}
                      actions={
                        <>
                          <ContactFavoriteButton size="sm" bookId={c().bookId} contactId={c().id} initialFavorite={selectedFavorite()} />
                          <IconButton size="sm" label={t().closeDetailPanel} onClick={() => clearSelectedContactInUrl()}>
                            <i class="ti ti-x" aria-hidden="true" />
                          </IconButton>
                        </>
                      }
                    />

                    {/* K17: the topics, and the facts beside them in a quiet column; under 50rem they stand one below
                        the other, topics first. The record draws the line between the two, the topics' column divides
                        its topics (K2, one line, one owner). */}
                    <div class="contacts-record">
                      <div class="contacts-record__topics k2b-divided">
                        <Show when={c().addresses.length > 0}>
                          <div>
                            <Section title={t().addresses} icon="ti ti-map-pin" iconColor={CONTACT_AREA_COLOR} size="md">
                              <div class="flex flex-col gap-3">
                                <For each={c().addresses}>
                                  {(address) => (
                                    <div class="py-1">
                                      <div class="flex items-start gap-3 text-sm text-primary">
                                        <i class="ti ti-map-pin mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
                                        <div class="min-w-0 flex-1">
                                          <Show when={address.label}>
                                            <p class="text-xs text-dimmed">{address.label}</p>
                                          </Show>
                                          <For each={formatAddress(address)}>{(line) => <p class="leading-snug">{line}</p>}</For>
                                        </div>
                                      </div>
                                      <ContactAddressMap
                                        bookId={c().bookId}
                                        contactId={c().id}
                                        contactName={resolveContactName(c(), t().unnamedContact)}
                                        address={address}
                                        availability={props.geoAvailability}
                                        timeZone={props.timeZone}
                                        canEdit={actions.canEdit()}
                                        onEdit={() => void actions.openAddressEditor(c(), address.id)}
                                      />
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Section>
                          </div>
                        </Show>
                        <Show when={hasOrganization()}>
                          <div>
                            <Section
                              size="md"
                              title={t().relationships}
                              iconColor={RELATION_AREA_COLOR}
                              icon="ti ti-sitemap"
                              actions={
                                <>
                                  <Show when={hasOrgTree()}>
                                    <Button
                                      variant="ghost"
                                      size="xs"
                                      loading={actions.orgTreeLoading()}
                                      onClick={() => actions.openOrgTree(c())}
                                    >
                                      <i class="ti ti-hierarchy" aria-hidden="true" /> {t().tree}
                                    </Button>
                                  </Show>
                                  <Show when={actions.canEdit()}>
                                    <Button variant="ghost" size="xs" onClick={() => actions.openAddMemberDialog(c())}>
                                      <i class="ti ti-plus" aria-hidden="true" /> {t().addMember}
                                    </Button>
                                  </Show>
                                </>
                              }
                            >
                              {orgTreeFeedback}
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
                                        <li class="k2b-progressive-row flex items-center gap-1">
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
                                                {(resolveContactName(member as ContactRef, t().unnamedContact) || "?")
                                                  .charAt(0)
                                                  .toUpperCase()}
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
                                                class="k2b-progressive-action shrink-0 text-dimmed hover:text-red-500"
                                                label={t().removeMemberLabel({
                                                  name: resolveContactName(member as ContactRef, t().unnamedContact),
                                                })}
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
                                  <p class="py-1 text-sm text-dimmed">{t().noHierarchyYet}</p>
                                </Show>
                              </div>
                            </Section>
                          </div>
                        </Show>
                        <div>
                          <Show when={`${c().bookId}:${c().id}`} keyed>
                            {(_contactKey) => (
                              <ContactNotesSection
                                bookId={c().bookId}
                                contactId={c().id}
                                currentUserId={props.currentUserId}
                                initialNotesPage={
                                  c().id === props.initialContactId && c().bookId === props.initialBookId
                                    ? props.initialNotesPage
                                    : undefined
                                }
                                canWrite={actions.canEdit()}
                              />
                            )}
                          </Show>
                        </div>
                        <Show when={accessShown()}>
                          <div>
                            <DetailAccess
                              entries={accessMemberEntries(accessCache().get(c().bookId) ?? [], {
                                currentUserId: props.currentUserId,
                                locale: locale(),
                              })}
                              state={accessState(c().bookId)}
                              onRetry={() => reloadAccess(c().bookId)}
                              note={t().accessWholeBook}
                              manage={
                                props.adminBookIds.includes(c().bookId)
                                  ? { label: t().manageAccess, onClick: () => void openBookAccess(c().bookId) }
                                  : undefined
                              }
                            />
                          </div>
                        </Show>
                      </div>

                      <div class="contacts-record__facts">
                        <Section size="sm" frame="none" level={2} title={t().details} icon="ti ti-id">
                          <div class="contacts-record__groups">
                            <Show when={hasReach()}>
                              <FactGroup
                                title={t().reach}
                                icon="ti ti-address-book"
                                items={reachItems()}
                                onEdit={actions.canEdit() ? () => actions.openEditDialog(c()) : undefined}
                              />
                            </Show>
                            <Show
                              when={quickEditing()}
                              fallback={
                                <FactGroup
                                  title={t().properties}
                                  icon="ti ti-list-details"
                                  items={keyDetailItems()}
                                  onEdit={actions.canEdit() ? () => setQuickEditing(true) : undefined}
                                />
                              }
                            >
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
                            <Show when={hasPersonal()}>
                              <FactGroup
                                title={t().personal}
                                icon="ti ti-user"
                                items={personalItems()}
                                onEdit={actions.canEdit() ? () => actions.openEditDialog(c()) : undefined}
                              />
                            </Show>
                            <Show when={hasWork()}>
                              <FactGroup
                                title={t().work}
                                icon="ti ti-briefcase"
                                items={workItems()}
                                onEdit={actions.canEdit() ? () => actions.openEditDialog(c()) : undefined}
                              />
                            </Show>
                            <For each={c().bankAccounts}>
                              {(account) => (
                                <FactGroup
                                  title={account.label ?? t().bankDetails}
                                  icon="ti ti-building-bank"
                                  items={bankItems(account)}
                                  onEdit={actions.canEdit() ? () => actions.openEditDialog(c()) : undefined}
                                />
                              )}
                            </For>
                          </div>
                        </Section>
                      </div>
                    </div>
                  </article>
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
            }
          >
            {(selectedAddressId) => (
              <Show
                when={actions.canEdit() && c().addresses.some((address) => address.id === selectedAddressId())}
                fallback={
                  <DetailPanel class="contacts-address-editor-unavailable">
                    <DetailPanel.Header title={t().addressUnavailableTitle} />
                    <DetailPanel.Body>
                      <InlineGuidance role="alert">{t().addressUnavailableDescription}</InlineGuidance>
                      <Button variant="secondary" onClick={() => closeAddressEditor()} data-workspace-detail-close="">
                        {t().backToContact}
                      </Button>
                    </DetailPanel.Body>
                  </DetailPanel>
                }
              >
                <Show when={`${c().bookId}:${c().id}:${selectedAddressId()}`} keyed>
                  {(_addressKey) => (
                    <ContactAddressEditor
                      contact={c()}
                      addressId={selectedAddressId()}
                      geoAvailability={props.geoAvailability}
                      onCancel={() => closeAddressEditor()}
                      onSaved={(updated) => closeAddressEditor(updated)}
                      onReload={() => {
                        const url = new URL(window.location.href);
                        url.searchParams.delete("address");
                        documentNavigate(`${url.pathname}${url.search}`, { replace: true });
                      }}
                    />
                  )}
                </Show>
              </Show>
            )}
          </Show>
        );
      }}
    </Show>
  );
}
