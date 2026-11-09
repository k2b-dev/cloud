import { importOnDemand } from "@k2b/cloud/browser/reload";
import { Button, type Completion, Panes, type PanesItem, type PanesLayout, Placeholder, useLocale } from "@k2b/ui";
import type { TextEditorController } from "@k2b/ui/text-editor";
import type { Accessor, JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import type { ComposePreview } from "../../contracts";
import type { MailDraftDocumentClient, MailSharedDraftState } from "../../lib/draft-document-client";
import type { MailTextEditorActions } from "./MailTextEditor";
import MailFormattingWarnings from "./MailFormattingWarnings";
import { mailComposerMessages } from "./mail-composer-messages";
import { reconcileMailComposerPanes } from "./mail-composer-panes";

/** The preview loads nothing from the network: the mailbox logo and every other image arrive as `data:` URLs. */
const PREVIEW_POLICY =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">";

export default function MailComposerEditor(props: {
  shared?: Accessor<MailDraftDocumentClient | null>;
  sharedState?: Accessor<MailSharedDraftState | null>;
  onTableCheck?: (needsCheck: boolean) => void;
  format: Accessor<"plain" | "markdown">;
  body: Accessor<string>;
  onBodyInput: (value: string) => void;
  editable: Accessor<boolean>;
  /** Input waits for a moment; the text keeps its caret, focus, and toolbar. */
  paused?: Accessor<boolean>;
  completions: Accessor<Completion[]>;
  panes: Accessor<PanesLayout>;
  onPanesChange: (value: PanesLayout) => void;
  preview: Accessor<ComposePreview | null>;
  previewError: Accessor<string | undefined>;
  previewPending: Accessor<boolean>;
  onRetryPreview: () => void;
  onEditorReady: (editor: TextEditorController, actions: MailTextEditorActions) => void;
  onAttachImages?: () => void;
  onDroppedImages?: (files: File[]) => void;
  history?: () => JSX.Element;
  liveDictation?: boolean;
  /**
   * The draft inside its conversation: one surface without panes. `preview` shows the mail as it arrives in place of
   * the text; `formatting` shows the editor's formatting bar.
   */
  inline?: { preview: Accessor<boolean>; formatting: Accessor<boolean> };
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const hasHistory = () => props.history !== undefined;
  const usesPanes = () => props.format() === "markdown" || hasHistory();
  const [editorModule, setEditorModule] = createSignal<typeof import("./MailTextEditor")>();
  const [editorFailed, setEditorFailed] = createSignal(false);
  const loadEditor = async () => {
    setEditorFailed(false);
    const loaded = await importOnDemand(() => import("./MailTextEditor"));
    if (loaded) setEditorModule(loaded);
    else setEditorFailed(true);
  };
  onMount(() => void loadEditor());
  const writeSurface = () => (
    <Show
      when={editorModule()}
      fallback={
        <Placeholder
          state={editorFailed() ? "error" : "loading"}
          variant="panel"
          class="h-full min-h-72"
          title={editorFailed() ? t().editorFailed : t().preparingDraft}
          action={
            editorFailed() ? (
              <Button variant="secondary" onClick={() => void loadEditor()}>
                {t().retry}
              </Button>
            ) : undefined
          }
        />
      }
    >
      {(module) => {
        const Editor = module().default;
        return (
          <For each={[props.shared?.() ?? null]}>
            {(binding) => (
              <Editor
                shared={binding ?? undefined}
                sharedState={props.sharedState}
                onTableCheck={props.onTableCheck}
                format={props.format}
                body={props.body}
                onBodyInput={props.onBodyInput}
                editable={props.editable}
                paused={props.paused}
                completions={props.completions}
                liveDictation={props.liveDictation}
                toolbar={props.inline ? props.inline.formatting : undefined}
                inline={Boolean(props.inline)}
                onEditorReady={props.onEditorReady}
                onAttachImages={props.onAttachImages}
                onDroppedImages={props.onDroppedImages}
              />
            )}
          </For>
        );
      }}
    </Show>
  );

  // A failed preview takes the whole pane until a later one succeeds, so its message never covers an outdated preview.
  const previewSurface = () => (
    <div class="h-full min-h-72 overflow-hidden">
      <Show
        when={props.previewError()}
        fallback={
          <Show
            when={props.preview()}
            fallback={<Placeholder state="loading" variant="panel" class="h-full min-h-72" title={t().preparingPreview} />}
          >
            {(value) => (
              <div class="flex h-full min-h-72 flex-col">
                <iframe
                  class="min-h-0 w-full flex-1 border-0 bg-white"
                  sandbox=""
                  srcdoc={`${PREVIEW_POLICY}<style>body{margin:0}</style>${value().html}`}
                  title={t().emailPreview}
                />
                <MailFormattingWarnings warnings={value().formattingWarnings} />
              </div>
            )}
          </Show>
        }
      >
        {(message) => (
          <Placeholder
            state="error"
            variant="panel"
            class="h-full min-h-72 overflow-y-auto"
            title={t().previewFailed}
            description={message() === t().previewFailed ? undefined : message()}
            action={
              <Button variant="secondary" size="sm" type="button" loading={props.previewPending()} onClick={props.onRetryPreview}>
                {t().retry}
              </Button>
            }
          />
        )}
      </Show>
    </div>
  );

  if (props.inline) {
    const inline = props.inline;
    // The text stays mounted under the preview, so its caret, undo history, and shared binding survive the switch.
    return (
      <div class="mail-inline-draft-text">
        <div class="mail-inline-draft-write" hidden={inline.preview()}>
          {writeSurface()}
        </div>
        <Show when={inline.preview()}>
          <div class="mail-inline-draft-preview">{previewSurface()}</div>
        </Show>
      </div>
    );
  }

  // Panes show only for Markdown or a history. Switching the format moves this one element between both layouts, so
  // the editor keeps its text, caret, and undo history instead of starting over.
  const [layoutPanes, setLayoutPanes] = createSignal(usesPanes());
  let write!: HTMLDivElement;
  const writeElement = (
    <div ref={write} class="h-full overflow-hidden" classList={{ "min-h-0": layoutPanes(), "min-h-72": !layoutPanes() }}>
      {writeSurface()}
    </div>
  );
  createEffect(
    on(
      usesPanes,
      (next) => {
        // Moving an element drops its focus; the text that had it gets it back in the new place.
        const focused = write.contains(document.activeElement);
        setLayoutPanes(next);
        if (focused) queueMicrotask(() => write.querySelector<HTMLElement>(".cm-content")?.focus());
      },
      { defer: true },
    ),
  );
  const items = createMemo<PanesItem[]>(() => [
    {
      id: "editor",
      title: t().write,
      icon: "ti ti-pencil",
      render: () => writeElement,
    },
    ...(props.format() === "markdown" ? [{ id: "preview", title: t().preview, icon: "ti ti-eye", render: previewSurface }] : []),
    ...(props.history ? [{ id: "history", title: t().history, icon: "ti ti-history", render: props.history }] : []),
  ]);
  return (
    <div class="min-h-72 flex-1 pb-2">
      <Show when={layoutPanes()} fallback={writeElement}>
        <Panes
          layout={reconcileMailComposerPanes(props.panes(), props.format(), hasHistory())}
          onLayoutChange={props.onPanesChange}
          items={items()}
          class="h-full w-full"
          movable
          resizable
          split="horizontal"
          ariaLabel={t().editorPanes}
        />
      </Show>
    </div>
  );
}
