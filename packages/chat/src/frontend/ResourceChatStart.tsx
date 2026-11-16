import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { Chat, IconButtonLink, PageTitle, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, type JSX, Show } from "solid-js";
import { chatMessages } from "../messages";
import { EmojiPopover } from "./emoji-popover";

/**
 * The discussion about the host page's resource while nobody has written there: a ready chat with its title, a quiet
 * line and the composer, in the places an existing chat has them. Looking creates nothing; the first message does.
 */
export default function ResourceChatStart(props: {
  title: string;
  canWrite: boolean;
  listHref: string;
  onBack: (navigation: LinkNavigateEvent) => void | Promise<void>;
  /** Starts the discussion with this message; false keeps the text in the composer. */
  onStart: (text: string) => Promise<boolean>;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const about = () => t().aboutResource({ title: props.title });
  const [draft, setDraft] = createSignal("");
  const [starting, setStarting] = createSignal(false);
  // The same controls as an existing chat's composer, in the same places, so the first message moves nothing.
  const [emojiTarget, setEmojiTarget] = createSignal<{ anchor: HTMLElement; insert: (text: string) => void }>();
  return (
    <section class="chat-conversation chat-resource-start" aria-label={about()}>
      <header class="chat-conversation__header">
        <span class="chat-conversation__back">
          <IconButtonLink href={props.listHref} navigation="enhanced" onNavigate={props.onBack} label={t().panelAllChats}>
            <i class="ti ti-list" aria-hidden="true" />
          </IconButtonLink>
        </span>
        <PageTitle trail={{ title: about(), ancestors: [] }} />
      </header>
      <div class="chat-conversation__feed chat-resource-start__feed">
        <Placeholder
          variant="panel"
          class="flex-1"
          icon="ti ti-message-circle"
          description={props.canWrite ? t().resourceChatEmpty : t().resourceChatReadOnly}
        />
      </div>
      <Show when={props.canWrite}>
        <div class="chat-conversation__composer" data-k2b-shell-bottom>
          <Chat.Composer
            variant="conversation"
            formatting
            emoji={{ onOpen: setEmojiTarget }}
            // Files need the discussion; they can be added once the first message started it.
            fileSelection={{ onSelect: () => {}, disabled: true, label: t().attachAfterFirstMessage }}
            value={draft()}
            onValueChange={setDraft}
            placeholder={t().composerPlaceholder({ title: props.title })}
            disabled={starting()}
            onSubmit={async ({ text }) => {
              if (!text.trim() || starting()) return false;
              setStarting(true);
              try {
                const started = await props.onStart(text);
                if (started) setDraft("");
                return started;
              } finally {
                setStarting(false);
              }
            }}
          />
          <EmojiPopover
            anchor={emojiTarget()?.anchor}
            onPick={(emoji) => emojiTarget()?.insert(emoji)}
            onClose={() => setEmojiTarget(undefined)}
          />
        </div>
      </Show>
    </section>
  );
}
