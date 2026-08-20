import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";

type ChoiceGroup = { value: string | null; label: string };

export function ChoiceGroups(props: {
  choices: readonly ChoiceGroup[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  ariaLabel: string;
  controls: string;
}): JSX.Element {
  let viewport: HTMLDivElement | undefined;
  let buttons: HTMLButtonElement[] = [];
  let dragOffset = 0;
  const [scrollbar, setScrollbar] = createSignal({ overflow: false, left: 0, width: 0 });

  const syncScrollbar = () => {
    if (!viewport) return;
    const { clientWidth, scrollLeft, scrollWidth } = viewport;
    if (clientWidth <= 0 || scrollWidth <= clientWidth) {
      setScrollbar({ overflow: false, left: 0, width: 0 });
      return;
    }
    const width = Math.min(clientWidth, Math.max(24, (clientWidth * clientWidth) / scrollWidth));
    const left = (scrollLeft / (scrollWidth - clientWidth)) * (clientWidth - width);
    setScrollbar({ overflow: true, left, width });
  };

  const choose = (index: number, focus = false) => {
    const choice = props.choices[index];
    if (!choice) return;
    props.onValueChange(choice.value);
    if (!focus) return;
    queueMicrotask(() => {
      buttons[index]?.focus();
      buttons[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };
  const move = (index: number, direction: 1 | -1) =>
    choose((index + direction + props.choices.length) % props.choices.length, true);
  const focusEdge = (last: boolean) => choose(last ? props.choices.length - 1 : 0, true);

  const scrollFromPointer = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!viewport) return;
    const track = event.currentTarget;
    const { width } = scrollbar();
    const rect = track.getBoundingClientRect();
    const available = Math.max(1, rect.width - width);
    const thumbLeft = Math.min(available, Math.max(0, event.clientX - rect.left - dragOffset));
    viewport.scrollLeft = (thumbLeft / available) * (viewport.scrollWidth - viewport.clientWidth);
    syncScrollbar();
  };
  const startScrollbarDrag = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    event.preventDefault();
    const track = event.currentTarget;
    const current = scrollbar();
    dragOffset =
      event.target === track
        ? current.width / 2
        : Math.min(current.width, Math.max(0, event.clientX - track.getBoundingClientRect().left - current.left));
    track.setPointerCapture(event.pointerId);
    scrollFromPointer(event);
  };

  onMount(() => {
    syncScrollbar();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncScrollbar);
    if (viewport) observer?.observe(viewport);
    onCleanup(() => observer?.disconnect());
  });
  createEffect(() => {
    props.choices.map((choice) => `${choice.value ?? ""}:${choice.label}`).join("|");
    queueMicrotask(syncScrollbar);
  });

  return (
    <div class="k2b-choice-groups-shell" onPointerEnter={syncScrollbar} onFocusIn={syncScrollbar}>
      <div
        ref={viewport}
        class="k2b-choice-groups"
        role="radiogroup"
        aria-label={props.ariaLabel}
        onScroll={syncScrollbar}
      >
        <For each={props.choices}>
          {(group, index) => (
            <button
              ref={(element) => (buttons[index()] = element)}
              type="button"
              role="radio"
              aria-checked={props.value === group.value}
              aria-controls={props.controls}
              tabIndex={props.value === group.value ? 0 : -1}
              onClick={() => choose(index())}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  move(index(), 1);
                } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  move(index(), -1);
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  focusEdge(event.key === "End");
                }
              }}
            >
              {group.label}
            </button>
          )}
        </For>
      </div>
      <Show when={scrollbar().overflow}>
        <div
          class="k2b-choice-groups-scrollbar"
          aria-hidden="true"
          onPointerDown={startScrollbarDrag}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) scrollFromPointer(event);
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
          onPointerCancel={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        >
          <span
            style={{
              "--k2b-choice-scroll-left": `${scrollbar().left}px`,
              "--k2b-choice-scroll-width": `${scrollbar().width}px`,
            }}
          />
        </div>
      </Show>
    </div>
  );
}
