export const waterfallFixture = {
  start: { label: "1. Okt.", value: 18800 },
  steps: [
    { label: "Verkäufe", value: 29260 },
    { label: "Wareneinkauf", value: -14800 },
    { label: "Personal", value: -9600 },
    { label: "Miete", value: -3200 },
    { label: "Sonstiges", value: -1920 },
  ],
  end: { label: "31. Okt." },
  format: new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format,
};
