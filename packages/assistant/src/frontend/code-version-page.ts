import type { CodeVersionPreview } from "./code-activation";

/** The Code page of this Code: a personal Code's page in Gustav, or the Code page its owner's app declares. */
export const codeVersionPageHref = (preview: Pick<CodeVersionPreview, "ownerKind" | "codeId" | "page">): string | null =>
  preview.ownerKind === "person" ? `/app/assistant/code/${preview.codeId}` : (preview.page ?? null);
