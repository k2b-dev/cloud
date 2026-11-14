import { encoding } from "@k2b/stdlib";
import { type LightboxItem, toast } from "@k2b/ui";
import type { CustomAppDocumentPreview } from "../../api/custom-app-published-page";

/** How long an opened tab's temporary address stays valid; the tab has read the PDF long before. */
const TAB_ADDRESS_MS = 60_000;

/**
 * A draft's PDF in the Lightbox. The server renders it from the saved draft when it is shown, again on "Try again";
 * a refusal names its reason, such as a missing due date, in a notice beside the Lightbox's own failure state.
 * The rendered PDF also opens in a browser tab, as the preview dialog offered, for example to print it.
 */
export const documentPreviewItem = (
  entry: CustomAppDocumentPreview,
  messages: { previewDraftMeta: string; previewDocumentFailed: string; previewOpenInTab: string },
  signal: AbortSignal,
): LightboxItem => {
  let rendered: Blob | null = null;
  return {
    name: entry.name,
    meta: messages.previewDraftMeta,
    file: { path: `${entry.name}.pdf`, mediaType: "application/pdf" },
    load: async (shown) => {
      const response = await fetch(entry.url, {
        method: "POST",
        signal: AbortSignal.any([signal, shown]),
        headers: { Accept: "application/pdf" },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        const reason = body?.message || messages.previewDocumentFailed;
        if (!signal.aborted && !shown.aborted) toast.error(reason);
        throw new Error(reason);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      rendered = new Blob([bytes], { type: "application/pdf" });
      return { encoding: "base64", content: encoding.toBase64(bytes), mediaType: "application/pdf" };
    },
    actions: [
      {
        label: messages.previewOpenInTab,
        icon: "ti ti-external-link",
        onClick: () => {
          if (!rendered) return;
          const address = URL.createObjectURL(rendered);
          window.open(address, "_blank");
          setTimeout(() => URL.revokeObjectURL(address), TAB_ADDRESS_MS);
        },
      },
    ],
  };
};
