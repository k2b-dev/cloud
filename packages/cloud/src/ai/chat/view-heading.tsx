import { type JSX, Show } from "solid-js";

/**
 * A view's title and subtitle: the loaded file's once it is there, its summary's before. The subtitle is the quiet line
 * of the head, in the same step as a chart's in its island (Feinschliff v3: title 14/600, subtitle 12/400).
 */
export function ViewHeading(props: { id: string; title: string; subtitle?: string; actions?: JSX.Element }) {
  return (
    <header class="cloud-view-heading flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0">
        <h3 id={props.id} class="m-0 text-sm font-semibold">
          {props.title}
        </h3>
        <Show when={props.subtitle}>
          {(subtitle) => <span class="block text-xs leading-5 text-[var(--k2b-text-muted)]">{subtitle()}</span>}
        </Show>
      </div>
      {props.actions}
    </header>
  );
}
