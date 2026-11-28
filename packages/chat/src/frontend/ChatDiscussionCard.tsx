import { Avatar } from "@k2b/ui";
import type { JSX } from "solid-js";
import { Show } from "solid-js";

/** A discussion about an item, as it stands in its place's stream: where it is now and who spoke last. */
export type ChatDiscussion = {
  /** The discussion's own page. */
  href: string;
  /** Opens it in place on a plain click; the link still opens it in a new tab. */
  onOpen: () => void;
  name: string;
  /** The item's Tabler class, such as "ti ti-layout-kanban". */
  icon: string;
  /** The item's state in its app's words, else open or done. */
  state: string;
  done: boolean;
  /** Who wrote last and what, or that nobody has. */
  line: string;
  author: { id: string; type: "user" | "service_account"; name: string } | null;
  unread: number;
  /** "1 new" and the like, in the page's language; empty without unread messages. */
  unreadLabel: string;
  openLabel: string;
};

/**
 * One discussion about an item in its place's "General" stream (Valentin, v8: no column of its own): the item's sign,
 * its name and state in words, the last message with the face of who wrote it, the time and what is new. The whole
 * card leads to the discussion.
 */
export default function ChatDiscussionCard(props: ChatDiscussion & { time: string; dateTime: string }): JSX.Element {
  return (
    <a
      class="chat-discussion"
      data-unread={props.unread > 0 ? "" : undefined}
      data-done={props.done ? "" : undefined}
      href={props.href}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        props.onOpen();
      }}
    >
      <span class="chat-discussion__top">
        <span class="chat-discussion__sign" aria-hidden="true">
          <i class={props.icon} />
        </span>
        <span class="chat-discussion__text">
          <span class="chat-discussion__title">
            <span class="chat-discussion__name">{props.name}</span>
            <span class="chat-discussion__state">{props.state}</span>
          </span>
          <span class="chat-discussion__line">{props.line}</span>
        </span>
        {/* the face of who wrote last, as the stream's own rows draw it (the drawing loads no account module) */}
        <Show when={props.author}>
          {(author) => (
            <span class="chat-discussion__face">
              <Avatar name={author().name} size="sm" />
            </span>
          )}
        </Show>
      </span>
      <span class="chat-discussion__foot">
        <time datetime={props.dateTime}>{props.time}</time>
        <Show when={props.unread > 0}>
          <span class="chat-discussion__new">{props.unreadLabel}</span>
        </Show>
        <span class="chat-discussion__go" aria-hidden="true">
          {props.openLabel} <i class="ti ti-arrow-up-right" />
        </span>
      </span>
    </a>
  );
}
