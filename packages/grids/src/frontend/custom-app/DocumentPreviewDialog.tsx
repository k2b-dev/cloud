import { InlineGuidance, PanelDialog, PdfViewer } from "@k2b/ui";
import { onCleanup } from "solid-js";
import type { CustomAppDocumentPreview } from "../../api/custom-app-published-page";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

/** The draft's PDF in one dialog: the viewer shows loading, the server's reason with a retry, or the document. */
export default function DocumentPreviewDialog(props: { entry: CustomAppDocumentPreview; close: () => void }) {
  const messages = useCustomAppRuntimeMessages();
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  return (
    <PanelDialog>
      <PanelDialog.Header title={messages().previewDocument} subtitle={props.entry.name} close={props.close} />
      <PanelDialog.Body scrollFade={false}>
        <div class="grids-document-preview">
          <InlineGuidance icon="ti ti-info-circle">{messages().previewDraftOnly}</InlineGuidance>
          <PdfViewer
            autoLoad
            open
            title={props.entry.name}
            request={() => fetch(props.entry.url, { method: "POST", signal: controller.signal, headers: { Accept: "application/pdf" } })}
          />
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}
