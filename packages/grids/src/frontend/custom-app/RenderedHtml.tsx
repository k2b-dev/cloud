import { Placeholder, TemplatePreview } from "@k2b/ui";
import { HTML_TEMPLATE_ERROR } from "../../field-types/html-template";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

type CustomAppHtmlHeight = "compact" | "normal" | "large";

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join("; ");

const heightClass: Record<CustomAppHtmlHeight, string> = {
  compact: "min-h-48",
  normal: "min-h-80",
  large: "min-h-[36rem]",
};

export const isolatedCustomAppHtml = (html: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"><meta name="referrer" content="no-referrer">${html}`;

export function RenderedHtml(props: { html: unknown; title: string; height: CustomAppHtmlHeight }) {
  const messages = useCustomAppRuntimeMessages();
  const html = () => (typeof props.html === "string" ? props.html : null);
  return html() && html() !== HTML_TEMPLATE_ERROR ? (
    <div inert>
      <TemplatePreview
        html={isolatedCustomAppHtml(html()!)}
        title={props.title}
        class={`pointer-events-none ${heightClass[props.height]}`}
      />
    </div>
  ) : (
    <Placeholder
      variant="compact"
      align="left"
      title={messages().renderedHtmlUnavailable}
      description={html() === HTML_TEMPLATE_ERROR ? messages().templateRenderFailed : messages().noRenderedHtml}
    />
  );
}
