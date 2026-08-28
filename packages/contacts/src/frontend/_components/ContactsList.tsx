import { Placeholder, Tag, Tooltip, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Contact } from "../../service";
import { resolveContactInitials, resolveContactName } from "../../shared";
import ContactFavoriteButton from "./ContactFavoriteButton";
import { createContactFavoriteProjection, listenForContactFavoriteChanges } from "./contacts-favorites";
import { buildContactDetailHref } from "./contacts-search";
import {
  CONTACT_DETAIL_EVENT,
  type ContactDetailPayload,
  getSelectedContactFromUrl,
  setSelectedContactInUrl,
  shouldHandleContactDetailClick,
} from "./context";
import { resultsMessages } from "./results-messages";

type Props = {
  contacts: Contact[];
  bookNames?: Record<string, string>;
  showBookNames?: boolean;
  initialSelectedContactId: string | null;
  initialSelectedBookId: string | null;
  emptyTitle?: string;
  emptyDescription?: string;
  detailBaseHref: string;
  initialFavoriteKeys: string[];
  selectionMode?: boolean;
  selectedIds?: string[];
  onToggleSelection?: (contactId: string) => void;
};

const contactKey = (contactId: string | null, bookId: string | null) => (contactId && bookId ? `${bookId}:${contactId}` : null);
const primaryEmail = (contact: Contact) => contact.emails[0]?.email ?? null;
const primaryPhone = (contact: Contact) => contact.phones[0]?.phone ?? null;

const contactContext = (contact: Contact) => {
  const parts = [contact.jobTitle, contact.companyName].filter(Boolean) as string[];
  return [...new Set(parts)].join(" · ");
};

