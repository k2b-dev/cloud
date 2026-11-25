import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { DateContext } from "@k2b/stdlib";
import { type DropdownAction, type DropdownItem, toast, useLocale } from "@k2b/ui";
import type { MenuEntry, MenuItem } from "@k2b/ui/v2";
import { createComponent, createMemo, onCleanup } from "solid-js";
import type { MailboxController } from "../../mail-workspace";
import { useMailCloudId } from "../mail-cloud-id";
import { createMailConversationLinks } from "../mail-conversation-links";
import { type MailRespondIntent, mailActionLabel, mailConversationMenuItems } from "../mail-conversation-menu";
import { createMailConversationState } from "../mail-conversation-state";
import { mailConversationUiMessages } from "../mail-conversation-ui-messages";
import { mailReaderMessages } from "../mail-reader-messages";
import { createMailSummaryEdit } from "../mail-summary-edit";
import { MailV2TimePicker } from "./MailV2TimePicker";
import { mailV2LaterTimes, mailV2TimeZone } from "./mail-v2-later";
import { mailV2MenuEntries } from "./mail-v2-menu";
import { mailV2Messages } from "./mail-v2-messages";

/**
 * The menus of the open conversation in Mail's v2 pilot: "Later" and "…" of the reader's head. They are v1's menus,
 * built by the same shared parts (`mailConversationMenuItems`, the conversation's state and links) with the same
 * controller actions, so both readers offer the same. Answers (reply, reply all, forward) belong to the reply and join
 * when it is rebuilt on v2; printing joins with a v2 print view.
 */
