import { CodeDisplay, canPreviewFile, dialogCore, FileView, PanelDialog, panelDialogWorkspaceOptions, useLocale } from "@k2b/ui";
import { onCleanup } from "solid-js";
import { apiClient } from "../../../api/client";
import { errorMessage } from "../utils/api-helpers";
import { documentMessages } from "./messages";
import type { PublicDocument } from "./public-document-types";

type Artifact = PublicDocument["artifacts"][number];
const fileFor = (artifact: Artifact) => ({ path: artifact.filename, mediaType: artifact.mimeType, size: artifact.sizeBytes });

export const canPreviewDocumentArtifact = (artifact: Artifact) =>
  ["text/csv", "application/json", "application/xml"].includes(artifact.mimeType) && canPreviewFile(fileFor(artifact));

export const openDocumentArtifactPreview = (documentId: string, artifact: Artifact) => {
  if (!canPreviewDocumentArtifact(artifact)) return;
  return dialogCore.open<void>(
    (close) => <DocumentArtifactPreviewDialog documentId={documentId} artifact={artifact} close={close} />,
    panelDialogWorkspaceOptions,
  );
};

function DocumentArtifactPreviewDialog(props: { documentId: string; artifact: Artifact; close: () => void }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  return (
    <PanelDialog>
      <PanelDialog.Header title={props.artifact.filename} subtitle={t().preview} close={props.close} />
      <PanelDialog.Body>
        <FileView
          file={fileFor(props.artifact)}
          load={async () => {
            const response = await apiClient.documents[":documentId"].artifacts[":artifactKey"].$get(
              { param: { documentId: props.documentId, artifactKey: props.artifact.key } },
              { init: { signal: abort.signal } },
            );
            if (!response.ok) throw new Error(await errorMessage(response, t().couldNotLoadPreviewData));
            return { encoding: "utf8", content: await response.text(), mediaType: props.artifact.mimeType };
          }}
          renderers={[
            {
              id: "document-csv-source",
              // Export CSV can use semicolons or a DATEV header. Do not guess a
              // comma-delimited table and show misleading financial columns.
              match: (_, content) => content.mediaType === "text/csv",
              component: (preview) => <CodeDisplay code={preview.content.content} language="text" />,
            },
          ]}
        />
      </PanelDialog.Body>
    </PanelDialog>
  );
}
