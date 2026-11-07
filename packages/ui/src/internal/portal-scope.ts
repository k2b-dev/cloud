type UiScope = { primary: string | null; theme: "light" | "dark" };
let interaction: { event: WeakRef<Event>; scope: UiScope } | undefined;

const scopeFrom = (source: Element | undefined): UiScope => ({
  primary: source?.closest("[data-k2b-primary]")?.getAttribute("data-k2b-primary") ?? null,
  theme: (source?.ownerDocument.defaultView ?? window).getComputedStyle(source ?? document.body).colorScheme === "dark" ? "dark" : "light",
});

const liveInteraction = () => {
  const event = interaction?.event.deref();
  return event && event.eventPhase !== 0 ? event : undefined;
};

// Capture before a menu's handler removes its trigger. Keep only palette values
// and a weak event reference, never the detached trigger or its document.
if (typeof document !== "undefined") {
  for (const type of ["click", "contextmenu", "keydown", "pointerdown", "pointerup"]) {
    document.addEventListener(
      type,
      (event) => {
        const source = event.composedPath().find((node): node is Element => node instanceof Element);
        interaction = { event: new WeakRef(event), scope: scopeFrom(source) };
      },
      true,
    );
  }
}

export const currentUiSource = (): Element | undefined => {
  const trigger = liveInteraction()
    ?.composedPath()
    .find((node) => node instanceof Element);
  const source = trigger instanceof Element ? trigger : document.activeElement;
  return source instanceof Element ? source : undefined;
};

/** A trigger owns the palette during dispatch; programmatic opens use focused UI. */
export const readUiScope = (source?: Element): UiScope =>
  source ? scopeFrom(source) : liveInteraction() && interaction ? interaction.scope : scopeFrom(currentUiSource());

export const applyUiScope = (target: HTMLElement, scope: UiScope): void => {
  if (scope.primary) target.setAttribute("data-k2b-primary", scope.primary);
  else target.removeAttribute("data-k2b-primary");
  target.setAttribute("data-theme", scope.theme);
};

export const inheritUiScope = (target: HTMLElement, source?: Element): void => {
  applyUiScope(target, readUiScope(source));
};
