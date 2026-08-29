import { ButtonLink, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import type { FormatSpec } from "../../../contracts";
import { barcodeSvgForCell, barcodeSvgForDisplay, barcodeUrl, barcodeValueText } from "./BarcodeRendering";
import { tableMessages } from "./messages";

type BarcodeFormat = Extract<FormatSpec, { kind: "barcode" }>;

export function BarcodeDisplay(props: { value: unknown; format: BarcodeFormat; size?: "table" | "detail"; showOpenAction?: boolean }) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  const svg = createMemo(() => barcodeSvgForCell(props.value, props.format));
  const sizedSvg = createMemo(() => {
    const raw = svg();
    if (!raw) return null;
    return barcodeSvgForDisplay(raw, props.format, props.size ?? "table");
  });
  const fallback = () => barcodeValueText(props.value);
  const openUrl = () => barcodeUrl(props.value);
  const detail = () => props.size === "detail";
  const svgClass = () =>
    [
      "grids-code-display",
      detail() ? "grids-code-display--detail" : "grids-code-display--table",
      props.format.bcid === "qrcode" ? "grids-code-display--qr" : "grids-code-display--linear",
    ].join(" ");
  const fallbackClass = () => (detail() ? "font-mono text-base font-semibold text-primary" : "font-mono text-sm text-primary");
  const openButton = () => (
    <Show when={props.showOpenAction && sizedSvg() && openUrl()}>
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
            <span class={svgClass()} innerHTML={html()} />
          </Tooltip.Anchor>
        )}
      </Show>
      {openButton()}
    </span>
  );
}
