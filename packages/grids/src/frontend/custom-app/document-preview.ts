import { encoding } from "@k2b/stdlib";
import { type LightboxItem, toast } from "@k2b/ui";
import type { CustomAppDocumentPreview } from "../../api/custom-app-published-page";

/**
 * A draft's PDF in the Lightbox. The server renders it from the saved draft when it is shown, again on "Try again";
 * a refusal names its reason, such as a missing due date, in a notice beside the Lightbox's own failure state.
 */
export const documentPreviewItem = (
  entry: CustomAppDocumentPreview,
  messages: { previewDraftMeta: string; previewDocumentFailed: string },
  signal: AbortSignal,
): LightboxItem => ({
  name: entry.name,
  meta: messages.previewDraftMeta,
  file: { path: `${entry.name}.pdf`, mediaType: "application/pdf" },
  load: async () => {
    const response = await fetch(entry.url, { method: "POST", signal, headers: { Accept: "application/pdf" } });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      const reason = body?.message || messages.previewDocumentFailed;
      if (!signal.aborted) toast.error(reason);
      throw new Error(reason);
    }
    return { encoding: "base64", content: encoding.toBase64(new Uint8Array(await response.arrayBuffer())), mediaType: "application/pdf" };
  },
});
