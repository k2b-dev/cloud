import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { ResourceCard } from "@k2b/ui";
import { createResource, For, type JSX } from "solid-js";
import type { createResourceCards } from "./resource-cards";

export type ResourceCards = ReturnType<typeof createResourceCards>;

/**
 * The Cloud elements a message shares, one card each. A card holds its size from the first frame: it shows a
 * placeholder while the element's app answers, and without access only "not available".
 */
export default function ChatResourceCards(props: { refs: readonly CloudResourceRef[]; cards: ResourceCards | undefined }): JSX.Element {
  return (
    <div class="chat-resource-cards">
      <For each={props.refs}>
        {(ref) => {
          const [view] = createResource(
            () => props.cards,
            (cards) => cards.view(ref),
          );
          return (
            <ResourceCard
              state={view.loading || !props.cards ? "loading" : (view()?.state ?? "unavailable")}
              title={view()?.title}
              icon={view()?.icon}
              source={view()?.source}
              preview={view()?.preview}
              href={view()?.href}
            />
          );
        }}
      </For>
    </div>
  );
}
