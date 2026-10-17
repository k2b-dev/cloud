import { Button, ButtonLink, Placeholder, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import GraphCanvas, { type GraphDisplayProps } from "./GraphCanvas";

/** The local empty state belongs to this display; all canvas interactions are shared with Network. */
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
  return (
    <Show
      when={linked()}
      fallback={
        <div class="notebook-graph__empty" data-display="neighborhood">
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
          onCentre: props.onCentre,
        }}
      />
    </Show>
  );
}
