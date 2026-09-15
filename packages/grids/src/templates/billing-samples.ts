import type { BillingText } from "./billing";
import { currentMonthDate, type GridTemplate, record } from "./types";

/** Draft-only examples: never seed ready issuer details or pretend money moved. */
export const billingSamples = (t: BillingText): NonNullable<GridTemplate["records"]> => {
  const positions = ["vat007", "vat019"].map((vat) => ({
    Label1: t.examplePosition,
    Unit01: ["C62"],
    Qty001: "1",
    Price1: "10.00",
    Vat001: [vat],
  }));
  const bill = {
    settings: [record("settings")],
    party: [record("example_partner")],
    invoice_date: currentMonthDate(15),
    service_date: currentMonthDate(1),
    due_date: currentMonthDate(28),
    buyer_reference: "DEMO",
    notes: t.exampleNotice,
    positions,
  };
  return [
    { key: "example_partner", table: "parties", values: { name: t.examplePartner } },
    { key: "example_invoice", table: "bills", values: { ...bill, kind: ["invoice"] } },
    {
      key: "example_settlement",
      table: "bills",
      values: { ...bill, kind: ["selfBilling"], agreement: "DEMO" },
    },
  ];
};