export default function ContactsList(props: Props) {
  const locale = useLocale();
  const t = () => resultsMessages.resolve([locale()]).t;
  const [selectedKey, setSelectedKey] = createSignal<string | null>(
    contactKey(props.initialSelectedContactId, props.initialSelectedBookId),
  );
  const favoriteProjection = createContactFavoriteProjection(() => props.initialFavoriteKeys);

  const selectContact = (contact: Contact) => {
    setSelectedKey(contactKey(contact.id, contact.bookId));
    setSelectedContactInUrl({
      contactId: contact.id,
      bookId: contact.bookId,
      contact,
      favorite: favoriteProjection.favoriteFor(contact),
    });
  };

  onMount(() => {
    const handleDetailEvent = (event: Event) => {
      const payload = (event as CustomEvent<ContactDetailPayload>).detail;
      setSelectedKey(contactKey(payload.itemKey, payload.bookId));
    };

    const handlePopState = () => {
      const selected = getSelectedContactFromUrl();
      setSelectedKey(contactKey(selected.contactId, selected.bookId));
    };
    const stopFavoriteChanges = listenForContactFavoriteChanges(favoriteProjection.apply);

    window.addEventListener(CONTACT_DETAIL_EVENT, handleDetailEvent);
    window.addEventListener("popstate", handlePopState);

    onCleanup(() => {
      stopFavoriteChanges();
      window.removeEventListener(CONTACT_DETAIL_EVENT, handleDetailEvent);
      window.removeEventListener("popstate", handlePopState);
    });
  });

  let listRef: HTMLUListElement | undefined;
  const moveFocus = (event: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (!(event.target instanceof HTMLAnchorElement) || !event.target.matches("a[data-contact-row]")) return;
    const rows = Array.from(listRef?.querySelectorAll<HTMLAnchorElement>("a[data-contact-row]") ?? []);
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLAnchorElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowUp" ? -1 : 1)));
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <Show
      when={props.contacts.length > 0}
      fallback={
        <Placeholder
          icon="ti ti-address-book"
          title={props.emptyTitle ?? t().noContacts}
          description={props.emptyDescription ?? t().noContactsInView}
          variant="panel"
          class="h-full min-h-56 justify-center"
        />
      }
    >
      <ul
        ref={listRef}
        class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-1.5"
        aria-label={t().contactsListLabel}
        onKeyDown={moveFocus}
      >
        <For each={props.contacts}>
          {(contact) => {
            const name = () => resolveContactName(contact, t().unnamedContact);
            const email = () => primaryEmail(contact);
            const phone = () => primaryPhone(contact);
            const context = () => contactContext(contact);
            const isSelected = () => selectedKey() === contactKey(contact.id, contact.bookId);
            const visibleTags = () => contact.tags.slice(0, 2);
            const hiddenTagCount = () => Math.max(0, contact.tags.length - visibleTags().length);
            const isChecked = () => props.selectedIds?.includes(contact.id) ?? false;

            return (
              <li class="group/contact relative">
                <Show when={props.selectionMode}>
                  <label class="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      class="h-4 w-4"
                      checked={isChecked()}
                      aria-label={t().selectContact({ name: name() })}
                      onChange={() => props.onToggleSelection?.(contact.id)}
                    />
                  </label>
                </Show>
                <a
                  href={buildContactDetailHref(props.detailBaseHref, contact.id, contact.bookId)}
                  class="flex w-full min-w-0 items-center gap-3 rounded-[var(--ui-radius-control)] py-2.5 pl-3 pr-[3rem] text-left focus-ui [@media(min-width:640px)]:pr-[7rem]"
                  classList={{ "pl-10": props.selectionMode }}
                  aria-label={t().openContact({ name: name() })}
                  aria-current={isSelected() ? "true" : undefined}
                  data-contact-row
                  onClick={(event) => {
                    if (!shouldHandleContactDetailClick(event)) return;
                    event.preventDefault();
                    selectContact(contact);
                  }}
                >
                  <span
                    class="contact-avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold [outline:2px_solid_transparent] outline-offset-2 transition-[outline-color]"
                    classList={{ "[outline-color:var(--ui-app-accent-border)]": isSelected() }}
                    aria-hidden="true"
                  >
                    {resolveContactInitials(contact)}
                  </span>

                  <span class="min-w-0 flex-1">
                    <span class="flex min-w-0 items-center gap-2">
                      <span
                        class="truncate text-sm font-medium transition-colors group-hover/contact:text-[var(--ui-app-accent-text)] group-focus-within/contact:text-[var(--ui-app-accent-text)]"
                        classList={{ "app-accent-text": isSelected(), "text-primary": !isSelected() }}
                      >
                        {name()}
                      </span>
                      <Show when={props.showBookNames && props.bookNames?.[contact.bookId]}>
                        <span class="hidden max-w-36 shrink-0 truncate rounded-full bg-[var(--ui-surface-muted)] px-1.5 py-0.5 text-[11px] text-dimmed md:inline-flex">
                          {props.bookNames?.[contact.bookId]}
                        </span>
                      </Show>
                    </span>

                    <span class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-dimmed">
                      <Show when={context()}>
                        <span class="truncate">{context()}</span>
                      </Show>
                      <Show when={contact.parent}>
                        {(parent) => (
                          <span
                            class="inline-flex min-w-0 items-center gap-1 truncate"
                            title={t().partOf({ name: resolveContactName(parent(), t().unnamedContact) })}
                          >
                            <i class="ti ti-corner-down-right shrink-0 text-[11px]" />
                            <span class="truncate">{resolveContactName(parent(), t().unnamedContact)}</span>
                          </span>
                        )}
                      </Show>
                      <For each={visibleTags()}>
                        {(tag) => (
                          <Tag color={tag.color} icon="ti ti-point">
                            {tag.name}
                          </Tag>
                        )}
                      </For>
                      <Show when={hiddenTagCount() > 0}>
                        <span class="text-[11px] tabular-nums">+{hiddenTagCount()}</span>
                      </Show>
                    </span>
                  </span>

                  <span class="hidden w-52 shrink-0 flex-col items-end gap-0.5 text-xs text-dimmed xl:flex">
                    <Show when={email()}>
                      <span class="max-w-full truncate" title={email() ?? undefined}>
                        {email()}
                      </span>
                    </Show>
                    <Show when={phone()}>
                      <span class="max-w-full truncate tabular-nums" title={phone() ?? undefined}>
                        {phone()}
                      </span>
                    </Show>
                  </span>
                </a>

                <span class="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 sm:right-4">
                  <Show when={phone()}>
                    {(number) => (
                      <Tooltip.Anchor content={t().callContact({ name: name() })}>
                        <a
                          href={`tel:${number()}`}
                          class="focus-ui hidden h-7 w-7 items-center justify-center rounded text-dimmed hover:bg-[var(--ui-hover)] hover:text-primary sm:flex"
                          aria-label={t().callContact({ name: name() })}
                        >
                          <i class="ti ti-phone text-sm" />
                        </a>
                      </Tooltip.Anchor>
                    )}
                  </Show>
                  <Show when={email()}>
                    {(address) => (
                      <Tooltip.Anchor content={t().emailContact({ name: name() })}>
                        <a
                          href={`mailto:${address()}`}
                          class="focus-ui hidden h-7 w-7 items-center justify-center rounded text-dimmed hover:bg-[var(--ui-hover)] hover:text-primary sm:flex"
                          aria-label={t().emailContact({ name: name() })}
                        >
                          <i class="ti ti-mail text-sm" />
                        </a>
                      </Tooltip.Anchor>
                    )}
                  </Show>
                  <ContactFavoriteButton
                    bookId={contact.bookId}
                    contactId={contact.id}
                    initialFavorite={favoriteProjection.favoriteFor(contact)}
                    class="focus-ui flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--ui-hover)]"
                  />
                </span>
              </li>
            );
          }}
        </For>
      </ul>
    </Show>
  );
}
