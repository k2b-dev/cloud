import type { DateContext } from "@k2b/stdlib";
import { Show } from "solid-js";
import type { Thread } from "./threads";

/** The owning reader supplies localized display context. */
export default function ThreadMetadata(props: { resource: Thread["resource"]; dateConfig: DateContext }) {
  return <Show when={props.resource?.context}>{(context) => <span class="chat-item-metadata">{context()}</span>}</Show>;
}
