import { Button, Format, IconButton, Kbd, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import type { GraphNote } from "./model";

/** Status and touch selection are the same interaction in both graph displays. */
export default function GraphFeedback(props: {
  statusNote: GraphNote | undefined;
  selected: GraphNote | undefined;
  currentId: string | null;
  keyboard: boolean;
  idleText: string;
  now: string;
  onOpen: (id: string) => void;
  onClearSelection: () => void;
  onCentre?: (id: string) => void;
}) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const areaName = (note: GraphNote) => (note.area.index === 0 ? t().graphTopLevel : note.area.title || t().untitled);
  return (
    <>
      <div class="notebook-graph__status" aria-hidden="true">
        <Show when={props.statusNote} fallback={<span class="notebook-graph__status-text">{props.idleText}</span>}>
          {(note) => (
            <>
              <span class="notebook-graph__dot" data-slot={note().area.slot} />
              <strong>{note().title || t().untitled}</strong>
              <span class="notebook-graph__status-text">
                {areaName(note())} · {t().graphLinkCounts({ out: note().out.size, incoming: note().in.size })} · {t().graphChanged}{" "}
                <Format.RelativeTime value={note().updatedAt} base={props.now} />
              </span>
            </>
          )}
        </Show>
        <Show
          when={props.keyboard}
          fallback={
            <>
              <span class="notebook-graph__hints" data-input="pointer">
                {props.onCentre ? t().graphNeighborhoodPointerHints : t().graphPointerHints}
              </span>
              <span class="notebook-graph__hints" data-input="touch">
                {t().graphTouchHints}
              </span>
            </>
          }
        >
          <span class="notebook-graph__hints" data-input="keys">
            <Kbd keys="arrowleft" />
            <Kbd keys="arrowup" />
            <Kbd keys="arrowdown" />
            <Kbd keys="arrowright" /> {t().graphKeyMove} · <Kbd keys="enter" /> {t().graphKeyOpen} · <Kbd keys="home" />{" "}
            {t().graphKeyCurrent} ·{" "}
            <Show when={props.onCentre}>
              <Kbd keys="space" /> {t().graphKeyCenter} ·{" "}
            </Show>{" "}
            <Kbd keys="escape" /> {t().graphKeyReset}
          </span>
        </Show>
      </div>
      <Show when={props.selected}>
        {(note) => (
          <div class="notebook-graph__selection" role="region" aria-label={t().graphSelected}>
            <span class="notebook-graph__dot" data-slot={note().area.slot} />
            <div class="notebook-graph__selection-text">
              <strong>{note().title || t().untitled}</strong>
              <small>
                {areaName(note())} · <i class="ti ti-arrow-up-right" aria-hidden="true" />
                <span class="sr-only">{t().graphLinksTo}</span> {note().out.size} <i class="ti ti-arrow-down-left" aria-hidden="true" />
                <span class="sr-only">{t().graphLinkedFrom}</span> {note().in.size}
              </small>
            </div>
            <Show when={props.onCentre && note().id !== props.currentId}>
              <IconButton label={t().graphMoveToCenter} size="sm" onClick={() => props.onCentre?.(note().id)}>
                <i class="ti ti-focus-2" aria-hidden="true" />
              </IconButton>
            </Show>
            <Button variant="primary" size="sm" onClick={() => props.onOpen(note().id)}>
              {t().graphOpen}
            </Button>
            <IconButton label={t().graphClearSelection} size="sm" onClick={() => props.onClearSelection()}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </Show>
    </>
  );
}
