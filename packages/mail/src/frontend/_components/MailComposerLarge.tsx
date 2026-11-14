import { Button, Panes, type PanesItem, type PanesLayout, Placeholder, useLocale } from "@k2b/ui";
import { type Accessor, createMemo, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ComposePreview } from "../../contracts";
import MailFormattingWarnings from "./MailFormattingWarnings";
import { mailComposerMessages } from "./mail-composer-messages";

/** The preview loads nothing from the network: the mailbox logo and every other image arrive as `data:` URLs. */
const PREVIEW_POLICY =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">";

/**
 * The preview beside a draft: the mail as it arrives, with a quiet line at a fixed place that says whether it follows
 * the typing. A failed update keeps the last good preview under "Preview not current"; without one the pane says what
 * failed and offers to try again. Sending never waits for it.
 */
function MailLargePreview(props: {
  preview: Accessor<ComposePreview | null>;
  error: Accessor<string | undefined>;
  pending: Accessor<boolean>;
  onRetry: () => void;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  let section!: HTMLElement;
  let frame: HTMLIFrameElement | undefined;
  // A click into the mail moves the keyboard into the sandboxed frame, where no key, also not Esc, reaches the window.
  // The frame stays opaque (`sandbox=""`, see mail-preview-sandbox.test.ts), so instead the focus comes straight back to
  // this pane in the page; a text selection in the mail stays, and Esc keeps making the window smaller.
  const takeBackFocus = () =>
    setTimeout(() => {
      if (frame && document.activeElement === frame) {
        // The page takes the keyboard back from the frame first; then the pane holds the focus.
        window.focus();
        section.focus({ preventScroll: true });
      }
    }, 0);
  onMount(() => {
    window.addEventListener("blur", takeBackFocus);
    onCleanup(() => window.removeEventListener("blur", takeBackFocus));
  });
  return (
    <section ref={section} class="mail-large-preview" aria-label={t().preview} tabIndex={-1}>
      <p class="mail-large-preview-status" data-stale={props.error() ? "" : undefined} role="status">
        <i class={`ti ${props.error() ? "ti-alert-triangle" : "ti-mail"}`} aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{props.error() ? t().previewStale : t().previewLive}</span>
        <Show when={props.error() && props.preview()}>
          <Button variant="ghost" size="xs" type="button" loading={props.pending()} onClick={props.onRetry}>
            {t().retry}
          </Button>
        </Show>
      </p>
      <Show
        when={props.preview()}
        fallback={
          <Show
            when={props.error()}
            fallback={<Placeholder state="loading" variant="panel" class="mail-large-preview-state" title={t().preparingPreview} />}
          >
            <Placeholder
              state="error"
              variant="panel"
              class="mail-large-preview-state"
              title={`${t().previewFailed}.`}
              action={
                <Button variant="secondary" size="sm" type="button" loading={props.pending()} onClick={props.onRetry}>
                  {t().retry}
                </Button>
              }
            />
          </Show>
        }
      >
        {(value) => (
          <div class="mail-large-preview-frame">
            {/* Not a tab stop: the frame shows the mail, nothing in it takes input. */}
            <iframe
              tabIndex={-1}
              class="mail-large-preview-mail"
              ref={frame}
              sandbox=""
              srcdoc={`${PREVIEW_POLICY}<style>body{margin:0}</style>${value().html}`}
              title={t().emailPreview}
            />
            <MailFormattingWarnings warnings={value().formattingWarnings} />
          </div>
        )}
      </Show>
    </section>
  );
}

/**
 * "Write large": the draft, its conversation, and the preview as panes of one surface in the maximized window. The draft
 * pane is the draft as it stands in the window, moved here whole, so its text keeps its caret, undo history, and
 * uploads. The arrangement is the person's: Mail stores it and opens with it next time (F3).
 */
export default function MailComposerLarge(props: {
  layout: Accessor<PanesLayout>;
  /** Mail's own arrangement for this draft, without the conversation for a new message. */
  defaultLayout: Accessor<PanesLayout>;
  onLayoutChange: (layout: PanesLayout) => void;
  draft: JSX.Element;
  history?: () => JSX.Element;
  preview: Accessor<ComposePreview | null>;
  previewError: Accessor<string | undefined>;
  previewPending: Accessor<boolean>;
  onRetryPreview: () => void;
  arrangeHint?: { open: boolean; onDismiss: () => void };
  /** A phone's full-screen sheet: one row of tabs in the order Draft, Preview, History; the stored layout stays. */
  sheet?: Accessor<boolean>;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const items = createMemo<PanesItem[]>(() => [
    { id: "editor", title: t().draft, icon: "ti ti-pencil", render: () => props.draft },
    ...(props.history ? [{ id: "history", title: t().history, icon: "ti ti-history", render: props.history }] : []),
    {
      id: "preview",
      title: t().preview,
      icon: "ti ti-eye",
      render: () => (
        <MailLargePreview
          preview={props.preview}
          error={props.previewError}
          pending={props.previewPending}
          onRetry={props.onRetryPreview}
        />
      ),
    },
  ]);
  const sheetLayout = (): PanesLayout => ({
    version: 2,
    root: { type: "group", items: ["editor", "preview", ...(props.history ? ["history"] : [])], active: "editor" },
  });
  return (
    <Panes
      layout={props.sheet?.() ? sheetLayout() : props.layout()}
      onLayoutChange={props.onLayoutChange}
      defaultLayout={props.defaultLayout()}
      arrangeHint={props.arrangeHint}
      items={items()}
      class="mail-large-panes"
      ariaLabel={t().editorPanes}
    />
  );
}
