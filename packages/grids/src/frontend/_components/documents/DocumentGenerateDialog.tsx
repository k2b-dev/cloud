import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  dialogCore,
  NoticeCard,
  PanelDialog,
  PdfPreview,
  panelDialogFixedOptions,
  prompts,
  TagsInput,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { PublicTable as Table } from "../../../api/public-dto";
import RecordPicker from "../records/RecordPicker";
import { downloadPdfResponse } from "./document-download";
import { createDocumentGenerationAttempt } from "./document-generation-attempt";
import { isPdfResponse, requestDocumentTemplateGeneration, requestDocumentTemplatePreview } from "./document-transfer-client";
import { documentMessages } from "./messages";
import type { PublicDocumentTemplateSummary } from "./public-document-types";

type DocumentGenerateDialogArgs = {
  table: Pick<Table, "id" | "name">;
  template: PublicDocumentTemplateSummary;
  initialRecordId: string | null;
  mode?: "generate" | "generate-again";
  onGenerated: () => void | Promise<void>;
};

export const openDocumentGenerateDialog = (args: DocumentGenerateDialogArgs) =>
  dialogCore.open<void>((close) => <DocumentGenerateDialog args={args} close={close} />, {
    ...panelDialogFixedOptions,
    panelClassName: `${panelDialogFixedOptions.panelClassName} is-wide`,
  });

function DocumentGenerateDialog(props: { args: DocumentGenerateDialogArgs; close: () => void }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const attempt = createDocumentGenerationAttempt();
  const defaultDownloadFilename = `${props.args.template.name}.pdf`;
  const [recordId, setRecordId] = createSignal(props.args.initialRecordId ?? "");
  const [filename, setFilename] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [previewedRecordId, setPreviewedRecordId] = createSignal<string | null>(null);

  const setSelectedRecord = (next: string) => {
    if (attempt.request()) return;
    setRecordId(next);
    setPreviewedRecordId(null);
  };
  const hasCurrentPreview = () => {
    const selected = recordId().trim();
    return selected.length > 0 && previewedRecordId() === selected;
  };
  const previewPdf = async () => {
    if (attempt.request()) throw new Error(t().retryGenerationDetail);
    const selected = recordId().trim();
    if (!selected) throw new Error(t().chooseRecordFirst);
    setPreviewedRecordId(null);
    const res = await requestDocumentTemplatePreview({ templateId: props.args.template.id, recordId: selected });
    if (isPdfResponse(res)) setPreviewedRecordId(selected);
    return res;
  };

  const generateMut = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      if (!attempt.request()) {
        if (!recordId().trim()) throw new Error(t().chooseRecordFirst);
        if (!hasCurrentPreview()) throw new Error(t().previewBeforeGenerate);
      }
      const request =
        attempt.request() ??
        attempt.start({
          templateId: props.args.template.id,
          recordId: recordId().trim(),
          filename: filename().trim() || undefined,
          tags: tags(),
        });
      const res = await requestDocumentTemplateGeneration({
        ...request,
        signal: abortSignal,
      });
      await downloadPdfResponse(res, request.filename || defaultDownloadFilename, locale());
    },
    onSuccess: async () => {
      await props.args.onGenerated();
      props.close();
    },
    onError: (error) => prompts.error(error.message),
  });

  const startNewAttempt = async () => {
    if (generateMut.loading()) return;
    if (!(await prompts.confirm(t().newGenerationAttemptDetail, { title: t().newGenerationAttempt }))) return;
    attempt.reset();
    setPreviewedRecordId(null);
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().generateTitle({
          action: props.args.mode === "generate-again" ? t().generateAgain : t().generate,
          template: props.args.template.name,
        })}
        subtitle={props.args.table.name}
        icon="ti ti-file-type-pdf"
        close={props.close}
      />
      <PanelDialog.Body>
        <section class="flex shrink-0 flex-col gap-2">
          <RecordPicker
            tableId={props.args.table.id}
            templateId={props.args.template.id}
            value={recordId}
            onChange={setSelectedRecord}
            label={t().record}
            description={t().recordDescription}
            placeholder={t().searchRecords}
            disabled={() => attempt.request() !== null}
          />
          <Show when={props.args.template.renderer.kind === "html"}>
            <TextInput
              label={t().filename}
              description={t().optionalTemplateFilename}
              value={filename}
              onValueChange={setFilename}
              icon="ti ti-file-text"
              placeholder={t().useTemplateDefault}
              disabled={attempt.request() !== null}
            />
          </Show>
          <TagsInput
            label={t().tags}
            description={t().tagsDescription}
            placeholder={t().tagsPlaceholder}
            value={tags}
            onValueChange={setTags}
            disabled={attempt.request() !== null}
          />
          <NoticeCard tone="info" title={t().immutableGeneratedDocument} detail={t().immutableGeneratedDocumentDetail} />
        </section>
        <Show
          when={!attempt.request()}
          fallback={<NoticeCard tone="info" title={t().retryGeneration} detail={t().retryGenerationDetail} />}
        >
          <PdfPreview
            title={t().pdfPreview}
            class="h-[min(56rem,62dvh)] min-h-[36rem] shrink-0"
            buttonLabel={t().renderPreview}
            emptyText={t().chooseRecordAndPreview}
            disabled={() => !recordId().trim()}
            request={previewPdf}
          />
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Show when={attempt.request()} fallback={<span />}>
          <Button variant="secondary" size="sm" type="button" onClick={startNewAttempt} disabled={generateMut.loading()}>
            {t().newGenerationAttempt}
          </Button>
        </Show>
        <div class="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={props.close} disabled={generateMut.loading()}>
            {t().cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => generateMut.mutate(undefined)}
            disabled={generateMut.loading() || (!attempt.request() && !hasCurrentPreview())}
          >
            {generateMut.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-download" />}
            {attempt.request() ? t().retryGeneration : props.args.mode === "generate-again" ? t().generateAgain : t().generateDocument}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
