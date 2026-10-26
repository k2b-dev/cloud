import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { ResourceCard } from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup } from "solid-js";
import type { createResourceCards, ResourceCardView } from "./resource-cards";

export type ResourceCards = ReturnType<typeof createResourceCards>;

/**
 * The current view of one element for as long as the calling component shows it: read when shown and again each
 * minute, the last answer kept while the next one comes, and the read given up when the component goes away.
 * Undefined until the first answer, and on the server, where cards show their placeholder.
 */
export const useResourceCard = (cards: () => ResourceCards | undefined, ref: () => CloudResourceRef | undefined) => {
  const [view, setView] = createSignal<ResourceCardView>();
  let release = () => {};
  createEffect(
    on([cards, ref, () => cards()?.epoch()], ([current, element]) => {
      release();
      release = () => {};
      if (!current || !element) return;
      const held = current.view(element);
      let live = true;
      release = () => {
        live = false;
        held.release();
      };
      void held.view.then((next) => {
        if (live) setView(next);
      });
    }),
  );
  onCleanup(() => release());
  return view;
};

/**
 * The Cloud elements a message shares, one card each. A card holds its size from the first frame: it shows a
 * placeholder while the element's app answers, and without access only "not available".
 */
export default function ChatResourceCards(props: { refs: readonly CloudResourceRef[]; cards: ResourceCards | undefined }): JSX.Element {
  return (
    <div class="chat-resource-cards">
      <For each={props.refs}>
        {(ref) => {
          const view = useResourceCard(
            () => props.cards,
            () => ref,
          );
          return (
            <ResourceCard
              state={view()?.state ?? "loading"}
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
