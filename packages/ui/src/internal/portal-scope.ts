let interaction: WeakRef<Event> | undefined;

// Safari can leave focus elsewhere when a button is clicked. During dispatch,
// the trigger owns the surface; programmatic opens fall back to focused UI.
// A weak reference retains neither a detached trigger nor its document.
if (typeof document !== "undefined") {
  for (const type of ["click", "contextmenu", "keydown", "pointerdown", "pointerup"]) {
    document.addEventListener(
      type,
      (event) => {
        interaction = new WeakRef(event);
      },
      true,
    );
  }
}

export const currentUiSource = (): Element | undefined => {
  const event = interaction?.deref();
  const trigger = event && event.eventPhase !== 0 ? event.composedPath().find((node) => node instanceof Element) : undefined;
  const source = trigger instanceof Element ? trigger : document.activeElement;
  return source instanceof Element ? source : undefined;
};

/** Detached UI roots keep their source's primary role and theme without moving into it. */
export const inheritUiScope = (target: HTMLElement, source = currentUiSource()): void => {
  const primary = source?.closest("[data-k2b-primary]")?.getAttribute("data-k2b-primary");
  if (primary) target.setAttribute("data-k2b-primary", primary);
  target.setAttribute("data-theme", getComputedStyle(source ?? document.body).colorScheme === "dark" ? "dark" : "light");
};
