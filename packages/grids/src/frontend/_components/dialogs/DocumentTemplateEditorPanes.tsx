import { Panes, type PanesLayout, PdfPreview, TemplateEditor, type TemplateVariable, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import type { DocumentPreviewResponse } from "../../../contracts";
import { documentMessages } from "../documents/messages";
import { DocumentDataTree, RenderedDocumentSource } from "./DocumentTemplatePreviewData";

type TemplateSnippet = {
  id: string;
  title: string | Accessor<string>;
  icon: string;
  value: Accessor<string>;
  onInput: (value: string) => void;
  placeholder: string;
};

type Props = {
  rendererKind: Accessor<"html" | "profile">;
  body: Accessor<string>;
  setBody: (value: string) => void;
  header: Accessor<string>;
  setHeader: (value: string) => void;
  footer: Accessor<string>;
  setFooter: (value: string) => void;
  css: Accessor<string>;
  setCss: (value: string) => void;
  templateVariables: Accessor<TemplateVariable[]>;
  previewData: Accessor<DocumentPreviewResponse | null>;
  previewDataLoading: Accessor<boolean>;
  previewDataError: Accessor<string | null>;
  source: Accessor<string>;
  previewRecordId: Accessor<string>;
  previewPdf: () => Promise<Response>;
  disabled?: Accessor<boolean>;
  bodyError?: Accessor<string | undefined>;
};

const createPanesLayout = (rendererKind: "html" | "profile"): PanesLayout => ({
  version: 2,
  root: {
    type: "split",
    direction: "horizontal",
    ratio: 0.58,
    first: { type: "group", items: rendererKind === "html" ? ["body", "header", "footer", "css"] : ["body"], active: "body" },
    second: { type: "group", items: ["preview", "data", "source"], active: "preview" },
  },
});

export function DocumentTemplateEditorPanes(props: Props) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  let rendererKind = props.rendererKind();
  const [layout, setLayout] = createSignal(createPanesLayout(rendererKind));
  createEffect(() => {
    if (props.rendererKind() === rendererKind) return;
    rendererKind = props.rendererKind();
    setLayout(createPanesLayout(rendererKind));
  });
  const snippets: TemplateSnippet[] = [
    {
      id: "body",
      title: () => (props.rendererKind() === "html" ? t().htmlBody : t().rendererInput),
      icon: "ti ti-braces",
      value: props.body,
      onInput: props.setBody,
      placeholder: t().bodyPlaceholder,
    },
    {
      id: "header",
      title: t().header,
      icon: "ti ti-layout-navbar",
      value: props.header,
      onInput: props.setHeader,
      placeholder: t().headerPlaceholder,
    },
    {
      id: "footer",
      title: t().footer,
      icon: "ti ti-layout-bottombar",
      value: props.footer,
      onInput: props.setFooter,
      placeholder: t().footerPlaceholder,
    },
    {
      id: "css",
      title: t().pageCss,
      icon: "ti ti-braces",
      value: props.css,
      onInput: props.setCss,
      placeholder: "@page { size: A4; margin: 28mm 14mm 22mm; }",
    },
  ];
  const items = createMemo(() => [
    ...snippets
      .filter((snippet) => props.rendererKind() === "html" || snippet.id === "body")
      .map((snippet) => ({
        id: snippet.id,
        title: typeof snippet.title === "string" ? snippet.title : snippet.title(),
        icon: snippet.icon,
        render: () => (
          <section class="flex h-full min-h-0 flex-col overflow-hidden">
            <TemplateEditor
              value={snippet.value}
              onValueChange={snippet.onInput}
              variables={props.templateVariables()}
              fill
              disabled={props.disabled?.()}
              error={snippet.id === "body" ? props.bodyError : undefined}
              placeholder={snippet.placeholder}
            />
          </section>
        ),
      })),
    {
      id: "preview",
      title: t().preview,
      icon: "ti ti-file-type-pdf",
      render: () => (
        <section class="flex h-full min-h-0 flex-col overflow-hidden">
          <PdfPreview
            title={t().gotenbergPreview}
            class="min-h-0 flex-1"
            buttonLabel={t().renderPreview}
            emptyText={t().unsavedPreview}
            disabled={() =>
              Boolean(props.disabled?.()) || !props.source().trim() || !props.body().trim() || !props.previewRecordId().trim()
            }
            request={props.previewPdf}
          />
        </section>
      ),
    },
    {
      id: "data",
      title: t().dataPane,
      icon: "ti ti-list-tree",
      render: () => (
        <section class="flex h-full min-h-0 flex-col overflow-hidden">
          <DocumentDataTree
            data={() => props.previewData()?.data ?? null}
            loading={props.previewDataLoading}
            error={props.previewDataError}
          />
        </section>
      ),
    },
    {
      id: "source",
      title: t().source,
      icon: "ti ti-code",
      render: () => (
        <section class="flex h-full min-h-0 flex-col overflow-hidden">
          <RenderedDocumentSource
            source={() => props.previewData()?.source ?? null}
            loading={props.previewDataLoading}
            error={props.previewDataError}
          />
        </section>
      ),
    },
  ]);

  return (
    <Panes layout={layout()} onLayoutChange={setLayout} items={items()} class="min-h-[24rem] w-full flex-1" movable={false} split={false} />
  );
}
