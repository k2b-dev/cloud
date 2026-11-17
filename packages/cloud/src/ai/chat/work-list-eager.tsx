/** Server and tests render the opened work eagerly; the browser loads it through `work-list-lazy.tsx`. */
export { AiWorkSteps } from "./work-list";

/** Nothing to load: the eager entry already holds the steps. */
export const preloadAiWorkSteps = (): Promise<void> => Promise.resolve();
