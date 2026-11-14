import { StatCell, StatGrid, type StatGridColumns, useLocale } from "@k2b/ui";
import { createMemo, Index } from "solid-js";
import { cloudAiNumberFormatters } from "../chart-block";
import { type CloudStatsDescription, cloudAiStatsTiles } from "../view-block";

/** Loaded stat tiles; the view reserves their frame before this optional renderer or the file arrives. */
export function CloudStatsTiles(props: { input: CloudStatsDescription; columns: StatGridColumns | undefined }) {
  const locale = useLocale();
  const tiles = createMemo(() => cloudAiStatsTiles(props.input, locale()));
  return (
    <StatGrid columns={props.columns}>
      <Index each={tiles()}>
        {(tile, index) => (
          <StatCell
            label={tile().label}
            deltaPlacement="below"
            value={tile().value}
            title={tile().value}
            trend={tile().sparkline}
            trendTooltip={({ datum }) => {
              const point = tile().sparkline?.[datum.index];
              const format = cloudAiNumberFormatters(props.input.items[index]?.format, locale()).value;
              return { rows: point === undefined ? [] : [{ label: tile().label, value: format(point) }] };
            }}
            sub={tile().sub}
            delta={props.input.items[index]?.delta}
            compare={(() => {
              const item = props.input.items[index];
              return item?.compare
                ? { label: item.compare.label, value: cloudAiNumberFormatters(item.format, locale()).value(item.compare.value) }
                : undefined;
            })()}
          />
        )}
      </Index>
    </StatGrid>
  );
}
