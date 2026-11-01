import { getContext, onContextChange } from "@k2b/cloud/browser/panel";
import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { Button, ButtonLink, Skeleton, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { type CodePlace, type CodeSummaryPage, codeStatus, loadCodeSummaries } from "../code-summary";
import { CodeStatusBadge, codeRunLine, codeStateLabel } from "./AssistantCodeView";
import { resolveAssistantCloudResource } from "./AssistantContextContent";
import { browserCodeInvoke } from "./code-client";
import { assistantMessages } from "./messages";

/** What the server knew about the panel's place: its Code page (null when Core could not list it) and the place. */
export type AssistantCodeBlockInitial = { ref: CloudResourceRef; page: CodeSummaryPage | null; place?: CodePlace };

type BlockState =
  | { kind: "none"; ref?: CloudResourceRef }
  | { kind: "loading"; ref: CloudResourceRef }
  | { kind: "ready"; ref: CloudResourceRef; page: CodeSummaryPage }
  | { kind: "error"; ref: CloudResourceRef };

const sameRef = (a: CloudResourceRef | undefined, b: CloudResourceRef | undefined) => a?.type === b?.type && a?.id === b?.id;
const stateFor = (initial: AssistantCodeBlockInitial | null | undefined): BlockState =>
  !initial
    ? { kind: "none" }
    : !initial.page
      ? { kind: "error", ref: initial.ref }
      : initial.page.items.length > 0
        ? { kind: "ready", ref: initial.ref, page: initial.page }
        : { kind: "none", ref: initial.ref };

/**
 * "Code of …" at the top of the panel: the Code the person may see for the place the page shows. A place whose type
 * can own Code but has none says so and offers to start with Gustav; any other place without Code shows nothing.
 * Loading errors stay visible with a retry. While a chat is open it folds to one line.
 */
export default function AssistantCodeBlock(props: {
  initial?: AssistantCodeBlockInitial | null;
  timeZone: string;
  /** A chat is open: the block starts folded. */
  chatOpen: boolean;
  disabled: boolean;
  onEdit: (ref: CloudResourceRef) => Promise<void> | void;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const [state, setState] = createSignal<BlockState>(stateFor(props.initial));
  const [open, setOpen] = createSignal(!props.chatOpen);
  const [editFailed, setEditFailed] = createSignal(false);
  const edit = async () => {
    const ref = currentRef();
    if (!ref) return;
    setEditFailed(false);
    try {
      await props.onEdit({ ...ref });
    } catch {
      setEditFailed(true);
    }
  };
  const [place, setPlace] = createSignal<CodePlace>(props.initial?.place ?? {});
  createEffect(
    on(
      () => props.chatOpen,
      (chatOpen) => setOpen(!chatOpen),
      { defer: true },
    ),
  );
  let generation = 0;
  const load = async (ref: CloudResourceRef, quiet: boolean) => {
    const request = ++generation;
    // A reload of a block that is on screen shows its rows loading in place; a new place stays hidden until it has Code.
    if (!quiet) setState({ kind: "loading", ref });
    try {
      const page = await loadCodeSummaries(browserCodeInvoke, { kind: "resource", ref });
      if (request === generation) setState(page.items.length > 0 ? { kind: "ready", ref, page } : { kind: "none", ref });
    } catch {
      if (request === generation) setState({ kind: "error", ref });
    }
  };
  const resolvePlace = async (ref: CloudResourceRef) => {
    try {
      const resource = await resolveAssistantCloudResource(ref);
      if (sameRef(currentRef(), ref))
        setPlace({ name: resource.name, type: resource.title, href: resource.href, canOwnCode: resource.canOwnCode });
    } catch {
      // The block still works without the place's name and link.
    }
  };
  const currentRef = () => state().ref;
  onMount(() => {
    const update = (ref: CloudResourceRef | undefined) => {
      if (sameRef(ref, currentRef())) return;
      generation++;
      setPlace({});
      setState({ kind: "none", ...(ref ? { ref: { ...ref } } : {}) });
      if (ref) void load({ ...ref }, true);
    };
    const initialRef = getContext()?.scope;
    if (!sameRef(initialRef, props.initial?.ref)) update(initialRef);
    onCleanup(onContextChange((context) => update(context?.scope)));
    onCleanup(() => generation++);
  });
  // The place's name, link and whether it could have Code; the server read the place it rendered.
  createEffect(
    on(
      () => state().ref,
      (ref, previous) => {
        // The server already read the place it rendered.
        if (!previous && props.initial?.place && sameRef(ref, props.initial.ref)) return;
        if (ref && !sameRef(ref, previous)) void resolvePlace(ref);
      },
    ),
  );
  const heading = () => (place().name ? t().codeOf({ title: place().name! }) : "");
  const page = () => {
    const current = state();
    return current.kind === "ready" ? current.page : null;
  };
  // Folded, the block names the status that needs the most attention.
  const summary = () => {
    const items = page()?.items ?? [];
    const order = ["failed", "paused", "deleting", "draft", "on"] as const;
    const keys = items.map((code) => codeStatus(code).key);
    const first = order.find((key) => keys.includes(key));
    return first ? codeStateLabel(first, locale()) : "";
  };

  const empty = () => state().kind === "none" && Boolean(state().ref) && place().canOwnCode === true;
  const actions = (label: string) => (
    <>
      <div class="assistant-code-block__actions">
        <Button type="button" size="sm" variant="secondary" disabled={props.disabled} onClick={() => void edit()}>
          <i class="ti ti-moustache" aria-hidden="true" />
          {label}
        </Button>
        <Show when={place().href}>
          {(href) => (
            <ButtonLink
              href={href()}
              size="sm"
              variant="ghost"
              aria-label={place().name ? t().codeOpenPlaceLabel({ title: place().name! }) : undefined}
            >
              <i class="ti ti-arrow-right" aria-hidden="true" />
              {t().codeOpenPlace({ type: place().type ?? "" })}
            </ButtonLink>
          )}
        </Show>
      </div>
      <Show when={editFailed()}>
        <p role="alert" class="assistant-code-block__note text-sm text-danger">
          {t().panelAttachFailed}
        </p>
      </Show>
    </>
  );

  return (
    <Show when={state().kind !== "none" || empty()}>
      <section class="assistant-code-block" data-state={state().kind} aria-label={`${t().codeBlock} ${heading()}`.trim()}>
        <button
          type="button"
          class="assistant-code-block__head"
          aria-expanded={open()}
          aria-label={open() ? t().codeHide : t().codeShow}
          onClick={() => setOpen(!open())}
        >
          <i class="ti ti-code" aria-hidden="true" />
          <span class="font-medium text-primary">{t().codeBlock}</span>
          <span class="min-w-0 truncate text-secondary">{heading()}</span>
          <span class="assistant-code-block__summary text-sm text-secondary">
            <Show when={!open()}>{summary()}</Show>
            <i class={open() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
          </span>
        </button>
        <Show when={open()}>
          <Show when={state().kind === "loading"}>
            <div class="assistant-code-block__rows" role="status" aria-busy="true" aria-label={t().codeBlock}>
              <For each={[0, 1]}>
                {() => (
                  <div class="assistant-code-block__row">
                    <Skeleton class="h-3.5 w-3.5 rounded" />
                    <Skeleton class="h-2.5 w-3/5" />
                    <Skeleton class="h-2.5 w-10" />
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={state().kind === "error"}>
            <div class="assistant-code-block__row" role="alert">
              <i class="ti ti-cloud-off text-danger" aria-hidden="true" />
              <span class="flex min-w-0 flex-col">
                <span class="text-primary">{t().codeBlockFailed({ title: place().name ?? t().codeBlock })}</span>
                <span class="text-sm text-secondary">{t().codeBlockFailedHint}</span>
              </span>
              <Button type="button" size="sm" variant="secondary" onClick={() => currentRef() && void load(currentRef()!, false)}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {t().codeBlockRetry}
              </Button>
            </div>
          </Show>
          <Show when={page()}>
            {(current) => (
              <>
                <ul class="assistant-code-block__rows">
                  <For each={current().items}>
                    {(code) => (
                      <li class="assistant-code-block__row">
                        <i class="ti ti-bolt text-secondary" aria-hidden="true" />
                        <span class="flex min-w-0 flex-col">
                          <span class="truncate text-primary">{code.title}</span>
                          <span class="truncate text-sm text-secondary">{codeRunLine(code, locale(), props.timeZone)}</span>
                        </span>
                        <CodeStatusBadge code={code} />
                      </li>
                    )}
                  </For>
                </ul>
                {actions(t().codeEditWithGustav)}
              </>
            )}
          </Show>
          <Show when={empty()}>
            <p class="assistant-code-block__note text-sm text-secondary">
              {place().name ? t().codeBlockEmpty({ name: place().name! }) : t().codeBlockEmptyHere}
            </p>
            {actions(t().codeCreateWithGustav)}
          </Show>
        </Show>
      </section>
    </Show>
  );
}
