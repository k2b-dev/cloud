import { importOnDemand } from "@k2b/cloud/browser/reload";
import { i18n } from "@k2b/stdlib";
import { type DropdownAction, type DropdownItem, toast, useLocale } from "@k2b/ui";
import { createContext, createMemo, onMount, type ParentProps, useContext } from "solid-js";

export const mailCloudIdMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      section: "Cloud ID",
      copyConversation: "Copy conversation Cloud ID",
      copyMessage: "Copy message Cloud ID",
      conversationCopied: "Conversation Cloud ID copied",
      messageCopied: "Message Cloud ID copied",
      copyFailed: "Could not copy the Cloud ID",
    },
    de: {
      section: "Cloud-ID",
      copyConversation: "Cloud-ID der Unterhaltung kopieren",
      copyMessage: "Cloud-ID der Nachricht kopieren",
      conversationCopied: "Cloud-ID der Unterhaltung kopiert",
      messageCopied: "Cloud-ID der Nachricht kopiert",
      copyFailed: "Cloud-ID konnte nicht kopiert werden",
    },
  },
});

type ClipboardModule = typeof import("@k2b/cloud/browser/resource-clipboard");
// The clipboard contract validates with Zod, which stays out of the mailbox's first load (mailbox-first-load.test.ts).
// It loads once the page is idle, so a copy still runs inside the click that asked for it.
let clipboardModule: ClipboardModule | undefined;
const loadClipboard = () => import("@k2b/cloud/browser/resource-clipboard").then((module) => (clipboardModule = module));

/** The canonical Cloud origin from `app.url`, which the page resolves on the server. */
const MailCloudUrlContext = createContext<string | null>(null);

export function MailCloudIdProvider(props: ParentProps<{ cloudUrl: string }>) {
  onMount(() => {
    const warm = () => void loadClipboard().catch(() => undefined);
    if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 2000 });
    else setTimeout(warm, 0);
  });
  return <MailCloudUrlContext.Provider value={props.cloudUrl}>{props.children}</MailCloudUrlContext.Provider>;
}

export type MailCloudIdKind = "conversation" | "message";
export type MailCloudIdTarget = { conversationId?: string | null; messageId?: string | null };

/** Copies the Cloud resource reference of a conversation or message: the structured ref and its permalink as text. */
export const useMailCloudId = () => {
  const cloudUrl = useContext(MailCloudUrlContext);
  const locale = useLocale();
  const t = createMemo(() => mailCloudIdMessages.resolve([locale()]).t);

  const copy = (kind: MailCloudIdKind, id: string) => {
    if (!cloudUrl) return;
    const copied = kind === "message" ? t().messageCopied : t().conversationCopied;
    const failed = () => void toast.error(t().copyFailed);
    const write = (module: ClipboardModule) => {
      try {
        const ref = { type: `mail.${kind}`, id };
        return module.cloudResourceClipboard
          .write({ cloudUrl, ref, fallbackText: module.cloudResourceClipboard.url(ref, cloudUrl) })
          .then(() => void toast.success(copied), failed);
      } catch {
        failed();
      }
    };
    if (clipboardModule) void write(clipboardModule);
    else void importOnDemand(loadClipboard).then((module) => module && write(module));
  };

  const actions = (target: MailCloudIdTarget): DropdownAction[] => {
    if (!cloudUrl) return [];
    const { conversationId, messageId } = target;
    return [
      ...(messageId ? [{ label: t().copyMessage, icon: "ti ti-id", action: () => copy("message", messageId) }] : []),
      ...(conversationId ? [{ label: t().copyConversation, icon: "ti ti-id", action: () => copy("conversation", conversationId) }] : []),
    ];
  };

  return {
    available: () => Boolean(cloudUrl),
    t,
    copy,
    actions,
    /** The menu section every Mail "…" menu ends with. */
    section: (target: MailCloudIdTarget): DropdownItem[] => {
      const items = actions(target);
      return items.length > 0 ? [{ sectionLabel: t().section, items }] : [];
    },
  };
};
