import { LocaleProvider } from "@k2b/ui";
import CustomAppChartIsland from "./Chart.island";
import { buildChartRenderData, type ChartRenderData } from "./chart-data";

const relationId = "a64d7c8a-9fc4-4836-a75e-2ee931491020";
const chart = (kind: ChartRenderData["kind"], empty = false) =>
  buildChartRenderData({
    widget: { chartType: kind },
    groupBy: [{ fieldId: "status" }],
    aggregations: [
      { fieldId: "amount", agg: "sum", label: "Umsatz" },
      { fieldId: "cost", agg: "sum", label: "Kosten" },
    ],
    buckets: empty
      ? []
      : [
          { keys: ["Neu"], values: { amount__sum: 4, cost__sum: 2 } },
          { keys: ["In Arbeit"], values: { amount__sum: 9, cost__sum: 5 } },
          { keys: [relationId], values: { amount__sum: 3, cost__sum: 1 } },
        ],
    fieldsById: new Map(),
    relationLabels: { [relationId]: "Erledigt" },
    categoryFormat: { locale: "de", unknownRecordLabel: "Unbekannter Datensatz" },
  });
const valueFormat = { style: "number", decimalPlaces: 2, unit: "€", unitPosition: "suffix" } as const;
const dateConfig = { locale: "de", timeZone: "UTC" };

export default function ChartTooltipsFixture() {
  return (
    <LocaleProvider locale="de">
      <button id="before" type="button">
        Vor den Diagrammen
      </button>
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {(["bar", "line", "donut"] as const).map((kind) => (
          <section data-fixture-chart={kind}>
            <CustomAppChartIsland
              chart={chart(kind)}
              valueFormat={valueFormat}
              dateConfig={dateConfig}
              xAxisLabel="Status"
              yAxisLabel="Betrag"
            />
          </section>
        ))}
      </div>
      <section data-fixture-chart="empty">
        <CustomAppChartIsland chart={chart("bar", true)} valueFormat={valueFormat} dateConfig={dateConfig} />
      </section>
      <button id="after" type="button">
        Nach den Diagrammen
      </button>
    </LocaleProvider>
  );
}
