import { notebooksYjs } from "../../../lib/yjs";
import type { YjsProviderOptions } from "./provider";
import { createYjsProvider } from "./provider";

export type { YjsProviderOptions };
export { createYjsProvider, notebooksYjs };

export const yjs = {
  createYjsProvider,
  notebooksYjs,
} as const;
