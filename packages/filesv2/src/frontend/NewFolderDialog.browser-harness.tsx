import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { FolderBatchResult } from "../contracts";
import { openNewFolderDialog } from "./NewFolderDialog";

declare global {
  interface Window {
    newFolder: {
      open: (options?: { parent?: string }) => void;
      result: FolderBatchResult | "cancelled" | null;
      partials: number;
    };
  }
}

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      {(() => {
        window.newFolder = {
          result: null,
          partials: 0,
          open: (options) => {
            window.newFolder.result = null;
            window.newFolder.partials = 0;
            void openNewFolderDialog({
              title: "New folder",
              baseId: "base-1",
              parent: options?.parent ?? "Projects/2026",
              location: "My files",
              onPartial: () => window.newFolder.partials++,
            }).then((result) => {
              window.newFolder.result = result ?? "cancelled";
            });
          },
        };
        return null;
      })()}
    </LocaleProvider>
  ),
  host,
);
