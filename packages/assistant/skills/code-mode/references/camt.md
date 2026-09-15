# CAMT account reports

`camt.parse(xml: string, options?: CamtParseOptions)` synchronously returns
`Result<CamtDocument>`. Check `ok` before reading `data`; errors have
`code`, `status`, `message`, and `issues: {code,path,message,line?,column?}[]`.
Issue paths use zero-based array indices; XML locations are one-based.

Only `camt.052.001.08` is supported. Amounts are unsigned exact decimal strings;
`direction` carries CRDT/DBIT. Do not add entry totals and transaction details
as if they were separate payments. Missing details remain absent. Parsing does
not reconcile, deduplicate, infer payment completion, fetch missing pages, or
read camt.053/other versions. No network calls or XSD validation occur.

## Input and result

These are type descriptions, not imports. Optional fields may be absent.

```ts
/** All monetary values are unsigned decimal strings; direction is separate. */
type CamtAmount = { amount: string; currency: string };
type CamtDirection = "CRDT" | "DBIT";
type CamtCode = { kind: "code" | "proprietary"; value: string };
type CamtDate = { kind: "date" | "dateTime"; value: string };
/** Namespace-aware XML data, as plain objects. Comments/PIs are omitted. */
type CamtXmlElement = {
  name: string;
  namespace: string;
  attributes: { name: string; namespace: string; value: string }[];
  content: (string | CamtXmlElement)[];
};
type CamtAccount = {
  id: { kind: "iban" | "other"; value: string };
  currency?: string;
  name?: string;
  ownerName?: string;
  servicerBic?: string;
};
type CamtBankTransactionCode = {
  domain?: { code: string; family: string; subfamily: string };
  proprietary?: { code: string; issuer?: string };
};
type CamtBalance = {
  type: CamtCode;
  subtype?: CamtCode;
  amount: CamtAmount;
  direction: CamtDirection;
  date: CamtDate;
};
type CamtParty = { kind: "party" | "agent"; name?: string; bic?: string };
type CamtTransaction = {
  amount?: CamtAmount;
  direction?: CamtDirection;
  references: {
    messageId?: string; accountServicerReference?: string; paymentInformationId?: string;
    instructionId?: string; endToEndId?: string; uetr?: string; transactionId?: string;
    mandateId?: string; chequeNumber?: string; clearingSystemReference?: string;
    accountOwnerTransactionId?: string; accountServicerTransactionId?: string;
    marketInfrastructureTransactionId?: string; processingId?: string;
    proprietary: { type: string; reference: string }[];
  };
  instructedAmount?: CamtAmount;
  transactionAmount?: CamtAmount;
  counterValueAmount?: CamtAmount;
  bankTransactionCode?: CamtBankTransactionCode;
  debtor?: CamtParty;
  debtorAccount?: CamtAccount;
  creditor?: CamtParty;
  creditorAccount?: CamtAccount;
  ultimateDebtor?: CamtParty;
  ultimateCreditor?: CamtParty;
  debtorAgentBic?: string;
  creditorAgentBic?: string;
  purpose?: CamtCode;
  remittance: { unstructured: string[]; structured: CamtXmlElement[] };
  returnInformation?: CamtXmlElement;
  additionalInformation?: string;
};
type CamtEntryDetails = {
  batch?: {
    messageId?: string; paymentInformationId?: string; transactionCount?: string;
    total?: CamtAmount; direction?: CamtDirection;
  };
  transactions: CamtTransaction[];
};
type CamtEntry = {
  reference?: string;
  amount: CamtAmount;
  direction: CamtDirection;
  reversal?: boolean;
  status: CamtCode;
  bookingDate?: CamtDate;
  valueDate?: CamtDate;
  accountServicerReference?: string;
  bankTransactionCode: CamtBankTransactionCode;
  details: CamtEntryDetails[];
  additionalInformation?: string;
};
type CamtReport = {
  id: string;
  createdAt?: string;
  electronicSequenceNumber?: string;
  legalSequenceNumber?: string;
  pagination?: { pageNumber: string; lastPage: boolean };
  period?: { from: string; to: string };
  copyDuplicate?: "COPY" | "DUPL" | "CODU";
  account: CamtAccount;
  balances: CamtBalance[];
  entries: CamtEntry[];
  additionalInformation?: string;
};
type CamtDocument = {
  version: "camt.052.001.08";
  messageId: string;
  createdAt: string;
  pagination?: { pageNumber: string; lastPage: boolean };
  reports: CamtReport[];
  /** Complete element/attribute/text tree, including fields outside the typed projection. */
  document: CamtXmlElement;
};
type CamtParseOptions = {
  /** Maximum JS string length (UTF-16 code units), default 10 Mi. */
  maxCharacters?: number;
  /** Maximum element count, default 250,000. */
  maxElements?: number;
  /** Maximum nesting depth, default 64. */
  maxDepth?: number;
};
```

## Read transaction references without guessing

```js
export default async () => {
  const file = await files.open({ accept: ".xml" });
  if (!file) return { cancelled: true };
  const result = camt.parse(await file.text());
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data.reports.flatMap(report => report.entries.map(entry => ({
    report: report.id,
    account: report.account.id.value,
    amount: entry.amount.amount,
    currency: entry.amount.currency,
    direction: entry.direction,
    bookingDate: entry.bookingDate?.value ?? null,
    details: entry.details.flatMap(group => group.transactions.map(transaction => ({
      endToEndId: transaction.references.endToEndId ?? null,
      remittance: transaction.remittance.unstructured,
    }))),
  })));
};
```

Keep exact strings and separate direction in storage. Use [Money](money.md) for
calculations, and [Electronic invoices](einvoice.md) for invoice candidates.
For ambiguous matches, preserve the evidence and ask for explicit confirmation.
