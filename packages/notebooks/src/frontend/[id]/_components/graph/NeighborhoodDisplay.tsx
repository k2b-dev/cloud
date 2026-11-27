import { useLocale } from "@k2b/ui";
import { createSignal, type JSX, Show } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import GraphCanvas, { type GraphDisplayProps } from "./GraphCanvas";

/**
 * The recentring announcement belongs to this display, since it outlives the canvas; the empty state around a note
 * without visible links is the frame's. All canvas interactions are shared with Network.
 */
export default function NeighborhoodDisplay(
  props: GraphDisplayProps & {
    depth: 1 | 2;
    onCentre: (id: string) => void;
    /** Hands the focus to the frame's way out when the new centre has no visible links. */
    focusEmpty: () => void;
    /** The frame's way out, which stands here instead of the canvas while the centre has no visible links. */
    empty: JSX.Element;
  },
) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const current = () => props.model.byId.get(props.currentId!)!;
  const linked = () => props.notes.some((note) => current().neighbours.has(note.id));
  const [announcement, setAnnouncement] = createSignal("");
  const centre = (id: string, hadFocus: boolean) => {
    props.onCentre(id);
    // The same counts as the note's own description, so the announcement and a later re-read agree.
    const note = props.model.byId.get(id);
    if (note) setAnnouncement(t().graphCentred({ title: note.title || t().untitled, out: note.out.size, incoming: note.in.size }));
    // A new centre whose links the filters hide replaces the canvas with the frame's empty state; focus goes to its way out.
    if (hadFocus) props.focusEmpty();
  };
  return (
    <>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-centred-announcement>
        {announcement()}
      </span>
      {/* Without visible links the frame's way out stands here, and the announcement above stays. */}
      <Show when={linked()} fallback={props.empty}>
        <GraphCanvas
          {...props}
          neighborhood={{
            get depth() {
              return props.depth;
            },
            onCentre: centre,
          }}
        />
      </Show>
    </>
  );
}
