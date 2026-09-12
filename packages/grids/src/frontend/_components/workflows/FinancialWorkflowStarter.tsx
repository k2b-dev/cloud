import { i18n } from "@k2b/stdlib";
import { Button, DatePicker, NoticeCard, Select, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { PublicField, PublicTable } from "../../../api/public-dto";
import { DatevHeaderSchema } from "../../../document-profiles/datev-csv-contracts";
import { SepaHeaderSchema } from "../../../document-profiles/sepa-xml-contracts";
import { expensePaymentStarterSource, invoiceAccountingStarterSource } from "./financial-workflow-starters";
import type { WorkflowStarter } from "./workflow-starters";

export const financialStarterMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      invoice: "Invoice accounting export",
      expense: "Reimbursement payment file",
      invoiceHint:
        "Export an issued invoice to DATEV. Its snapshot must contain the selected accounting fields and calculated invoice totals. No live amounts are recalculated.",
      expenseHint:
        "Create SEPA payments for selected, finalized reimbursements. Choose a required, unique reimbursement number. Finalization must lock every payment field, including the amount.",
      table: "Source table",
      next: "Configure destination",
      back: "Back to fields",
      use: "Review workflow",
      invalidHeader: "Check the marked destination fields. Use valid ISO dates within one fiscal year and electronic IBANs without spaces.",
      invalidField: "Check this value.",
      businessId: "Unique reimbursement number",
      amount: "Amount in EUR",
      creditorName: "Payee name",
      creditorIban: "Payee IBAN",
      remittance: "Payment reference",
      direction: "Booking direction (S / H)",
      account: "Account",
      counterAccount: "Counter-account",
      destinationKey: "Stable destination key",
      debtorName: "Account holder",
      debtorIban: "Sender IBAN",
      executionDate: "Execution date",
      consultantNumber: "DATEV consultant number",
      clientNumber: "DATEV client number",
      fiscalYearStart: "Fiscal year start",
      accountLength: "Account length",
      periodStart: "Period start",
      periodEnd: "Period end",
      label: "Batch label",
      destinationHint:
        "Use the same destination key for every export to this ledger or payment account. Dates are saved in the workflow; review them before each batch. Files require confirmation and are never sent to the bank or accounting system automatically.",
      unfinished: "Finalize every selected reimbursement before creating a payment file.",
      requirements:
        "Missing a suitable field? Add it to the table first. Account numbers and IBANs must be text; the reimbursement number must be required and unique.",
    },
    de: {
      invoice: "Rechnungen für die Buchhaltung exportieren",
      expense: "Zahlungsdatei für Erstattungen",
      invoiceHint:
        "Eine ausgestellte Rechnung nach DATEV exportieren. Ihr Snapshot muss die gewählten Kontierungsfelder und berechneten Rechnungssummen enthalten. Live-Beträge werden nicht nachberechnet.",
      expenseHint:
        "SEPA-Zahlungen für ausgewählte, finalisierte Erstattungen erstellen. Wähle eine verpflichtende, eindeutige Erstattungsnummer. Die Finalisierung muss alle Zahlungsfelder einschließlich des Betrags sperren.",
      table: "Quelltabelle",
      next: "Ziel konfigurieren",
      back: "Zurück zu den Feldern",
      use: "Workflow prüfen",
      invalidHeader:
        "Prüfe die markierten Zielfelder. Verwende gültige ISO-Daten innerhalb eines Wirtschaftsjahrs und IBANs ohne Leerzeichen.",
      invalidField: "Prüfe diesen Wert.",
      businessId: "Eindeutige Erstattungsnummer",
      amount: "Betrag in EUR",
      creditorName: "Empfängername",
      creditorIban: "Empfänger-IBAN",
      remittance: "Verwendungszweck",
      direction: "Buchungsrichtung (S / H)",
      account: "Konto",
      counterAccount: "Gegenkonto",
      destinationKey: "Stabiler Zielschlüssel",
      debtorName: "Kontoinhaber",
      debtorIban: "Absender-IBAN",
      executionDate: "Ausführungsdatum",
      consultantNumber: "DATEV-Beraternummer",
      clientNumber: "DATEV-Mandantennummer",
      fiscalYearStart: "Wirtschaftsjahresbeginn",
      accountLength: "Kontenlänge",
      periodStart: "Zeitraum von",
      periodEnd: "Zeitraum bis",
      label: "Stapelbezeichnung",
      destinationHint:
        "Verwende für jedes Exportziel denselben Zielschlüssel. Die Datumswerte werden im Workflow gespeichert; prüfe sie vor jedem Stapel. Dateien benötigen eine Bestätigung und werden nie automatisch an Bank oder Buchhaltung gesendet.",
      unfinished: "Finalisiere alle ausgewählten Erstattungen, bevor du eine Zahlungsdatei erstellst.",
      requirements:
        "Fehlt ein geeignetes Feld? Lege es zuerst in der Tabelle an. Kontonummern und IBANs müssen Textfelder sein; die Erstattungsnummer muss verpflichtend und eindeutig sein.",
    },
  },
});

