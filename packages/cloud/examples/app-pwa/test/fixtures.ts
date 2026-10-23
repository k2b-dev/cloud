import type { KioskSnapshot } from "../src/model";

export const fixtureSnapshot = (): KioskSnapshot => ({
  device: { name: "Laden-iPad" },
  visit: {
    id: "10000000-0000-4000-8000-000000000001",
    customerName: "Lea Muster",
    documents: [
      {
        id: "contract",
        revision: 1,
        title: "Ankaufsvertrag",
        signed: false,
        paragraphs: [
          "Objekt: Kommode, Nussbaum, um 1920. Vereinbarter Ankaufspreis: 450,00 €.",
          "Lea Muster verkauft das beschriebene Objekt an den Beispielbetrieb. Die Auszahlung erfolgt nach Abschluss dieses Vertrags.",
          "Der Verkauf und die Übergabe des Objekts werden mit dieser Erklärung bestätigt. Dieser verkürzte Mustertext ist kein verwendbarer Vertrag.",
        ],
      },
      {
        id: "receipt",
        revision: 1,
        title: "Auszahlungsquittung",
        signed: false,
        receiptAmount: "450,00 €",
        paragraphs: [
          "Lea Muster bestätigt den Empfang des genannten Betrags für den Ankauf der Kommode.",
          "Auszahlung in bar am 23.10.2026. Ausschließlich Beispieldaten; die Beispielzahlung ist bereits als ausgezahlt vermerkt.",
        ],
      },
    ],
  },
});
