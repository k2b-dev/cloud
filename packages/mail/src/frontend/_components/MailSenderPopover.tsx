import { importOnDemand } from "@k2b/cloud/browser/reload";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation, query } from "@k2b/stdlib/solid";
import { PersonPopover, type PersonPopoverAction, prompts, useLocale } from "@k2b/ui";
import { createMemo, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import { canCreateDirectoryContacts } from "../../contact-directory";
import { readApiError } from "./api-response";
import type { SenderAction } from "./MailSenderMessageActions";
import { useMailContactDirectory } from "./mail-contact-directory-context";
import { createRetryToasts } from "./mail-feedback";
import { mailReaderMessages } from "./mail-reader-messages";
import { mailRemainingMessages } from "./mail-remaining-messages";

const SENDER_ACTION_ORDER: readonly SenderAction["id"][] = ["find", "unsubscribe"];

/**
 * The card a click on a message's sender opens (Mail v5): the contact through the platform's contact directory, the
 * sender's earlier conversations in this mailbox, and what Mail can do about the sender. Without a directory, or
 * without a match, the card shows the address and Mail's own entries.
 */
export default function MailSenderPopover(props: {
  anchor: HTMLElement | null;
  onClose: () => void;
  mailboxId: string;
  conversationId: string | null;
  sender: { name: string | null; address: string };
  dateConfig: DateContext;
  actions: readonly SenderAction[];
  /** People with mailbox-wide access see the sender's earlier conversations. */
  showHistory: boolean;
  canWrite: boolean;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailReaderMessages.resolve([locale()]).t);
  const remaining = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const directory = useMailContactDirectory();
  const retryToast = createRetryToasts();
  let mounted = true;
  onCleanup(() => {
    mounted = false;
  });
  const open = () => props.anchor !== null;
  const address = () => props.sender.address.trim().toLowerCase();

  const contact = query.create<string, Awaited<ReturnType<typeof resolve>>>({
    source: address,
    enabled: () => open() && directory.resolve !== null,
    load: (email, { abortSignal }) => resolve(email, abortSignal),
  });
  async function resolve(email: string, signal: AbortSignal) {
    const capabilities = await importOnDemand(() => import("./contact-capabilities"));
    if (!capabilities) throw new DOMException("Contact code unavailable", "AbortError");
    const result = await capabilities.resolveContacts(directory.resolve, { emails: [email], limit: 1 }, signal);
    return result.data.items[0] ?? null;
  }
  const history = query.create<readonly [string, string, string], Awaited<ReturnType<typeof loadHistory>>>({
    source: () => [props.mailboxId, address(), props.conversationId ?? ""] as const,
    enabled: () => open() && props.showHistory,
    load: ([mailboxId, email, conversationId], { abortSignal }) => loadHistory(mailboxId, email, conversationId, abortSignal),
  });
  async function loadHistory(mailboxId: string, email: string, conversationId: string, signal: AbortSignal) {
    const response = await apiClient.mailboxes[":mailboxId"]["sender-conversations"].$get(
      { param: { mailboxId }, query: { email, limit: "5", ...(conversationId ? { excludeConversationId: conversationId } : {}) } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, t().earlierConversationsFailed));
    return response.json();
  }

  const match = () => contact.data() ?? null;
  const openHref = () => match()?.links?.find((link) => link.rel === "open")?.href;
  const canAddContact = () =>
    props.canWrite &&
    canCreateDirectoryContacts(directory) &&
    directory.resolve !== null &&
    !contact.loading() &&
    !contact.error() &&
    !match();

  // The idempotency key belongs to the intent, so Retry repeats the same creation instead of adding a second contact.
  type ContactIntent = { email: string; name: string | null; book: { id: string }; idempotencyKey: string };
  const createContact = mutation.create<void, ContactIntent, { intent: ContactIntent }>({
    onBefore: (intent) => ({ intent }),
    mutation: async ({ email, name, book, idempotencyKey }, { abortSignal }) => {
      const capabilities = await importOnDemand(() => import("./contact-capabilities"));
      if (!capabilities) throw new DOMException("Contact code unavailable", "AbortError");
      await capabilities.createContact(
        directory.create,
        { bookId: book.id, label: name || email, emails: [{ label: remaining().email, email }] },
        idempotencyKey,
        abortSignal,
      );
      if (mounted) await contact.refresh().catch(() => undefined);
    },
    onError: (error, context) =>
      retryToast(error.message, {
        title: remaining().couldNotCreateContact,
        retryLabel: remaining().retry,
        retry: () => context && createContact.mutate(context.intent),
      }),
  });
  onCleanup(() => createContact.abort());
  const addContact = async () => {
    if (createContact.loading()) return;
    const email = address();
    const name = props.sender.name;
    const capabilities = await importOnDemand(() => import("./contact-capabilities"));
    if (!capabilities || !mounted) return;
    const book = await prompts.search<{ id: string }>(
      async ({ query: text, abortSignal }) => {
        const result = await capabilities.listWritableContactBooks(
          directory.listWritableBooks,
          { query: text.trim() || undefined, limit: 25 },
          abortSignal,
        );
        return result.data.map((entry) => ({
          id: entry.id,
          value: { id: entry.id },
          label: entry.name,
          desc: entry.description ?? undefined,
          icon: "ti ti-address-book",
        }));
      },
      {
        title: remaining().chooseContactBook,
        icon: "ti ti-address-book",
        placeholder: remaining().searchWritableContactBooks,
        minQueryLength: 0,
        noResultsText: remaining().noWritableContactBooks,
        size: "small",
      },
    );
    if (!book?.value || !mounted) return;
    await createContact.mutate({ email, name, book: book.value, idempotencyKey: crypto.randomUUID() });
  };

  const actions = createMemo<PersonPopoverAction[]>(() => {
    const own = [...props.actions].sort((left, right) => SENDER_ACTION_ORDER.indexOf(left.id) - SENDER_ACTION_ORDER.indexOf(right.id));
    const label = (action: SenderAction) => (action.id === "find" ? t().allFromSender : t().manageUnsubscribe);
    const find = own.find((action) => action.id === "find");
    const rest = own.filter((action) => action.id !== "find");
    const entry = (action: SenderAction): PersonPopoverAction => ({
      label: label(action),
      icon: action.icon,
      ...(action.href ? { href: action.href } : { onSelect: action.action }),
    });
    return [
      ...(find ? [entry(find)] : []),
      ...(openHref() ? [{ label: t().openContact, icon: "ti ti-address-book", href: openHref()! }] : []),
      ...(canAddContact()
        ? [{ label: t().addContact, icon: "ti ti-user-plus", disabled: createContact.loading(), onSelect: () => void addContact() }]
        : []),
      ...rest.map(entry),
    ];
  });

  const detail = () => {
    const current = match();
    // A failed lookup replaces the contact rows; the address from the message still names who wrote.
    if (contact.error()) return props.sender.address;
    if (!current) return undefined;
    return [current.companyName, current.jobTitle].filter(Boolean).join(" · ") || current.bookName;
  };

  return (
    <PersonPopover
      anchor={props.anchor}
      onClose={props.onClose}
      label={t().senderCard({ name: props.sender.name || props.sender.address })}
      name={match()?.displayName ?? props.sender.name ?? undefined}
      email={props.sender.address}
      detail={detail()}
      phones={match()?.phones.map((phone) => ({ number: phone.phone, label: phone.label ?? undefined })) ?? []}
      loading={contact.loading()}
      error={contact.error() ? { message: t().contactFailed, onRetry: () => void contact.refresh() } : undefined}
      list={
        props.showHistory
          ? {
              title: t().earlierConversations,
              loading: history.loading(),
              error: history.error() ? { message: t().earlierConversationsFailed, onRetry: () => void history.refresh() } : undefined,
              empty: t().noEarlierConversations,
              items: (history.data()?.items ?? []).map((item) => ({
                label: item.subject.trim() || remaining().noSubject,
                meta: dates.formatDateTimeRelative(item.latestMessageAt, props.dateConfig),
                href: `/app/mail/${encodeURIComponent(props.mailboxId)}?conversation=${encodeURIComponent(item.id)}`,
              })),
            }
          : undefined
      }
      actions={actions()}
      width="22rem"
    />
  );
}
