/** Table headings are needed before drawing code; keep them separate from navigation and state copy. */
const fields = {
  en: {
    balancePeriod: "Period",
    balanceDirection: "Direction",
    chartFields: ({ key }: { key: string }) => (key === "detail" ? "Detail" : key === "value" ? "Value" : key),
  },
  de: {
    balancePeriod: "Zeitraum",
    balanceDirection: "Richtung",
    chartFields: ({ key }: { key: string }) => (key === "detail" ? "Details" : key === "value" ? "Wert" : key),
  },
};
export const balanceFlowFields = (locale = "en") => fields[locale.toLowerCase().split("-")[0] === "de" ? "de" : "en"];
