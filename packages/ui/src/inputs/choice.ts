import { createEffect, createSignal, onCleanup, type Setter } from "solid-js";

export type ChoiceOption<T extends string = string> = {
  value: T;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  disabled?: boolean;
  /** Optional overlapping groups used by choice controls that expose group filtering. */
  groups?: readonly string[];
};

export type ChoiceOptionsLoader<T extends string = string> = (query: string, signal: AbortSignal) => Promise<readonly ChoiceOption<T>[]>;

export const filterChoiceOptions = <T extends string>(options: readonly ChoiceOption<T>[], query: string): readonly ChoiceOption<T>[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return options;
  return options.filter((option) =>
    [option.label, option.description, option.value].some((part) => part?.toLocaleLowerCase().includes(normalized)),
  );
};

export const nextEnabledChoiceIndex = <T extends string>(
  options: readonly ChoiceOption<T>[],
  current: number,
  direction: 1 | -1,
): number => {
  if (options.length === 0 || options.every((option) => option.disabled)) return -1;

  let index = current;
  for (let visited = 0; visited < options.length; visited += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "Failed to load options");

export function createChoiceLoader<T extends string>(
  loader: () => ChoiceOptionsLoader<T> | undefined,
  debounceMs: () => number,
): {
  options: () => readonly ChoiceOption<T>[];
  loading: () => boolean;
  error: () => string | undefined;
  load: (query: string, immediate?: boolean) => void;
  retry: () => void;
  cancel: () => void;
} {
  const [options, setOptions] = createSignal<readonly ChoiceOption<T>[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;
  let lastQuery = "";

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  };

  const run = async (query: string) => {
    const loadOptions = loader();
    if (!loadOptions) return;

    controller?.abort();
    controller = new AbortController();
    const currentController = controller;
    const currentRequest = ++request;
    setLoading(true);
    setError(undefined);

    try {
      const next = await loadOptions(query, currentController.signal);
      if (currentRequest === request && !currentController.signal.aborted) setOptions(next);
    } catch (reason) {
      if (currentRequest === request && !currentController.signal.aborted) {
        setOptions([]);
        setError(errorMessage(reason));
      }
    } finally {
      if (currentRequest === request) setLoading(false);
    }
  };

  const load = (query: string, immediate = false) => {
    lastQuery = query;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (immediate || debounceMs() <= 0) {
      void run(query);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void run(query);
    }, debounceMs());
  };

  onCleanup(cancel);
  return { options, loading, error, load, retry: () => load(lastQuery, true), cancel };
}

const popoverIsOpen = (popover: HTMLElement | undefined): boolean => {
  if (!popover) return false;
  try {
    return popover.matches(":popover-open");
  } catch {
    return false;
  }
};

export const placeChoicePopover = (trigger: HTMLElement, popover: HTMLElement): void => {
  const margin = 8;
  const gap = 4;
  const triggerRect = trigger.getBoundingClientRect();
  // Cloud sizes its dropdowns to the trigger exactly (`dialog.style.width =
  // rect.width`). Keep that so a narrow toolbar select does not open a wide
  // panel that no longer lines up with the control it belongs to.
  const width = Math.min(triggerRect.width, window.innerWidth - margin * 2);
  popover.style.width = `${width}px`;

  const popoverRect = popover.getBoundingClientRect();
  const left = Math.max(margin, Math.min(triggerRect.left, window.innerWidth - width - margin));
  const roomBelow = window.innerHeight - triggerRect.bottom - gap - margin;
  const roomAbove = triggerRect.top - gap - margin;
  const opensAbove = popoverRect.height > roomBelow && roomAbove > roomBelow;
  const top = opensAbove
    ? Math.max(margin, triggerRect.top - popoverRect.height - gap)
    : Math.min(triggerRect.bottom + gap, window.innerHeight - popoverRect.height - margin);

  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(margin, top)}px`;
};

export function createChoicePopover(disabled: () => boolean): {
  open: () => boolean;
  setTrigger: Setter<HTMLElement | undefined>;
  setPopover: Setter<HTMLElement | undefined>;
  show: () => void;
  hide: (restoreFocus?: boolean) => void;
  toggle: () => void;
  trigger: () => HTMLElement | undefined;
} {
  const [open, setOpen] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLElement>();
  const [popover, setPopover] = createSignal<HTMLElement>();

  const place = () => {
    const triggerElement = trigger();
    const popoverElement = popover();
    if (triggerElement && popoverElement && open()) placeChoicePopover(triggerElement, popoverElement);
  };

  const show = () => {
    const popoverElement = popover();
    if (disabled() || !popoverElement || popoverIsOpen(popoverElement)) return;
    popoverElement.showPopover();
    setOpen(true);
    queueMicrotask(place);
  };

  const hide = (restoreFocus = false) => {
    const popoverElement = popover();
    if (popoverIsOpen(popoverElement)) popoverElement?.hidePopover();
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => trigger()?.focus());
  };

  createEffect(() => {
    const popoverElement = popover();
    if (!popoverElement) return;
    const syncOpenState = () => setOpen(popoverIsOpen(popoverElement));
    const containWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();

      const target = event.target instanceof Element ? event.target : undefined;
      const groups = target?.closest<HTMLElement>(".k2b-choice-groups");
      const horizontalDelta = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
      if (groups && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) && groups.scrollWidth > groups.clientWidth) {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? groups.clientWidth : 1;
        groups.scrollLeft += horizontalDelta * unit;
        return;
      }

      const options = popoverElement.querySelector<HTMLElement>(".k2b-choice-options");
      if (!options || options.scrollHeight <= options.clientHeight) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? options.clientHeight : 1;
      options.scrollTop += event.deltaY * unit;
    };
    popoverElement.addEventListener("toggle", syncOpenState);
    popoverElement.addEventListener("wheel", containWheel, { passive: false });
    onCleanup(() => {
      popoverElement.removeEventListener("toggle", syncOpenState);
      popoverElement.removeEventListener("wheel", containWheel);
    });
  });

  createEffect(() => {
    if (!open()) return;

    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || trigger()?.contains(target) || popover()?.contains(target)) return;
      hide();
    };
    const reposition = () => place();

    // Async option lists arrive after the popover is already open, so the first
    // placement measures an empty panel. Re-place whenever the panel resizes,
    // otherwise a dropdown that grows past the viewport bottom stays clipped.
    const popoverElement = popover();
    const observer = popoverElement && typeof ResizeObserver !== "undefined" ? new ResizeObserver(reposition) : undefined;
    if (popoverElement) observer?.observe(popoverElement);

    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    onCleanup(() => {
      observer?.disconnect();
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    });
  });

  onCleanup(() => hide());
  return {
    open,
    setTrigger,
    setPopover,
    show,
    hide,
    toggle: () => (open() ? hide() : show()),
    trigger,
  };
}
