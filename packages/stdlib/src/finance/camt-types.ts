/** All monetary values are unsigned decimal strings; direction is separate. */
export type CamtAmount = { amount: string; currency: string };
export type CamtDirection = "CRDT" | "DBIT";
export type CamtCode = { kind: "code" | "proprietary"; value: string };
export type CamtDate = { kind: "date" | "dateTime"; value: string };
/** Namespace-aware XML data, without library-specific objects. Comments/PIs are omitted. */
export type CamtXmlElement = {
  name: string;
  namespace: string;
  attributes: { name: string; namespace: string; value: string }[];
  content: (string | CamtXmlElement)[];
};
export type CamtAccount = {
  id: { kind: "iban" | "other"; value: string };
  currency?: string;
  name?: string;
  ownerName?: string;
  servicerBic?: string;
};
export type CamtBankTransactionCode = {
  domain?: { code: string; family: string; subfamily: string };
  proprietary?: { code: string; issuer?: string };
};
export type CamtBalance = {
  type: CamtCode;
  subtype?: CamtCode;
  amount: CamtAmount;
  direction: CamtDirection;
  date: CamtDate;
};
export type CamtParty = { kind: "party" | "agent"; name?: string; bic?: string };
export type CamtTransaction = {
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
export type CamtEntryDetails = {
  batch?: {
    messageId?: string; paymentInformationId?: string; transactionCount?: string;
    total?: CamtAmount; direction?: CamtDirection;
  };
  transactions: CamtTransaction[];
};
export type CamtEntry = {
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
export type CamtReport = {
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
export type CamtDocument = {
  version: "camt.052.001.08";
  messageId: string;
  createdAt: string;
  pagination?: { pageNumber: string; lastPage: boolean };
  reports: CamtReport[];
  /** Complete element/attribute/text tree, including fields outside the typed projection. */
  document: CamtXmlElement;
};
export type CamtParseOptions = {
  /** Maximum JS string length (UTF-16 code units), default 10 Mi. */
  maxCharacters?: number;
  /** Maximum element count, default 250,000. */
  maxElements?: number;
  /** Maximum nesting depth, default 64. */
  maxDepth?: number;
};
