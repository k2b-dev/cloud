import { hintOpen } from "@k2b/cloud/ssr";
import type { Context } from "hono";

/** A page chooses one migration hint without consuming the others. */
export const firstOpenSpacesHint = (c: Context, candidates: { id: string; allowed: boolean }[]) =>
  candidates.find(({ id, allowed }) => hintOpen(c, id, { allowed }))?.id;
