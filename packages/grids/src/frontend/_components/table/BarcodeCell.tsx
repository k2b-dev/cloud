import { ButtonLink, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { barcodeSvgForCell, barcodesReady, preloadBarcodes } from "#barcode-drawing";
import type { BarcodeFormat } from "../../../barcode-values";
import { barcodeKey, barcodeSvgForDisplay, barcodeUrl, barcodeValueText } from "./BarcodeRendering";
import { tableMessages } from "./messages";

/**
 * The drawings in the server markup, read while the island modules evaluate in the browser: the island's mount removes
 * its server children right after, and until the drawing code has loaded, the first browser render shows the same
 * drawings from here. A page or view that shows barcodes warms that code (see `RecordsView`).
 */
const serverDrawings = new Map<string, string>();
if (typeof document !== "undefined" && !barcodesReady()) {
  for (const element of document.querySelectorAll<HTMLElement>("[data-grids-barcode]")) {
    const key = element.dataset.gridsBarcode;
    if (key && element.firstElementChild) serverDrawings.set(key, element.innerHTML);
  }
}

export function BarcodeDisplay(props: { value: unknown; format: BarcodeFormat; size?: "table" | "detail"; showOpenAction?: boolean }) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  const fallback = () => barcodeValueText(props.value);
  const key = () => barcodeKey(fallback().trim(), props.format, props.size ?? "table");
  // A string draws, `null` shows the value as text, and `undefined` keeps the place while the drawing code loads.
  const sizedSvg = createMemo((): string | null | undefined => {
    if (!barcodesReady()) {
      const drawing = serverDrawings.get(key());
      if (drawing) return drawing;
      preloadBarcodes();
      return undefined;
    }
    const svg = barcodeSvgForCell(props.value, props.format);
    return svg ? barcodeSvgForDisplay(svg, props.format, props.size ?? "table") : null;
  });
  const openUrl = () => barcodeUrl(props.value);
  const detail = () => props.size === "detail";
  const svgClass = () =>
    [
      "grids-code-display",
      detail() ? "grids-code-display--detail" : "grids-code-display--table",
      props.format.bcid === "qrcode" ? "grids-code-display--qr" : "grids-code-display--linear",
    ].join(" ");
  // While the drawing code loads, the drawing's place stays reserved; the value is read out meanwhile.
  const pendingSize = () =>
    props.format.bcid === "qrcode"
      ? detail()
        ? "width:min(18rem,70vw);height:min(18rem,70vw);"
        : "width:2rem;height:2rem;"
      : detail()
        ? "width:min(100%,28rem);height:7rem;"
        : "width:6rem;height:2.25rem;";
  const fallbackClass = () => (detail() ? "font-mono text-base font-semibold text-primary" : "font-mono text-sm text-primary");
  const openButton = () => (
    <Show when={props.showOpenAction && sizedSvg() !== null && openUrl()}>
      {(url) => (
        <Tooltip.Anchor content={t().openUrl} disabled={detail()}>
          <ButtonLink
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            variant={detail() ? "secondary" : "ghost"}
            size="sm"
            class={detail() ? "w-fit" : "text-dimmed hover:text-primary"}
            aria-label={t().openUrl}
            onClick={(event) => event.stopPropagation()}
          >
            <i class="ti ti-external-link" />
            <Show when={detail()}>
              <span>{t().openUrl}</span>
            </Show>
          </ButtonLink>
        </Tooltip.Anchor>
      )}
    </Show>
  );

  return (
    <span class={detail() ? "flex min-w-0 flex-col gap-3" : "inline-flex min-w-0 items-center gap-1.5 align-middle"}>
      <Show
        when={sizedSvg() !== undefined}
        fallback={
          <span class={svgClass()} style={pendingSize()} aria-busy="true">
            <span class="sr-only">{fallback()}</span>
          </span>
        }
      >
        <Show
          when={sizedSvg()}
          fallback={
            <Show
              when={openUrl()}
              fallback={
                <Tooltip.Anchor content={fallback()}>
                  <span class={fallbackClass()}>{fallback()}</span>
                </Tooltip.Anchor>
              }
            >
              {(url) => (
                <a
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={`${fallbackClass()} hover:underline`}
                  onClick={(event) => event.stopPropagation()}
                >
                  {fallback()}
                </a>
              )}
            </Show>
          }
        >
          {(html) => (
            <Tooltip.Anchor content={fallback()}>
              <span class={svgClass()} data-grids-barcode={key()} innerHTML={html()} />
            </Tooltip.Anchor>
          )}
        </Show>
      </Show>
      {openButton()}
    </span>
  );
}
