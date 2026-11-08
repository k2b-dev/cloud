import { type JSX, Show } from "solid-js";

/** A view's title and subtitle: the loaded file's once it is there, its summary's before. */
export function ViewHeading(props: { id: string; title: string; subtitle?: string; actions?: JSX.Element }) {
  return (
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0">
        <h3 id={props.id} class="m-0 text-base font-semibold">
          {props.title}
        </h3>
        <Show when={props.subtitle}>{(subtitle) => <span class="text-sm text-secondary">{subtitle()}</span>}</Show>
      </div>
      {props.actions}
    </header>
  );
}
