import type { DropdownAction, DropdownItem } from "@k2b/ui";
import { getMailAction, type MailActionId } from "./mail-actions";
import type { mailConversationUiMessages } from "./mail-conversation-ui-messages";

type MailConversationText = ReturnType<typeof mailConversationUiMessages.resolve>["t"];

export type MailRespondIntent = "reply" | "reply_all" | "forward";

export const mailActionLabel = (t: MailConversationText, actionId: MailActionId): string =>
  actionId === "archive"
    ? t.archive
    : actionId === "move"
      ? t.moveToFolder
      : actionId === "trash"
        ? t.trash
        : actionId === "junk"
          ? t.junk
          : actionId === "not_spam"
            ? t.notSpam
            : actionId === "mark_read"
              ? t.markRead
              : actionId === "mark_unread"
                ? t.markUnread
                : actionId === "flag"
                  ? t.flag
                  : t.unflag;

/** What one conversation's menu offers; a part left out is not available to this person here. */
export type MailConversationMenu = {
  t: MailConversationText;
  /** Answers the latest message, in this window or in a window of its own. */
  respond?: { replyAll: boolean; disabled?: boolean; run: (intent: MailRespondIntent, options: { window: boolean }) => void };
  /** Adds you to the people responsible; `others` stay responsible. */
  assignToMe?: { assigned: boolean; others: readonly string[]; disabled?: boolean; run: () => void };
  completion?: { done: boolean; disabled?: boolean; run: () => void };
  /** Read, flag, tags and the folder actions, for a person who may change the conversation. */
  organize?: {
    unread: boolean;
    flagged: boolean;
    spamAction: "junk" | "not_spam";
    kept: boolean;
    disabled?: boolean;
    tagsDisabled?: boolean;
    run: (actionId: MailActionId) => void;
    manageTags: () => void;
  };
  conversation?: readonly DropdownAction[];
  other?: readonly DropdownAction[];
};

/**
 * The one menu of a conversation: the row's "…" and right-click menus and the reader's use it alike, so their entries
 * and order cannot drift apart. Answers lead, taking the conversation follows, then marks, folders and the rest.
 */
export const mailConversationMenuItems = (menu: MailConversationMenu): DropdownItem[] => {
  const { t } = menu;
  const sections: DropdownItem[] = [];
  const respond = menu.respond;
  if (respond) {
    sections.push({
      sectionLabel: t.respond,
      items: [
        {
          label: t.reply,
          icon: "ti ti-arrow-back-up",
          disabled: respond.disabled,
          action: () => respond.run("reply", { window: false }),
        },
        {
          label: t.replyInNewWindow,
          icon: "ti ti-app-window",
          disabled: respond.disabled,
          // A browser opens a window only during the click itself, also from a phone's menu sheet.
          immediate: true,
          action: () => respond.run("reply", { window: true }),
        },
        ...(respond.replyAll
          ? [
              {
                label: t.replyAll,
                icon: "ti ti-arrow-back-up-double",
                disabled: respond.disabled,
                action: () => respond.run("reply_all", { window: false }),
              },
            ]
          : []),
        {
          label: t.forward,
          icon: "ti ti-arrow-forward-up",
          disabled: respond.disabled,
          action: () => respond.run("forward", { window: false }),
        },
      ],
    });
  }
  const followUp: DropdownAction[] = [];
  const assign = menu.assignToMe;
  if (assign) {
    followUp.push(
      assign.assigned
        ? { label: t.assignToMe, icon: "ti ti-user-check", description: t.alreadyAssignedToYou, disabled: true }
        : {
            label: t.assignToMe,
            icon: "ti ti-user-plus",
            variant: "accent",
            ...(assign.others.length > 0
              ? { description: t.othersStayAssigned({ names: assign.others.join(", "), count: assign.others.length }) }
              : {}),
            disabled: assign.disabled,
            action: assign.run,
          },
    );
  }
  const completion = menu.completion;
  if (completion) {
    followUp.push({
      label: completion.done ? t.reopen : t.markDone,
      icon: completion.done ? "ti ti-arrow-back-up" : "ti ti-check",
      disabled: completion.disabled,
      action: completion.run,
    });
  }
  if (followUp.length > 0) sections.push({ sectionLabel: t.followUp, items: followUp });
  const organize = menu.organize;
  if (organize) {
    const read = organize.unread ? "mark_read" : "mark_unread";
    const flag = organize.flagged ? "unflag" : "flag";
    sections.push({
      sectionLabel: t.mark,
      items: [
        { label: mailActionLabel(t, read), icon: getMailAction(read).icon, disabled: organize.disabled, action: () => organize.run(read) },
        { label: mailActionLabel(t, flag), icon: getMailAction(flag).icon, disabled: organize.disabled, action: () => organize.run(flag) },
        { label: t.manageTags, icon: "ti ti-tags", disabled: organize.tagsDisabled, action: organize.manageTags },
      ],
    });
    sections.push({
      sectionLabel: t.organize,
      items: (["archive", "move", organize.spamAction, "trash"] as const).map((actionId): DropdownAction => {
        // Cloud refuses to delete a kept conversation or move it to Junk; the menu says why.
        const blocked = organize.kept ? (actionId === "trash" ? t.keptCannotDelete : actionId === "junk" ? t.keptCannotJunk : null) : null;
        const base = {
          label: mailActionLabel(t, actionId),
          icon: getMailAction(actionId).icon,
          ...(actionId === "trash" ? { variant: "danger" as const } : {}),
        };
        return blocked
          ? { ...base, description: blocked, disabled: true }
          : { ...base, disabled: organize.disabled, action: () => organize.run(actionId) };
      }),
    });
  }
  if (menu.conversation?.length) sections.push({ sectionLabel: t.conversationSection, items: menu.conversation });
  if (menu.other?.length) sections.push({ sectionLabel: t.other, items: menu.other });
  return sections;
};

/** An answer a list row asked for, started by the reader once that conversation is open. */
export type MailRespondRequest = { conversationId: string; intent: MailRespondIntent; window: Window | null };

/** Opens the empty window a draft moves into; null when the browser blocks pop-up windows. */
export const openMailReplyWindow = (): Window | null =>
  window.open("about:blank", "", "popup,width=1120,height=820,resizable=yes,scrollbars=yes");
