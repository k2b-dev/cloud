import { canPreviewFile, type FileViewContent, formatFileViewSize, Lightbox, toast } from "@k2b/ui";
import { render } from "solid-js/web";
import { apiClient } from "../../../api/client";
import { errorMessage } from "../utils/api-helpers";
import { documentMessages } from "./messages";
import type { PublicDocument } from "./public-document-types";

type Artifact = PublicDocument["artifacts"][number];
const fileFor = (artifact: Artifact) => ({ path: artifact.filename, mediaType: artifact.mimeType, size: artifact.sizeBytes });

export const canPreviewDocumentArtifact = (artifact: Artifact) =>
  ["text/csv", "application/json", "application/xml"].includes(artifact.mimeType) && canPreviewFile(fileFor(artifact));

/**
 * Shows a stored CSV, XML or JSON export in the Lightbox, above the details dialog it was opened from: the file name
 * and size at the top, Copy text and Download in the action pill, the data as plain text. Export CSV can use
 * semicolons or a DATEV header, so it shows as its source instead of a guessed table with misleading columns.
 */
export const openDocumentArtifactPreview = (documentId: string, artifact: Artifact): void => {
  if (!canPreviewDocumentArtifact(artifact)) return;
  const t = documentMessages.resolve([document.documentElement.lang || "en"]).t;
  const abort = new AbortController();
  let text: string | undefined;
  const load = async (): Promise<FileViewContent> => {
    const response = await apiClient.documents[":documentId"].artifacts[":artifactKey"].$get(
      { param: { documentId, artifactKey: artifact.key } },
      { init: { signal: abort.signal } },
    );
    if (!response.ok) throw new Error(await errorMessage(response, t.couldNotLoadPreviewData));
    text = await response.text();
    return { encoding: "utf8", content: text, mediaType: artifact.mimeType === "text/csv" ? "text/plain" : artifact.mimeType };
  };
  const item = {
    name: artifact.filename,
    meta: formatFileViewSize(artifact.sizeBytes, document.documentElement.lang || "en"),
    // The renderer follows the file: a CSV reads as plain text, never as a table.
    file: artifact.mimeType === "text/csv" ? { path: `${artifact.filename}.txt`, mediaType: "text/plain" } : fileFor(artifact),
    load,
    downloadUrl: artifact.downloadUrl,
    actions: [
      {
        label: t.copyText,
        icon: "ti ti-copy",
        onClick: () => {
          if (text === undefined) return;
          void navigator.clipboard.writeText(text).then(
            () => toast.success(t.textCopied),
            () => toast.error(t.textNotCopied),
          );
        },
      },
    ],
  };
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(
    () => (
      <Lightbox
        items={[item]}
        index={0}
        onIndexChange={() => undefined}
        onClose={() => {
          abort.abort();
          queueMicrotask(() => {
            dispose();
            host.remove();
          });
        }}
      />
    ),
    host,
  );
};
