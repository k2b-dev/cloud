/** Synthetic bank data. No actual account activity. */
export const camtFixture = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"><BkToCstmrAcctRpt>
<GrpHdr><MsgId>message-1</MsgId><CreDtTm>2026-09-15T12:00:00+02:00</CreDtTm><MsgPgntn><PgNb>1</PgNb><LastPgInd>false</LastPgInd></MsgPgntn></GrpHdr>
<Rpt><Id>report-1</Id><RptPgntn><PgNb>1</PgNb><LastPgInd>false</LastPgInd></RptPgntn>
<FrToDt><FrDtTm>2026-09-15T00:00:00+02:00</FrDtTm><ToDtTm>2026-09-15T12:00:00+02:00</ToDtTm></FrToDt>
<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
<Ntry><Amt Ccy="EUR">125.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>true</RvslInd><Sts><Cd>BOOK</Cd></Sts><BkTxCd/>
<NtryDtls><TxDtls><Refs><EndToEndId>first</EndToEndId></Refs><Amt Ccy="EUR">100.00</Amt></TxDtls>
<TxDtls><Refs><EndToEndId>unknown-amount</EndToEndId></Refs></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="KWD">0.00001</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>PDNG</Cd></Sts><BkTxCd/></Ntry>
</Rpt><Rpt><Id>report-2</Id><Acct><Id><Othr><Id>another-account</Id></Othr></Id></Acct></Rpt>
</BkToCstmrAcctRpt></Document>`;
