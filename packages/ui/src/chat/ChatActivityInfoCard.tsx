import type { JSX } from "solid-js";
import { HoverCard } from "../feedback/HoverCard";
import type { ChatActivityInfo } from "./ChatPrimitives";

/**
 * The ⓘ of an activity with its card. Loaded on demand by `Chat.Activity` once a row with details is in the browser,
 * so islands that show activities carry no hover card code in their first JavaScript.
 */
export function ChatActivityInfoCard(props: { info: ChatActivityInfo; focus: boolean }): JSX.Element {
  return (
    <HoverCard.Trigger
      ref={(button) => {
        // The plain ⓘ it replaces had the focus; it keeps it.
        if (props.focus) queueMicrotask(() => button.focus({ preventScroll: true }));
      }}
      triggerClass="k2b-chat-activity__info"
      aria-label={props.info.label}
      align="end"
      width="24rem"
      title={props.info.title}
      detail={props.info.detail}
      content={props.info.content}
      actions={props.info.actions}
    >
      <i class="ti ti-info-circle" aria-hidden="true" />
    </HoverCard.Trigger>
  );
}
