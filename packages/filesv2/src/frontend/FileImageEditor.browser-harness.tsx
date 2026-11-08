import { installPageSwap, swapPage } from "@k2b/ssr/nav";
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { EntryResult } from "../contracts";
import { openFilePreview } from "./FilePreviewDialog";

declare global {
  interface Window {
    fileImages: {
      open: (name?: string, options?: { write?: boolean; canCreate?: boolean; images?: boolean }) => void;
      saved: EntryResult[];
      leave: () => Promise<void>;
    };
  }
}
if (new URLSearchParams(location.search).has("nav")) installPageSwap();
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      {(() => {
        window.fileImages = {
          saved: [],
          leave: () => swapPage("/destination"),
          open: (name = "Photo.jpg", options = {}) => {
            const file = (fileName: string) => ({
              path: `Trips/${fileName}`,
              name: fileName,
              size: 10_000,
              directory: false,
              modified: "2026-11-07T10:00:00Z",
              revision: "revision-1",
              actions: { write: options.write ?? true, move: true, share: true },
            });
            void openFilePreview({
              baseId: "photos",
              entry: file(name),
              images: options.images ? [file(name), file("Beach.jpg")] : undefined,
              onDownload: () => {},
              imageEditing: {
                canCreate: options.canCreate ?? true,
                onSaved: (result) => {
                  window.fileImages.saved.push(result);
                },
              },
            });
          },
        };
        return (
          <button type="button" onClick={() => window.fileImages.open()}>
            Open photo
          </button>
        );
      })()}
    </LocaleProvider>
  ),
  root,
);
