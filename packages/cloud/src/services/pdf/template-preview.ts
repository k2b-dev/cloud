import { type LiquidTemplateOptions, renderLiquidTemplate } from "../../shared/template-rendering";
import {
  type GotenbergConfig,
  GotenbergRenderError,
  type RenderHtmlToPdfOptions,
  type RenderHtmlToPdfResult,
  renderHtmlToPdf,
  renderHtmlToPdfWithConfig,
} from "./gotenberg";

export type TemplatePdfPreviewPhase = "template" | "pdf";

export type TemplatePdfPreviewError = {
  phase: TemplatePdfPreviewPhase;
  message: string;
  status: number;
  code?: string;
};

export type TemplatePdfPreviewResult =
  | {
      ok: true;
      html: string;
      headerHtml: string | null;
      footerHtml: string | null;
      pageCss: string | null;
      pdf: RenderHtmlToPdfResult;
    }
  | {
      ok: false;
      error: TemplatePdfPreviewError;
    };

export type RenderTemplatePdfPreviewInput = {
  htmlTemplate: string;
  headerHtmlTemplate?: string | null;
  footerHtmlTemplate?: string | null;
  pageCssTemplate?: string | null;
  data: Record<string, unknown>;
  filters?: LiquidTemplateOptions["filters"];
  filename?: string;
  /** PDF document title when the rendered HTML has no `<title>`; see `RenderHtmlToPdfInput.title`. */
  title?: string;
};

export type RenderTemplatePdfPreviewOptions = RenderHtmlToPdfOptions & {
  config?: GotenbergConfig;
};

const pdfErrorStatus = (error: GotenbergRenderError): number => (error.code === "not_configured" ? 400 : 502);

const renderPart = (
  template: string | null | undefined,
  data: Record<string, unknown>,
  filters: LiquidTemplateOptions["filters"],
): string | null => {
  const source = template?.trim();
  return source ? renderLiquidTemplate(source, data, { filters }) : null;
};

const injectPageCss = (html: string, pageCss: string | null): string => {
  if (!pageCss?.trim()) return html;
  const style = `<style>\n${pageCss}\n</style>`;
  return /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${style}\n</head>`)
    : `<!doctype html><html><head>${style}</head><body>${html}</body></html>`;
};

export const renderTemplatePdfPreview = async (
  input: RenderTemplatePdfPreviewInput,
  options: RenderTemplatePdfPreviewOptions = {},
): Promise<TemplatePdfPreviewResult> => {
  let html: string;
  let headerHtml: string | null;
  let footerHtml: string | null;
  let pageCss: string | null;
  try {
    pageCss = renderPart(input.pageCssTemplate, input.data, input.filters);
    html = injectPageCss(renderLiquidTemplate(input.htmlTemplate, input.data, { filters: input.filters }), pageCss);
    headerHtml = renderPart(input.headerHtmlTemplate, input.data, input.filters);
    footerHtml = renderPart(input.footerHtmlTemplate, input.data, input.filters);
  } catch (error) {
    return {
      ok: false,
      error: {
        phase: "template",
        message: error instanceof Error ? error.message : "Template rendering failed.",
        status: 400,
      },
    };
  }

  try {
    const pdfInput = { html, title: input.title, headerHtml, footerHtml, filename: input.filename };
    return {
      ok: true,
      html,
      headerHtml,
      footerHtml,
      pageCss,
      pdf: options.config ? await renderHtmlToPdfWithConfig(pdfInput, options.config, options) : await renderHtmlToPdf(pdfInput, options),
    };
  } catch (error) {
    if (error instanceof GotenbergRenderError) {
      return {
        ok: false,
        error: {
          phase: "pdf",
          message: error.message,
          status: pdfErrorStatus(error),
          code: error.code,
        },
      };
    }
    return {
      ok: false,
      error: {
        phase: "pdf",
        message: error instanceof Error ? error.message : "PDF rendering failed.",
        status: 500,
      },
    };
  }
};
