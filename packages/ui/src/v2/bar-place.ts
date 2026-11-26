import { createContext, onCleanup, useContext } from "solid-js";

/** A place of a `Bar`, its start or its end, which hears what stands in it. */
type BarPlace = { place: "start" | "end"; mark: () => () => void };

export const BarPlaceContext = createContext<BarPlace>();

/**
 * Tells the bar what stands in one of its places, already as the server renders it: a `Text` in its start names the
 * page (the bar's `data-title`), the "…" at its end takes in what gives way (`data-more`). The head's rules ask these
 * marks instead of a `:has()`, which a change deep in the page would make the browser check again and again.
 */
export const markBarPlace = (place: "start" | "end") => {
  const bar = useContext(BarPlaceContext);
  // the mark goes with the part that made it
  if (bar?.place === place) onCleanup(bar.mark());
};