type FieldKey = "businessId" | "amount" | "creditorName" | "creditorIban" | "remittance" | "direction" | "account" | "counterAccount";
type HeaderKey =
  | "destinationKey"
  | "debtorName"
  | "debtorIban"
  | "executionDate"
  | "consultantNumber"
  | "clientNumber"
  | "fiscalYearStart"
  | "periodStart"
  | "periodEnd"
  | "label";

export function FinancialWorkflowStarter(props: {
  kind: "invoiceAccounting" | "expensePayment";
  tables: Array<Pick<PublicTable, "id" | "name" | "kind">>;
  fieldsByTable: Record<string, Array<Pick<PublicField, "id" | "name" | "type" | "required" | "uniqueConstraint">>>;
  onDirty: () => void;
  onComplete: (starter: WorkflowStarter) => void;
}) {
  const locale = useLocale();
  const t = financialStarterMessages.resolve([locale()]).t;
  const invoice = () => props.kind === "invoiceAccounting";
  const [tableId, setTableId] = createSignal("");
  const [fields, setFields] = createSignal<Partial<Record<FieldKey, string>>>({});
  const [header, setHeader] = createSignal<Partial<Record<HeaderKey, string>>>({});
  const [accountLength, setAccountLength] = createSignal(4);
  const [target, setTarget] = createSignal(false);
  const [submitted, setSubmitted] = createSignal(false);
  let root: HTMLDivElement | undefined;
  const fieldKeys = (): FieldKey[] =>
    invoice() ? ["direction", "account", "counterAccount"] : ["businessId", "amount", "creditorName", "creditorIban", "remittance"];
  const headerKeys = (): HeaderKey[] =>
    invoice()
      ? ["destinationKey", "consultantNumber", "clientNumber", "fiscalYearStart", "periodStart", "periodEnd", "label"]
      : ["destinationKey", "debtorName", "debtorIban", "executionDate"];
  const candidates = (key: FieldKey) =>
    (props.fieldsByTable[tableId()] ?? []).filter((field) => {
      if (key === "amount") return field.type === "number";
      if (field.type !== "text") return false;
      return key !== "businessId" || (field.required && field.uniqueConstraint);
    });
  const completeFields = () => tableId() && fieldKeys().every((key) => candidates(key).some((field) => field.id === fields()[key]));
  const completeHeader = () => headerKeys().every((key) => header()[key]?.trim());
  const value = (key: HeaderKey) => header()[key]?.trim() ?? "";
  const datevHeader = () => ({
    destinationKey: value("destinationKey"),
    consultantNumber: value("consultantNumber"),
    clientNumber: value("clientNumber"),
    fiscalYearStart: value("fiscalYearStart"),
    accountLength: accountLength(),
    periodStart: value("periodStart"),
    periodEnd: value("periodEnd"),
    label: value("label"),
    finalize: false,
  });
  const sepaHeader = () => ({
    destinationKey: value("destinationKey"),
    debtorName: value("debtorName"),
    debtorIban: value("debtorIban"),
    executionDate: value("executionDate"),
  });
  const headerCheck = () => (invoice() ? DatevHeaderSchema.safeParse(datevHeader()) : SepaHeaderSchema.safeParse(sepaHeader()));
  const invalidField = (key: string) => {
    if (!submitted()) return undefined;
    const result = headerCheck();
    return !result.success && result.error.issues.some((issue) => issue.path[0] === key) ? t.invalidField : undefined;
  };
  const finish = () => {
    setSubmitted(true);
    if (!completeFields() || !completeHeader()) return;
    if (!headerCheck().success) {
      root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    const field = (key: FieldKey) => fields()[key] ?? "";
    const name = invoice() ? t.invoice : t.expense;
    const source = invoice()
      ? invoiceAccountingStarterSource({
          fields: { direction: field("direction"), account: field("account"), counterAccount: field("counterAccount") },
          header: datevHeader(),
        })
      : expensePaymentStarterSource({
          tableId: tableId(),
          fieldReferences: (props.fieldsByTable[tableId()] ?? []).flatMap((field) => [field.name, field.id]),
          fields: {
            businessId: field("businessId"),
            amount: field("amount"),
            creditorName: field("creditorName"),
            creditorIban: field("creditorIban"),
            remittance: field("remittance"),
          },
          header: sepaHeader(),
          notFinalizedMessage: t.unfinished,
        });
    props.onComplete({
      name,
      description: invoice() ? t.invoiceHint : t.expenseHint,
      source,
      enabled: false,
      launcher: { name, config: invoice() ? { kind: "customApp", inputMode: "prompt" } : { kind: "bulk", input: "records" } },
    });
  };
  return (
    <div ref={root} class="flex flex-col gap-4">
      <NoticeCard tone="info">{invoice() ? t.invoiceHint : t.expenseHint}</NoticeCard>
      <Show
        when={!target()}
        fallback={
          <>
            <NoticeCard tone="info">{t.destinationHint}</NoticeCard>
            <Show when={submitted() && !headerCheck().success}>
              <NoticeCard tone="danger">{t.invalidHeader}</NoticeCard>
            </Show>
            <For each={headerKeys()}>
              {(key) => {
                const update = (value: string | null) => {
                  props.onDirty();
                  setHeader((current) => ({ ...current, [key]: value ?? "" }));
                };
                return (
                  <Show
                    when={["executionDate", "fiscalYearStart", "periodStart", "periodEnd"].includes(key)}
                    fallback={
                      <TextInput
                        label={t[key]}
                        value={() => header()[key] ?? ""}
                        error={invalidField(key)}
                        required
                        onValueChange={update}
                      />
                    }
                  >
                    <DatePicker
                      label={t[key]}
                      value={() => header()[key] || null}
                      error={invalidField(key)}
                      required
                      onValueChange={update}
                    />
                  </Show>
                );
              }}
            </For>
            <Show when={invoice()}>
              <Select
                label={t.accountLength}
                options={[4, 5, 6, 7, 8].map((length) => ({ id: String(length), label: String(length) }))}
                value={() => String(accountLength())}
                onValueChange={(value) => {
                  if (value) {
                    props.onDirty();
                    setAccountLength(Number(value));
                  }
                }}
              />
            </Show>
            <div class="flex justify-between gap-3">
              <Button variant="ghost" onClick={() => setTarget(false)}>
                {t.back}
              </Button>
              <Button disabled={!completeHeader()} onClick={finish}>
                {t.use}
              </Button>
            </div>
          </>
        }
      >
        <Select
          label={t.table}
          options={props.tables.filter((table) => table.kind === "stored").map((table) => ({ id: table.id, label: table.name }))}
          value={tableId}
          onValueChange={(value) => {
            props.onDirty();
            setTableId(value ?? "");
            setFields({});
          }}
          required
        />
        <For each={fieldKeys()}>
          {(key) => (
            <Select
              label={t[key]}
              options={candidates(key).map((field) => ({ id: field.id, label: field.name }))}
              value={() => fields()[key] ?? ""}
              onValueChange={(value) => {
                props.onDirty();
                setFields((current) => ({ ...current, [key]: value ?? "" }));
              }}
              required
            />
          )}
        </For>
        <Show when={tableId() && fieldKeys().some((key) => candidates(key).length === 0)}>
          <NoticeCard tone="warning">{t.requirements}</NoticeCard>
        </Show>
        <Button class="self-end" disabled={!completeFields()} onClick={() => setTarget(true)}>
          {t.next}
        </Button>
      </Show>
    </div>
  );
}
