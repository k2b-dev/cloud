import { createContext, useContext } from "solid-js";

/**
 * A pane learns that its status is a toolbar of its list (a `StatusRow` or a `FilterBar`), not the line of state of an
 * open entry: only a toolbar joins the pane's head as one block. Told while the parts are made, so the server and the
 * first render agree.
 */
export const StatusToolbarContext = createContext<(() => void) | undefined>();

/** Called by a toolbar while it is made: in a pane's status, the head and this toolbar become one block. */
export const useStatusToolbar = () => useContext(StatusToolbarContext)?.();
