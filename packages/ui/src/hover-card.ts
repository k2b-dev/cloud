/**
 * A separate entry for code that loads the hover card on demand. Imported from here, it stays out of an island's first
 * JavaScript, because the main entry no longer has to keep it.
 */
export { HoverCard, type HoverCardOptions, type HoverCardProps, type HoverCardTriggerProps } from "./feedback/HoverCard";
