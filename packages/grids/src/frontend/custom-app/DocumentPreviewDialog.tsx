import { Button, InlineGuidance, NoticeCard, PanelDialog, PdfPreview } from "@k2b/ui";
import { onCleanup } from "solid-js";
import type { CustomAppDocumentPreview } from "../../api/custom-app-published-page";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

export default function DocumentPreviewDialog(props: { entry: CustomAppDocumentPreview; close: () => void }) {
  const messages = useCustomAppRuntimeMessages();
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  return (
    <PdfPreview
      autoLoad
      title={props.entry.name}
      buttonLabel={messages().renderPreview}
      request={() => fetch(props.entry.url, { method: "POST", signal: controller.signal, headers: { Accept: "application/pdf" } })}
      renderError={(message) => (
        <NoticeCard tone="danger" role="alert" title={messages().previewUnavailable} detail={message}>
          <Button variant="secondary" size="sm" onClick={props.close}>
            <i class="ti ti-arrow-left" aria-hidden="true" />
            {messages().backToDraft}
          </Button>
        </NoticeCard>
      )}
    >
      {(preview) => (
        <PanelDialog>
          <PanelDialog.Header
            title={messages().previewDocument}
            subtitle={props.entry.name}
            actions={preview.actions}
            close={props.close}
          />
          <PanelDialog.Body scrollFade={false}>
            <div class="grids-document-preview">
              <InlineGuidance icon="ti ti-info-circle">{messages().previewDraftOnly}</InlineGuidance>
              {preview.content}
            </div>
          </PanelDialog.Body>
        </PanelDialog>
      )}
    </PdfPreview>
  );
}
