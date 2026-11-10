import type { EditorView } from "@codemirror/view";
import { query } from "@k2b/stdlib/solid";
import { Button, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createSignal, For, on, Show } from "solid-js";
import type { PageTemplateSummary } from "@/lib/page-templates";
import { notebookWorkspaceMessages } from "../../messages";
import { applyPageTemplateById, loadPageTemplates, pickPageTemplate } from "./page-templates";

/** Rows the offer shows; the rest are one search away. */
export const EMPTY_NOTE_TEMPLATE_ROWS = 4;

type Place = { top: number; left: number; width: number };

/**
 * Below the title of a note that holds nothing else, a quiet list of templates to start from. It lies over the empty
 * page instead of in the text, so the note keeps its layout, and it leaves as soon as the note has a body.
 */
export function EmptyNoteTemplates(props: {
  view: Accessor<EditorView | undefined>;
  host: () => HTMLElement | undefined;
  notebookId: string;
  /** Changes whenever the editor's text or geometry does, so the offer follows the note's last line. */
  layout: Accessor<number>;
}) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const templates = query.create({
    source: () => props.notebookId,
    load: (notebookId, { abortSignal }) => loadPageTemplates(notebookId, abortSignal),
  });
  const [place, setPlace] = createSignal<Place | null>(null);
  const [applying, setApplying] = createSignal<string | null>(null);

  createEffect(
    on([props.layout, props.view], ([, view]) => {
      const host = props.host();
      if (!view || !host) return;
      view.requestMeasure({
        read: () => {
          // Below the last line: the empty line after the title of a new note holds the caret, never covered.
          const line = view.domAtPos(view.state.doc.line(view.state.doc.lines).from).node;
          const element = (line instanceof Element ? line : line.parentElement)?.closest<HTMLElement>(".cm-line");
          if (!element) return null;
          const lineBox = element.getBoundingClientRect();
          const hostBox = host.getBoundingClientRect();
          return { top: lineBox.bottom - hostBox.top, left: lineBox.left - hostBox.left, width: lineBox.width };
        },
        write: (measured) => setPlace(measured),
      });
    }),
  );

  const apply = async (template: PageTemplateSummary) => {
    const view = props.view();
    if (!view || applying()) return;
    setApplying(template.id);
    try {
      await applyPageTemplateById(view, props.notebookId, template, locale());
    } finally {
      setApplying(null);
    }
  };
  const pickMore = async () => {
    const template = await pickPageTemplate(props.notebookId, locale());
    if (template) await apply(template);
  };

  return (
    <Show when={place()}>
      {(at) => (
        // The offer is not part of the text: a press here must not move the caret to the end of the note.
        <section
          class="notebook-empty-templates"
          style={{ top: `${at().top}px`, left: `${at().left}px`, width: `${at().width}px` }}
          aria-label={t().startWithTemplate}
          onMouseDown={(event) => event.stopPropagation()}
          data-notebook-empty-templates
        >
          <p class="notebook-empty-templates__label">{t().startWithTemplate}</p>
          <Show
            when={templates.data()}
            fallback={
              <Show
                when={templates.error()}
                fallback={
                  <p class="notebook-empty-templates__status" role="status">
                    <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
                    {t().loadingTemplates}
                  </p>
                }
              >
                <p class="notebook-empty-templates__status" role="alert">
                  <i class="ti ti-alert-circle" aria-hidden="true" />
                  {t().failedLoadTemplates}
                  <Button size="xs" variant="ghost" onClick={() => void templates.refresh()}>
                    {t().retry}
                  </Button>
                </p>
              </Show>
            }
          >
            {(list) => (
              <ul class="notebook-empty-templates__list">
                <For each={list().slice(0, EMPTY_NOTE_TEMPLATE_ROWS)}>
                  {(template) => (
                    <li>
                      <Button
                        variant="ghost"
                        size="sm"
                        align="start"
                        class="notebook-empty-templates__row"
                        disabled={applying() !== null}
                        loading={applying() === template.id}
                        loadingLabel={t().applyingTemplate({ name: template.name })}
                        onClick={() => void apply(template)}
                      >
                        <i class={template.icon} aria-hidden="true" />
                        <span>{template.name}</span>
                      </Button>
                    </li>
                  )}
                </For>
                <Show when={list().length > EMPTY_NOTE_TEMPLATE_ROWS}>
                  <li>
                    <Button
                      variant="ghost"
                      size="sm"
                      align="start"
                      class="notebook-empty-templates__row"
                      disabled={applying() !== null}
                      onClick={() => void pickMore()}
                    >
                      <i class="ti ti-search" aria-hidden="true" />
                      <span>{t().moreTemplates}</span>
                    </Button>
                  </li>
                </Show>
              </ul>
            )}
          </Show>
        </section>
      )}
    </Show>
  );
}
