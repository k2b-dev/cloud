import { createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { isServer, render } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { createQuestion, type Question, quietFocus, useDialog } from "./behavior/overlays";
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
   * `false`: a press outside, a swipe on the phone's sheet and Android's back gesture do not close it, so nothing in
   * it is lost by a stray touch (a secret shown once); Escape, the close button and the buttons of the foot still do.
   * `true` by default.
   */
  dismissible?: boolean;
};

/** What takes the focus first in a dialog: a field, a link or a button in its content, else an action of its foot. */
const focusable =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** The phone of v2: every width below 768 px, the one query of v2.css for the phone layout. */
const phoneQuery = "not all and (min-width: 768px)";

/**
 * Whether the window is the v2 phone; false on the server, where a dialog is closed anyway. In the browser it is known
 * from the start, so a dialog on the phone is a sheet from its first render on (and core prepares the sheet early).
 */
const usePhone = () => {
  const [phone, setPhone] = createSignal(!isServer && matchMedia(phoneQuery).matches);
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
  // On the phone's sheet a text field would bring up the keyboard over the sheet at once: there the first control that
  // is no text field takes the focus, else the first action of the foot.
  const typed = (element: HTMLElement) =>
    element.matches(
      "textarea, input:not([type]), input:is([type='text'], [type='search'], [type='email'], [type='url'], [type='tel'], [type='password'], [type='number'])",
    );
  const first = (part: HTMLElement | undefined) =>
    [...(part?.querySelectorAll<HTMLElement>(focusable) ?? [])].find((element) => !phone() || !typed(element));
  const firstFocus = () => {
    const target = first(body) ?? first(foot) ?? null;
    // the first focus shows no ring unless a key opened the dialog; a text field keeps its own (the caret's place)
    if (target && !typed(target)) quietFocus(target);
    return target;
  };
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
  // Core re-places its sheet after the content's height changed with a spring that starts at the old height: for a
  // moment the whole sheet stands higher, off the bottom, and a tap there hits the backdrop (#4141). The sheet stands on
  // the bottom, so that move ends at once, before the frame is drawn. Core's observer must have answered first: this
  // one is made a frame after the dialog appears, after core's, and observers answer in the order they were made.
  const holdBottom = (element: HTMLElement) => {
    let height: number | undefined;
    let sizes: ResizeObserver | undefined;
    const frame = requestAnimationFrame(() => {
      sizes = new ResizeObserver(() => {
        const changed = height !== undefined && element.offsetHeight !== height;
        height = element.offsetHeight;
        if (changed && element.dataset.presentation === "sheet") for (const animation of element.getAnimations()) animation.finish();
      });
      sizes.observe(element);
    });
    onCleanup(() => {
      cancelAnimationFrame(frame);
      sizes?.disconnect();
    });
  };
  return (
    <dialog.Popup
      ref={holdBottom}
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

/**
 * Asks before something happens that cannot be taken back, and resolves `true` when the person agrees:
 * `if (await Dialog.confirm({ title: "Auftrag verwerfen?", confirm: "Verwerfen" })) discard()`. An alert dialog in
 * the shape of `Dialog`, without a close button: Escape and the other button answer no, focus starts on the other
 * button, a press outside does nothing, and it is never a sheet. The first `Workspace` on the page answers, also for
 * code in another island; without one, the question brings its own dialog to the end of the page until it is
 * answered. A question whose dialog leaves the page while it asks is answered no.
 */
export const confirm = (options: ConfirmOptions): Promise<boolean> => {
  const page = pageAnswer();
  if (page) return page(options);
  // no Workspace answers: a dialog of its own, in a v2 scope of its own, for as long as the question is open
  const question = createQuestion<ConfirmOptions>();
  const host = document.createElement("div");
  host.className = "k2-ui";
  host.style.display = "contents";
  document.body.append(host);
  const stop = render(() => <ConfirmSurface question={question} />, host);
  return question.ask(options).finally(() => {
    stop();
    host.remove();
  });
};

type Ask = (options: ConfirmOptions) => Promise<boolean>;

/**
 * The Workspace that answers is found through the page, not through a module: every island bundles its own copy of
 * `@k2b/ui`, so a list in this module would not see a Workspace another island renders. Each mounted Workspace puts
 * its `ask` on its element under this key; its element and attributes stay what the server sent.
 */
const hostKey = Symbol.for("k2b.ui.v2.confirm");

const pageAnswer = (): Ask | undefined => {
  for (const host of document.querySelectorAll("[data-k2-workspace]")) {
    const ask: unknown = Reflect.get(host, hostKey);
    if (typeof ask === "function") return (options) => Promise.resolve(Reflect.apply(ask, undefined, [options])).then(Boolean);
  }
  return undefined;
};

/**
 * The alert dialog that answers `confirm` (internal; every `Workspace` renders it with its element as the host). Only
 * the first Workspace on the page is asked, so one question opens one dialog. It shows nothing until it asks, on the
 * server too, so it never changes what the server sent.
 */
export const ConfirmDialog = (props: { host: () => HTMLElement | undefined }) => {
  const question = createQuestion<ConfirmOptions>();
  onMount(() => {
    const host = props.host();
    if (!host) return;
    Reflect.set(host, hostKey, question.ask);
    onCleanup(() => {
      Reflect.deleteProperty(host, hostKey);
    });
  });
  return <ConfirmSurface question={question} />;
};

const ConfirmSurface = (props: { question: Question<ConfirmOptions> }) => {
  const t = useUiMessages();
  const parts = props.question.useDialog();
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
