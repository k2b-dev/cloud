import { fileIcons } from "@k2b/stdlib";
import {
  CodeDisplay,
  CopyButton,
  canPreviewFile,
  dialogCore,
  FileView,
  Format,
  PanelDialog,
  panelDialogWorkspaceOptions,
  useLocale,
} from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
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
  return dialogCore.open<void>((close) => <DocumentArtifactPreviewDialog documentId={documentId} artifact={artifact} close={close} />, {
    ...panelDialogWorkspaceOptions,
    // Reading comes first: focus starts on the content, so arrow keys and Page Down scroll it at once.
    initialFocus: (dialog) => dialog.querySelector<HTMLElement>(".grids-artifact-preview__content"),
  });
};

/**
 * Follows the Files preview: the file name as the title, its type and size in a quiet line, copying in the header, and
 * the stored data on the dialog surface without a second frame, focused on open. The details dialog behind it already
 * dates the Document. The workspace frame keeps long export lines wide and takes the whole phone screen.
 */
function DocumentArtifactPreviewDialog(props: { documentId: string; artifact: Artifact; close: () => void }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  // The plain preview has no code box, so every format copies from the header, also JSON that does not parse.
  const [text, setText] = createSignal<string | null>(null);
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.artifact.filename}
        subtitle={
          <>
            <i
              class={`ti ${fileIcons.getFileIcon({ name: props.artifact.filename, type: "file", mimeType: props.artifact.mimeType })}`}
              aria-hidden="true"
            />{" "}
            <Format.Bytes value={props.artifact.sizeBytes} />
          </>
        }
        actions={<CopyButton size="sm" variant="ghost" text={text() ?? ""} disabled={text() === null} />}
        close={props.close}
      />
      <PanelDialog.Body>
        <div class="grids-artifact-preview__content flex min-w-0 flex-col outline-none" tabindex="-1">
          <FileView
            variant="plain"
            file={fileFor(props.artifact)}
            load={async () => {
              const response = await apiClient.documents[":documentId"].artifacts[":artifactKey"].$get(
                { param: { documentId: props.documentId, artifactKey: props.artifact.key } },
                { init: { signal: abort.signal } },
              );
              if (!response.ok) throw new Error(await errorMessage(response, t().couldNotLoadPreviewData));
              const content = await response.text();
              setText(content);
              return { encoding: "utf8", content, mediaType: props.artifact.mimeType };
            }}
            renderers={[
              {
                id: "document-csv-source",
                // Export CSV can use semicolons or a DATEV header. Do not guess a
                // comma-delimited table and show misleading financial columns.
                match: (_, content) => content.mediaType === "text/csv",
                component: (preview) => <CodeDisplay code={preview.content.content} language="text" copy={false} />,
              },
            ]}
          />
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}
