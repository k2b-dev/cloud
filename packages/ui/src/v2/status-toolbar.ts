import { createContext, onCleanup, useContext } from "solid-js";

/**
 * A pane learns that its status holds a toolbar of its list (a `StatusRow` or a `FilterBar`), not the line of state of
 * an open entry: only a toolbar joins the pane's head as one block. Each toolbar counts itself in while it is made and
 * out when it goes, so the server and the first render agree and a status that changes is read again.
 */
export const StatusToolbarContext = createContext<{ add: () => void; remove: () => void }>();

/** Called by a toolbar while it is made: in a pane's status, the head and this toolbar become one block. */
export const useStatusToolbar = () => {
  const toolbars = useContext(StatusToolbarContext);
  if (!toolbars) return;
  toolbars.add();
  onCleanup(toolbars.remove);
};
