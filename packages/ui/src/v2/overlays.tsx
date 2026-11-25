import { createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
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

/** The phone of v2: every width below 768 px, the one query of v2.css for the phone layout. */
const phoneQuery = "not all and (min-width: 768px)";

/** Whether the window is the v2 phone; false on the server, where a dialog is closed anyway. */
const usePhone = () => {
  const [phone, setPhone] = createSignal(false);
  onMount(() => {
    const media = matchMedia(phoneQuery);
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    onCleanup(() => media.removeEventListener("change", update));
  });
  return phone;
};

/**
 * The one dialog: 480 px in the middle of the window; on the phone (below 768 px, where v2 lays out the phone) a sheet
 * from the bottom, which a swipe down closes. Head, content and foot are parts of one thing, so only spacing separates
 * them (rule 9). While the content scrolls, a hairline shows at the edge behind which more content lies. Focus stays
 * inside, Escape and the close button close it, focus returns to what opened it.
 */
export const Dialog = (props: DialogProps) => {
  const t = useUiMessages();
  const phone = usePhone();
  const dialog = useDialog(() => ({
    open: props.open,
    onOpenChange: props.onOpenChange,
    presentation: phone() ? "sheet" : "dialog",
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
  const measure = (body: HTMLElement) => {
    const above = body.scrollTop > 0;
    const below = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
    setMore(above && below ? "both" : above ? "above" : below ? "below" : undefined);
  };
  // The content's box keeps its height while its parts grow inside it (it scrolls), so the parts are watched too, and
  // parts that come later as well. Nothing is watched while the dialog is closed.
  let watching: { sizes: ResizeObserver; parts: MutationObserver } | undefined;
  const stop = () => {
    watching?.sizes.disconnect();
    watching?.parts.disconnect();
    watching = undefined;
  };
  onCleanup(stop);
  createEffect(() => {
    if (!props.open) stop();
  });
  const watch = (element: HTMLElement) => {
    body = element;
    stop();
    const sizes = new ResizeObserver(() => measure(element));
    const observeAll = () => {
      sizes.disconnect();
      sizes.observe(element);
      for (const part of element.children) sizes.observe(part);
    };
    const parts = new MutationObserver(() => {
      observeAll();
      measure(element);
    });
    observeAll();
    parts.observe(element, { childList: true });
    watching = { sizes, parts };
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
 * button, a press outside does nothing, and it is never a sheet. `Workspace` renders it, so every v2 page can ask; a
 * page without a Workspace has no one to answer, and the question is answered no at once (with a warning).
 */
export const confirm = (options: ConfirmOptions): Promise<boolean> => {
  if (hosts().length === 0) {
    console.warn("Dialog.confirm: no v2 Workspace on the page renders the dialog that answers; the answer is no.");
    return Promise.resolve(false);
  }
  return question.ask(options);
};

// The mounted Workspaces that can answer `confirm`, in the order they came; the first one answers. A signal at module
// level, as the question is: the list only changes in the browser, after a Workspace mounted.
const [hosts, setHosts] = createSignal<readonly object[]>([]);

/**
 * The alert dialog that answers `confirm` (internal; every `Workspace` renders it). One question needs one answer, so
 * on a page with more than one Workspace the first one mounted answers; when it leaves, the next one takes over. It
 * shows nothing until it asks, on the server too, so it never changes what the server sent.
 */
export const ConfirmDialog = () => {
  const me = {};
  onMount(() => {
    setHosts((list) => [...list, me]);
    onCleanup(() => setHosts((list) => list.filter((host) => host !== me)));
  });
  return (
    <Show when={hosts()[0] === me}>
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