export function createMailV2ReaderMenus(props: {
  controller: () => MailboxController;
  dateConfig: DateContext;
  /** The open conversation's reply: Reply, Reply all and Forward of "…" answer in it. */
  reply?: () => { respond: (intent: MailRespondIntent) => void; canReplyAll: () => boolean } | null;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const readerText = createMemo(() => mailReaderMessages.resolve([locale()]).t);
  const v2Text = createMemo(() => mailV2Messages.resolve([locale()]).t);
  const c = () => props.controller();
  const data = () => c().data;
  const cloudId = useMailCloudId();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  // The summary's "Bearbeiten" and the entry of "…" write it through v1's form, save and Retry.
  const summary = createMailSummaryEdit({
    mailboxId: () => data().mailbox.id,
    conversationId: () => data().selectedConversationId,
    summary: () => data().conversationSummary,
    onSaved: () => c().applySavedConversationSummary,
  });

  const conversationState = createMailConversationState({
    mailboxId: () => data().mailbox.id,
    conversationId: () => data().selectedConversationId,
    collaboration: () => (c().hasSelection() ? data().collaborationState : null),
    reminder: () => data().reminder,
    assignableUsers: () => data().assignableUsers,
    onCollaborationChange: (state) => c().applyCollaborationState(state),
    onReconcile: () => c().reconcileWorkspace(),
  });
  const links = createMailConversationLinks({
    mailboxId: () => data().mailbox.id,
    conversationId: () => data().selectedConversationId,
    requestUrl: () => c().requestPath(),
    subject: () => data().selectedSubject,
    enabled: () => !c().assignedOnly(),
    canWrite: () => c().canWrite(),
  });

  const snoozedUntil = () => conversationState.state()?.snoozedUntil ?? null;
  const workStatus = () => c().selectedWorkStatus();
  const collaboration = () => (c().hasSelection() ? data().collaborationState : null);

  /**
   * A submenu of times for "Später anzeigen" and "Erinnere mich": the offered times, then "Datum und Uhrzeit …" with
   * the calendar to the side (on the phone the sheet's next step). The entries read it when the submenu opens, so the
   * times are those of that moment (a menu opened after 17:00 no longer offers today). A time that has passed since is
   * not sent, and one picked after another conversation opened is dropped: it was offered for the one before.
   */
  const timeItems = (label: string, current: string | null, choose: (at: string) => void): MenuEntry[] => {
    const conversationId = data().selectedConversationId;
    const pick = (at: string) => {
      if (disposed || conversationId !== data().selectedConversationId) return;
      if (Date.parse(at) <= Date.now()) return void toast.error(v2Text().laterPast);
      choose(at);
    };
    return [
      ...mailV2LaterTimes(props.dateConfig, v2Text(), Date.now()).map(
        (time): MenuItem => ({ label: time.label, ...(time.meta ? { meta: time.meta } : {}), onClick: () => pick(time.at) }),
      ),
      "separator",
      {
        label: v2Text().laterPick,
        panel: (close) =>
          createComponent(MailV2TimePicker, {
            label,
            timeZone: mailV2TimeZone(props.dateConfig),
            current,
            pastError: v2Text().laterPast,
            onPick: (at) => {
              close();
              pick(at);
            },
          }),
      },
    ];
  };
  const showLaterItem = (disabled: boolean): MenuItem => ({
    label: v2Text().showLater,
    icon: "clock",
    ...(disabled ? { disabled } : {}),
    get items() {
      return timeItems(readerText().laterField, snoozedUntil(), (at) => conversationState.snooze(at));
    },
  });

  // "Later" as in v1's reader: the conversation comes back at a time for everyone; the reminder reaches only you.
  const laterItems = (): MenuEntry[] => {
    const until = snoozedUntil() && Date.parse(snoozedUntil()!) > Date.now() ? snoozedUntil() : null;
    return [
      ...(c().canWrite() && collaboration()
        ? [
            showLaterItem(workStatus() === "done"),
            ...(until ? [{ label: readerText().showNow, icon: "clock-off", onClick: () => conversationState.snooze(null) }] : []),
            "separator" as const,
          ]
        : []),
      {
        label: conversationState.reminderDueAt() ? v2Text().changeReminder : v2Text().remindMe,
        icon: "bell",
        get items() {
          return timeItems(readerText().reminderField, conversationState.reminderDueAt(), (at) => conversationState.setReminder(at));
        },
      },
      ...(conversationState.reminderDueAt()
        ? [{ label: readerText().removeReminder, icon: "bell-off", onClick: () => conversationState.setReminder(null) }]
        : []),
    ];
  };

  const linkItems = (): DropdownAction[] =>
    links.canLink()
      ? [
          { label: readerText().createTask, icon: "ti ti-checkbox", action: () => void links.create("task") },
          { label: readerText().createEvent, icon: "ti ti-calendar-event", action: () => void links.create("event") },
          { label: readerText().linkExisting, icon: "ti ti-link-plus", action: () => void links.linkExisting() },
          ...links.items().map((item) => ({
            label: readerText().unlinkNamed({ name: item.title }),
            icon: "ti ti-unlink",
            action: () => void links.unlink(item.id),
          })),
        ]
      : [];
  const keepItem = (): DropdownAction[] => {
    const keep = data().keep;
    const pending = c().structurePending();
    // Only a Cloud administrator can stop keeping; everyone else sees no dead action.
    if (keep)
      return keep.canLift
        ? [{ label: t().stopKeeping, icon: "ti ti-lock-open", disabled: pending, action: () => void c().setConversationKept(false) }]
        : [];
    return c().canWrite()
      ? [{ label: t().keep, icon: "ti ti-lock", disabled: pending, action: () => void c().setConversationKept(true) }]
      : [];
  };
  const showActivity = async () =>
    void (await importOnDemand(() => import("../MailActivityDialog")))?.openMailActivityDialog({
      activity: c().conversationActivity(),
      unavailable: Boolean(data().detailErrors?.activity),
      onRetry: () => void c().reconcileWorkspace(),
      dateConfig: props.dateConfig,
      locale: locale(),
    });
  const copyReference = () => {
    const reference = data().selectedReference;
    if (!reference) return;
    void navigator.clipboard.writeText(reference).then(
      () => toast.success(t().referenceCopied),
      () => toast.error(t().referenceCopyFailed, { title: v2Text().notCopied }),
    );
  };
  const latest = () => data().detailMessages.at(-1);
  const emlItem = (): DropdownAction[] => {
    const message = latest();
    return message?.sourceAvailable
      ? [{ label: t().downloadEml, icon: "ti ti-download", href: `/api/mail/mailboxes/${data().mailbox.id}/messages/${message.id}/source` }]
      : [];
  };
  const canSplit = () => {
    const count = c().selectedListItem()?.messageCount ?? data().detailMessages.length;
    return c().canWrite() && !c().assignedOnly() && (count > 1 || data().detailMessages.length > 1);
  };

  /**
   * "…" holds the rare deeds (design guide): what the head shows as a button (Done, Later, Assign, Archive, Delete)
   * stays out of it, except on the phone, where the head keeps only its "…" and those buttons give way.
   */
  const headButtonsShown = () => typeof window === "undefined" || !window.matchMedia("(max-width: 767px)").matches;
  const headActionLabels = () => new Set([mailActionLabel(t(), "archive"), mailActionLabel(t(), "trash")]);

  const moreItems = (): DropdownItem[] => {
    const assignment = headButtonsShown() ? null : c().assignment();
    const status = headButtonsShown() ? null : workStatus();
    const reply = props.reply?.();
    const items = mailConversationMenuItems({
      t: t(),
      ...(reply ? { respond: { replyAll: reply.canReplyAll(), run: (intent) => reply.respond(intent) } } : {}),
      ...(c().canWrite()
        ? {
            ...(assignment
              ? {
                  assignToMe: {
                    assigned: assignment.assigned,
                    others: assignment.others,
                    disabled: c().assignToMe.loading(),
                    run: () => void c().assignOpenConversationToMe(),
                  },
                }
              : {}),
            ...(status
              ? {
                  completion: {
                    done: status === "done",
                    disabled: c().completion.loading(),
                    run: () => c().setOpenConversationCompletion(status === "done" ? "open" : "done"),
                  },
                }
              : {}),
            followUp: [
              ...(assignment
                ? [
                    {
                      label: readerText().assign,
                      icon: "ti ti-user-plus",
                      disabled: c().structureMutationLoading(),
                      action: () => void c().assignOpenConversation(),
                    },
                  ]
                : []),
              // its times come in `more` below, as the head's "Später" offers them
              ...(collaboration() && !headButtonsShown()
                ? [{ label: readerText().showLater, icon: "ti ti-clock", disabled: status === "done", action: () => undefined }]
                : []),
            ],
            organize: {
              unread: c().selectedUnread(),
              flagged: c().selectedFlagged(),
              spamAction: c().selectedInJunk() ? ("not_spam" as const) : ("junk" as const),
              kept: Boolean(data().keep),
              disabled: c().structureMutationLoading(),
              tagsDisabled: c().structurePending(),
              run: (actionId) => void c().runAction(actionId),
              manageTags: () => {
                const open = c().selectedListItem();
                if (open) void c().manageConversationTags(open);
              },
            },
            conversation: [
              ...(!c().assignedOnly() && links.state() === "error"
                ? [{ label: readerText().linkedRetry, icon: "ti ti-refresh", action: () => void links.retry() }]
                : []),
              ...(data().conversationSummary
                ? [
                    {
                      label: data().conversationSummary?.summary ? t().editSummary : t().createSummary,
                      icon: "ti ti-notes",
                      disabled: summary.saving(),
                      action: () => void summary.edit(),
                    },
                  ]
                : []),
              ...(!c().assignedOnly()
                ? [
                    {
                      label: t().mergeWithConversation,
                      icon: "ti ti-git-merge",
                      disabled: c().structurePending(),
                      action: () => void c().mergeSelectedConversation(),
                    },
                  ]
                : []),
              ...(canSplit() && latest()
                ? [
                    {
                      label: v2Text().splitLatest,
                      icon: "ti ti-arrows-split-2",
                      disabled: c().structurePending(),
                      action: () => {
                        const message = latest();
                        if (message) void c().splitMessage(message.id);
                      },
                    },
                  ]
                : []),
              ...keepItem(),
            ],
            link: linkItems(),
          }
        : {}),
      other: [
        { label: readerText().showActivity, icon: "ti ti-activity", action: () => void showActivity() },
        ...(data().selectedReference ? [{ label: t().copyReference, icon: "ti ti-hash", immediate: true, action: copyReference }] : []),
        ...emlItem(),
        ...cloudId.actions({ conversationId: data().selectedConversationId }),
      ],
    });
    if (!headButtonsShown()) return items;
    const shown = headActionLabels();
    return items.map((item) =>
      "items" in item && !("label" in item) ? { ...item, items: item.items.filter((entry) => !shown.has(entry.label)) } : item,
    );
  };

  return {
    later: laterItems,
    // On the phone "…" also holds "Später anzeigen", with the same times as the head's "Später".
    more: (): MenuEntry[] =>
      mailV2MenuEntries(moreItems()).map((entry) =>
        entry !== "separator" && "label" in entry && entry.label === readerText().showLater
          ? showLaterItem(Boolean(entry.disabled))
          : entry,
      ),
    /** What other apps linked to the open conversation, for the head's "n verknüpft". */
    linked: () => links.items(),
    /** Writing the open conversation's summary, also from the summary's own "Bearbeiten". */
    summary,
  };
}
