/** Frozen JSON accepted by cloud-v0.69.0. Do not rewrite these when current chart types change. */
export const signedRows069Json = `{
  "kind": "bar", "title": "Inventory adjustments", "layout": "rows",
  "data": [
    { "label": "Returns", "value": -12 },
    { "label": "Sales", "value": 30 },
    { "label": "Correction", "value": -4 },
    { "label": "Unchanged", "value": 0 }
  ]
}`;

export const positiveRows069Json = {
  ordered: `{"title":"Age bands","kind":"bar","layout":"rows","xAxis":{"ordered":true},"data":[{"label":"Young","value":20},{"label":"Adult","value":50},{"label":"Senior","value":30}]}`,
  references: `{"title":"Age bands","kind":"bar","layout":"rows","references":[{"value":25,"label":"Target"}],"data":[{"label":"Young","value":20},{"label":"Adult","value":50},{"label":"Senior","value":30}]}`,
  colorByBar: `{"title":"Age bands","kind":"bar","layout":"rows","colorByBar":true,"data":[{"label":"Young","value":20},{"label":"Adult","value":50},{"label":"Senior","value":30}]}`,
  showValues: `{"title":"Age bands","kind":"bar","layout":"rows","showValues":false,"data":[{"label":"Young","value":20},{"label":"Adult","value":50},{"label":"Senior","value":30}]}`,
  categoryLabel: `{"title":"Age bands","kind":"bar","layout":"rows","xAxis":{"label":"Age band"},"data":[{"label":"Young","value":20},{"label":"Adult","value":50},{"label":"Senior","value":30}]}`,
  valueLabel: `{"title":"Age bands","kind":"bar","layout":"rows","yAxis":{"label":"People"},"data":[{"label":"Young","value":20},{"label":"Adult","value":50},{"label":"Senior","value":30}]}`,
  domain: `{"title":"Age bands","kind":"bar","layout":"rows","yAxis":{"domain":[0,100]},"data":[{"label":"Young","value":20},{"label":"Adult","value":50},{"label":"Senior","value":30}]}`,
  scale: `{"title":"Age bands","kind":"bar","layout":"rows","yAxis":{"scale":"log"},"data":[{"label":"Young","value":20},{"label":"Adult","value":50},{"label":"Senior","value":30}]}`,
  ticks: `{"title":"Age bands","kind":"bar","layout":"rows","yAxis":{"ticks":3},"data":[{"label":"Young","value":20},{"label":"Adult","value":50},{"label":"Senior","value":30}]}`,
};

// Historical reader, deliberately independent of today's ChartDescription. Only trusted frozen JSON uses it.
type Rows069 = {
  kind: "bar";
  layout: "rows";
  title: string;
  data: { label: string; value: number }[];
  xAxis?: { ordered?: boolean; label?: string };
  references?: { value: number; label?: string }[];
  colorByBar?: boolean;
  showValues?: boolean;
  yAxis?: { label?: string; domain?: [number, number]; scale?: "log"; ticks?: number };
};
export const parseRows069 = (json: string): Rows069 => JSON.parse(json);
