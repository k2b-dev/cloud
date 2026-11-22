/**
 * @k2b/ui v2 (spike draft, Solid 2). Three layers, each with one owner:
 * - tokens and every primitive's look: `v2.css` (one stylesheet);
 * - structure: the static primitives (server-rendered, no state);
 * - behaviour: ui-sdk inside the overlay wrappers, plus the framework-free overlay scrollbar.
 */
export * from "./primitives";
export { iconPaths, type IconName } from "./icons";
export { installOverlayScrollbars, observeOverlayScrollbar } from "./overlay-scrollbar";
