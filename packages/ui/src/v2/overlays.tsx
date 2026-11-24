import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { createQuestion, useDialog } from "./behavior/overlays";
import { Icon } from "./marks";

// The overlays of v2: the behaviour (focus, Escape, placement, keys, the sheet on the phone) comes from the behaviour
// layer on the ui-sdk core (`./behavior/overlays`); these components give it the one shape of v2 (`v2.css`, section
// "Overlays"). No ui-sdk type crosses this module's exports.

// ── Dialog ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type DialogProps = {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The buttons at the foot, the main one last. */
  foot: JSX.Element;
  /** Fields, a notice, text: the content scrolls when it is higher than the dialog. */
  children: JSX.Element;
  /**
   * `false`: a press outside and a swipe on the phone's sheet do not close it, so nothing in it is lost by a stray
   * touch (a secret shown once); Escape, the close button and the buttons of the foot still do. `true` by default.
   */
  dismissible?: boolean;
};

/** What takes the focus first in a dialog: a field, a link or a button in its content, else an action of its foot. */
const focusable =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * The one dialog: 480 px in the middle of the window; on a small touch screen a sheet from the bottom, which a swipe
 * down closes. Head, content and foot are parts of one thing, so only spacing separates them (rule 9). While the
 * content scrolls, a hairline shows at the edge behind which more content lies. Focus stays inside, Escape and the
 * close button close it, focus returns to what opened it.
 */
export const Dialog = (props: DialogProps) => {
  const t = useUiMessages();
  const dialog = useDialog(() => ({
    open: props.open,
    onOpenChange: props.onOpenChange,
    presentation: "auto",
    // core's `dismissible: false` refuses Escape too; Escape still closes, everything else that is refused stays
    dismissible: props.dismissible !== false,
    onDismissAttempt: (reason) => {
      if (props.dismissible === false && reason === "escape-key") props.onOpenChange(false);
    },
  }));
  let body: HTMLElement | undefined;
  let foot: HTMLDivElement | undefined;
  const firstFocus = () => body?.querySelector<HTMLElement>(focusable) ?? foot?.querySelector<HTMLElement>(focusable) ?? null;
  const [more, setMore] = createSignal<"above" | "below" | "both">();
  let observer: ResizeObserver | undefined;
  onCleanup(() => observer?.disconnect());
  const measure = (body: HTMLElement) => {
    const above = body.scrollTop > 0;
    const below = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
    setMore(above && below ? "both" : above ? "above" : below ? "below" : undefined);
  };
  const watch = (element: HTMLElement) => {
    body = element;
    observer?.disconnect();
    observer = new ResizeObserver(() => measure(element));
    observer.observe(element);
    queueMicrotask(() => measure(element));
  };
  return (
    <dialog.Popup
      class="k2-dialog"
      data-k2-part="Dialog"
      data-more={more()}
      backdrop={{ class: "k2-backdrop" }}
      // the first field takes the focus, not the close button; without one the first action of the foot
      initialFocus={firstFocus}
    >
      <div class="k2-slot" data-slot="head">
        <div class="k2-bar">
          <div class="k2-bar-start">
            <dialog.Title class="k2-dialog-title">{props.title}</dialog.Title>
          </div>
          <div class="k2-bar-end">
            <dialog.Close class="k2-btn" data-variant="ghost" data-icon-only="" aria-label={t().close} title={t().close}>
              <Icon name="x" />
            </dialog.Close>
          </div>
        </div>
      </div>
      <div class="k2-dialog-body" ref={watch} onScroll={(event) => measure(event.currentTarget)}>
        {props.children}
      </div>
      <div class="k2-slot" data-slot="foot" ref={foot}>
        <div class="k2-bar">
          <div class="k2-bar-end">{props.foot}</div>
        </div>
      </div>
    </dialog.Popup>
  );
};

// ── Dialog.confirm ───────────────────────────────────────────────────────────────────────────────────────────────

export type ConfirmOptions = {
  /** The question, such as "Auftrag verwerfen?". */
  title: string;
  /** What agreeing does, if the question alone does not say it. */
  description?: string;
  /** The words of the agreeing button, such as "Verwerfen". */
  confirm: string;
  /** The words of the other button; "Abbrechen" by default. */
  cancel?: string;
};

const question = createQuestion<ConfirmOptions>();

/**
 * Asks before something happens that cannot be taken back, and resolves `true` when the person agrees:
 * `if (await Dialog.confirm({ title: "Auftrag verwerfen?", confirm: "Verwerfen" })) discard()`. An alert dialog in
 * the shape of `Dialog`, without a close button: Escape and the other button answer no, focus starts on the other
 * button, a press outside does nothing, and it is never a sheet. `Workspace` renders it, so every v2 page can ask.
 */
export const confirm = (options: ConfirmOptions): Promise<boolean> => question.ask(options);

// The Workspace whose dialog answers `confirm` now: the first one on the page that is still there.
let answering: object | undefined;

/**
 * The alert dialog that answers `confirm` (internal; every `Workspace` renders it). One question needs one answer, so
 * on a page with more than one Workspace only the first one mounted answers; when it leaves, the next one mounted
 * later takes over. It shows nothing until it asks, on the server too, so it never changes what the server sent.
 */
export const ConfirmDialog = () => {
  const [answers, setAnswers] = createSignal(false);
  onMount(() => {
    if (answering) return;
    const me = {};
    answering = me;
    setAnswers(true);
    onCleanup(() => {
      if (answering === me) answering = undefined;
    });
  });
  return (
    <Show when={answers()}>
      <ConfirmSurface />
    </Show>
  );
};

const ConfirmSurface = () => {
  const t = useUiMessages();
  const parts = question.useDialog();
  return (
    <parts.Popup class="k2-dialog" data-k2-part="Dialog" data-alert="" backdrop={{ class: "k2-backdrop" }}>
      <div class="k2-slot" data-slot="head">
        <div class="k2-bar">
          <div class="k2-bar-start">
            <parts.Title class="k2-dialog-title">{parts.payload()?.title}</parts.Title>
          </div>
        </div>
      </div>
      <Show when={parts.payload()?.description}>
        {(description) => (
          <div class="k2-dialog-body">
            <parts.Description class="k2-text">{description()}</parts.Description>
          </div>
        )}
      </Show>
      <div class="k2-slot" data-slot="foot">
        <div class="k2-bar">
          <div class="k2-bar-end">
            <parts.Close class="k2-btn" data-k2-part="Button">
              <span class="k2-btn-label">{parts.payload()?.cancel ?? t().cancel}</span>
            </parts.Close>
            <parts.Close class="k2-btn" data-k2-part="Button" data-variant="primary" value="confirm">
              <span class="k2-btn-label">{parts.payload()?.confirm}</span>
            </parts.Close>
          </div>
        </div>
      </div>
    </parts.Popup>
  );
};

Dialog.confirm = confirm;
