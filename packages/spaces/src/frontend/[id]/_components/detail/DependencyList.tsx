import { IconButton } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import { useSpaceMessages } from "../../messages";

export type DependencyEntry = { id: string; title: string; completedAt: string | null };

type Props = {
  entries: readonly DependencyEntry[];
  /** Blockers show a lock while open; tasks waiting on this one show an empty circle. */
  kind: "blocker" | "dependent";
  href: (id: string) => string;
  /** Present only for editors of blockers: a remove button revealed on hover. */
  onRemove?: (id: string) => void;
  removeDisabled?: boolean;
  /** The last line, such as the add action. */
  footer?: JSX.Element;
};

/** From this many entries on, the list shows {@link COLLAPSED_COUNT} and folds the rest behind "N more". */
const COLLAPSE_FROM = 5;
const COLLAPSED_COUNT = 3;

/** Linked tasks as the value of a planning row: title and state per line, open tasks first. */
export default function DependencyList(props: Props) {
  const t = useSpaceMessages();
  const [expanded, setExpanded] = createSignal(false);
  const ordered = () => [...props.entries].sort((left, right) => Number(Boolean(left.completedAt)) - Number(Boolean(right.completedAt)));
  const collapsible = () => ordered().length >= COLLAPSE_FROM;
  const visible = () => (collapsible() && !expanded() ? ordered().slice(0, COLLAPSED_COUNT) : ordered());
  const icon = (entry: DependencyEntry) => (entry.completedAt ? "ti-circle-check" : props.kind === "blocker" ? "ti-lock" : "ti-circle");
  const state = (entry: DependencyEntry) => (entry.completedAt ? "done" : props.kind === "blocker" ? "open" : "waiting");

  return (
    <ul class="spaces-dependencies" data-spaces-dependencies={props.kind}>
      <For each={visible()}>
        {(entry) => (
          <li class="spaces-dependency" data-state={state(entry)}>
            <a class="spaces-dependency__link" href={props.href(entry.id)}>
              <i class={`ti ${icon(entry)} spaces-dependency__icon`} aria-hidden="true" />
              <span class="spaces-dependency__title">{entry.title}</span>
              <Show when={entry.completedAt} fallback={<span class="sr-only">, {t.dependencyOpen}</span>}>
                <span class="spaces-dependency__state">
                  <span class="sr-only">, </span>
                  {t.dependencyDone}
                </span>
              </Show>
            </a>
            <Show when={props.onRemove}>
              {(remove) => (
                <IconButton
                  size="xs"
                  variant="ghost"
                  class="spaces-dependency__remove"
                  label={t.removeBlockerNamed({ title: entry.title })}
                  disabled={props.removeDisabled}
                  onClick={() => remove()(entry.id)}
                >
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              )}
            </Show>
          </li>
        )}
      </For>
      <Show when={collapsible()}>
        <li class="spaces-dependency">
          <button
            type="button"
            class="spaces-dependency__link spaces-dependency__more"
            aria-expanded={expanded()}
            onClick={() => setExpanded(!expanded())}
          >
            <i class={`ti ${expanded() ? "ti-chevron-up" : "ti-chevron-down"} spaces-dependency__icon`} aria-hidden="true" />
            <span class="spaces-dependency__title">
              {expanded() ? t.fewerDependencies : t.moreDependencies({ count: ordered().length - COLLAPSED_COUNT })}
            </span>
          </button>
        </li>
      </Show>
      <Show when={props.footer}>
        <li class="spaces-dependency spaces-dependency--footer">{props.footer}</li>
      </Show>
    </ul>
  );
}
