import { Button, PanelDialog, Skeleton } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";

/** One place in the sources column: This device or an application from the capability catalog. */
export type FileDialogSource = { id: string; name: string; icon: string };

/**
 * The frame both file dialogs share: the title, the sources on the left (tabs on a phone), the toolbar row and the
 * content on the right, and a footer with the status and the actions. The frame keeps one size in every state.
 */
export function FileDialogFrame(props: {
  ref?: (element: HTMLDivElement) => void;
  title: string;
  close: () => void;
  sources: JSX.Element;
  /** The path and filter row; without it, the content starts at the top of the column. */
  toolbar?: JSX.Element;
  children: JSX.Element;
  /** Covers the dialog while files are dragged over it. */
  overlay?: JSX.Element;
  status: JSX.Element;
  statusError?: boolean;
  actions: JSX.Element;
}): JSX.Element {
  return (
    <PanelDialog>
      {/* `display: contents`, so header, body, and footer stay the panel's own rows. */}
      <div ref={props.ref} class="cloud-file-chooser cloud-file-dialog">
        <PanelDialog.Header title={props.title} close={props.close} />
        {props.overlay}
        <div class="cloud-file-dialog__body">
          {props.sources}
          <div class="cloud-file-dialog__main" data-toolbar={props.toolbar ? "true" : undefined}>
            <Show when={props.toolbar}>{props.toolbar}</Show>
            <div class="cloud-file-dialog__content">{props.children}</div>
          </div>
        </div>
        <PanelDialog.Footer>
          <span class="cloud-file-chooser__status" role="status" data-error={props.statusError ? "true" : undefined}>
            {props.status}
          </span>
          <div class="cloud-file-chooser__actions">{props.actions}</div>
        </PanelDialog.Footer>
      </div>
    </PanelDialog>
  );
}

/**
 * The sources column. While the catalog loads, two placeholder rows hold the place of the applications, and a failed
 * load leaves one row with Try again in the same height, so nothing below moves. Arrow keys move between sources;
 * only a click, Enter, or Space opens one.
 */
export function FileDialogSources(props: {
  label: string;
  rows: readonly FileDialogSource[];
  current: string | undefined;
  state: "loading" | "ready" | "error";
  loading: string;
  failed: string;
  retry: string;
  disabled: boolean;
  onOpen: (row: FileDialogSource) => void;
  onRetry: () => void;
}): JSX.Element {
  let list: HTMLUListElement | undefined;
  const move = (event: KeyboardEvent) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step || !list) return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>(".cloud-file-dialog__source:not(:disabled)")];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = buttons[index + step];
    if (index < 0 || !next) return;
    event.preventDefault();
    next.focus();
  };
  return (
    <nav class="cloud-file-dialog__sources" aria-label={props.label}>
      <ul ref={list} onKeyDown={move}>
        <For each={props.rows}>
          {(row) => (
            <li>
              <button
                type="button"
                class="cloud-file-dialog__source"
                aria-current={props.current === row.id ? "true" : undefined}
                disabled={props.disabled}
                onClick={() => props.onOpen(row)}
              >
                <span class="cloud-file-dialog__chip" aria-hidden="true">
                  <i class={row.icon} />
                </span>
                <span class="cloud-file-dialog__source-name">{row.name}</span>
              </button>
            </li>
          )}
        </For>
        <Show when={props.state === "loading"}>
          <li class="cloud-file-dialog__source-skeleton" aria-hidden="true">
            <Skeleton class="cloud-file-dialog__skeleton-chip" />
            <Skeleton class="cloud-file-dialog__skeleton-text" />
          </li>
          <li class="cloud-file-dialog__source-skeleton" aria-hidden="true">
            <Skeleton class="cloud-file-dialog__skeleton-chip" />
            <Skeleton class="cloud-file-dialog__skeleton-text is-short" />
          </li>
          <li class="k2b-sr-only" role="status">
            {props.loading}
          </li>
        </Show>
        <Show when={props.state === "error"}>
          <li class="cloud-file-dialog__source-error" role="status">
            <span>
              <i class="ti ti-alert-triangle" aria-hidden="true" /> {props.failed}
            </span>
            <Button size="sm" variant="secondary" onClick={props.onRetry}>
              {props.retry}
            </Button>
          </li>
        </Show>
      </ul>
    </nav>
  );
}

/** Rows of fixed height that stand where a folder's entries will appear, so the list does not move when they arrive. */
export function FileDialogSkeletonRows(props: { label: string }): JSX.Element {
  return (
    <div class="cloud-file-dialog__skeleton-rows">
      <For each={[0, 1, 2, 3, 4, 5]}>
        {(index) => (
          <div class="cloud-file-dialog__skeleton-row" aria-hidden="true">
            <span />
            <Skeleton class="cloud-file-dialog__skeleton-tile" />
            <span class="cloud-file-dialog__skeleton-lines">
              <Skeleton class={`cloud-file-dialog__skeleton-text is-${index % 3}`} />
              <Skeleton class="cloud-file-dialog__skeleton-meta" />
            </span>
          </div>
        )}
      </For>
      <span class="k2b-sr-only" role="status">
        {props.label}
      </span>
    </div>
  );
}
