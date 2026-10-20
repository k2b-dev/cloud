import { hintOpen } from "@k2b/cloud/ssr";
import type { Context } from "hono";

/** Keep the sidebar hint last because its target only exists at desktop widths. */
export const spaceHintCandidates = (spaceCount: number) => [
  { id: "spaces.view-tabs", allowed: true },
  { id: "spaces.space-menu", allowed: true },
  { id: "spaces.sidebar-switch", allowed: spaceCount >= 2 },
];

/** A page chooses one migration hint without consuming the others. */
export const firstOpenSpacesHint = (c: Context, candidates: { id: string; allowed: boolean }[]) =>
  candidates.find(({ id, allowed }) => hintOpen(c, id, { allowed }))?.id;
