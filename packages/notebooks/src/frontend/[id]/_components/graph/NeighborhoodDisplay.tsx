import { Button, ButtonLink, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import GraphCanvas, { type GraphDisplayProps } from "./GraphCanvas";

/**
 * The local empty state and the recentring announcement belong to this display, since both outlive the canvas; all
 * canvas interactions are shared with Network.
 */
export default function NeighborhoodDisplay(
  props: GraphDisplayProps & {
    depth: 1 | 2;
    onCentre: (id: string) => void;
    onNetwork: () => void;
    onResetFilters: () => void;
    noteHref: (id: string) => string;
  },
) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const current = () => props.model.byId.get(props.currentId!)!;
  const linked = () => props.notes.some((note) => current().neighbours.has(note.id));
  const [announcement, setAnnouncement] = createSignal("");
  let empty: HTMLDivElement | undefined;
  const centre = (id: string, hadFocus: boolean) => {
    props.onCentre(id);
    // The same counts as the note's own description, so the announcement and a later re-read agree.
    const note = props.model.byId.get(id);
    if (note) setAnnouncement(t().graphCentred({ title: note.title || t().untitled, out: note.out.size, incoming: note.in.size }));
    // A new centre whose links the filters hide replaces the canvas with the empty state; focus goes to its way out.
    if (hadFocus) queueMicrotask(() => empty?.isConnected && empty.querySelector<HTMLElement>("button, a[href]")?.focus());
  };
  return (
    <>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-centred-announcement>
        {announcement()}
      </span>
      <Show
        when={linked()}
        fallback={
          <div ref={empty} class="notebook-graph__empty" data-display="neighborhood">
            <Placeholder
              variant="panel"
              icon={current().deg > 0 ? "ti ti-filter" : "ti ti-topology-star-3"}
              title={(current().deg > 0 ? t().graphLocalFilteredTitle : t().graphLocalEmpty)({ title: current().title || t().untitled })}
              description={
                current().deg > 0 ? (
                  t().graphLocalFiltered
                ) : (
                  <p>
                    {t().graphLocalDescription} <code>/note</code> {t().graphNoLinksHintAfter}
                  </p>
                )
              }
              action={
                <>
                  <Show when={current().deg > 0}>
                    <Button variant="secondary" size="sm" onClick={props.onResetFilters}>
                      {t().graphResetFilters}
                    </Button>
                  </Show>
                  <Button variant="secondary" size="sm" onClick={props.onNetwork}>
                    <i class="ti ti-affiliate" aria-hidden="true" />
                    {t().graphShowWholeNotebook}
                  </Button>
                  <ButtonLink variant="ghost" size="sm" href={props.noteHref(current().id)}>
                    {t().graphGoToNote}
                  </ButtonLink>
                </>
              }
            />
          </div>
        }
      >
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
