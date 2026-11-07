type UiScope = { primary: string | null; theme: "light" | "dark" };
let interactionEvent: WeakRef<Event> | undefined;
let interactionScope: UiScope | undefined;
export const PRIMARY_ATTRIBUTE = "data-k2b-primary";

const eventSource = (event?: Event) => event?.composedPath().find((node): node is Element => node instanceof Element);

const scopeFrom = (source: Element | undefined): UiScope => ({
  primary: source?.closest(`[${PRIMARY_ATTRIBUTE}]`)?.getAttribute(PRIMARY_ATTRIBUTE) ?? null,
  theme: (source?.ownerDocument.defaultView ?? window).getComputedStyle(source ?? document.body).colorScheme === "dark" ? "dark" : "light",
});

const liveInteraction = () => {
  const event = interactionEvent?.deref();
  return event?.eventPhase ? event : undefined;
};

// Capture before a menu's handler removes its trigger. Keep only palette values
// and a weak event reference, never the detached trigger or its document.
if (typeof document !== "undefined") {
  for (const type of ["click", "contextmenu", "keydown", "pointerdown", "pointerup"]) {
    document.addEventListener(
      type,
      (event) => {
        interactionEvent = new WeakRef(event);
        interactionScope = scopeFrom(eventSource(event));
      },
      true,
    );
  }
}

export const currentUiSource = (): Element | undefined => eventSource(liveInteraction()) ?? document.activeElement ?? undefined;

/** A trigger owns the palette during dispatch; programmatic opens use focused UI. */
export const readUiScope = (source?: Element | null): UiScope =>
  source ? scopeFrom(source) : ((liveInteraction() && interactionScope) ?? scopeFrom(currentUiSource()));

export const applyUiScope = (target: HTMLElement, scope: UiScope): void => {
  const data = target.dataset;
  if (scope.primary) data.k2bPrimary = scope.primary;
  else delete data.k2bPrimary;
  data.theme = scope.theme;
};

export const inheritUiScope = (target: HTMLElement, source?: Element): void => {
  applyUiScope(target, readUiScope(source));
};
