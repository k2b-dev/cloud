import { camt } from "../src/finance";

/** Synthetic account report; not an actual bank export. */
export const camtExampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08">
  <BkToCstmrAcctRpt>
    <GrpHdr><MsgId>report-message-1</MsgId><CreDtTm>2026-09-13T12:00:00+02:00</CreDtTm></GrpHdr>
    <Rpt>
      <Id>account-report-1</Id>
      <RptPgntn><PgNb>1</PgNb><LastPgInd>true</LastPgInd></RptPgntn>
      <ElctrncSeqNb>00042</ElctrncSeqNb>
      <CreDtTm>2026-09-13T12:00:00+02:00</CreDtTm>
      <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy><Nm>Example account</Nm></Acct>
      <Bal><Tp><CdOrPrtry><Cd>ITBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-13</Dt></Dt></Bal>
      <Ntry>
        <NtryRef>batch-entry-1</NtryRef><Amt Ccy="EUR">125.50</Amt><CdtDbtInd>DBIT</CdtDbtInd>
        <Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-09-13</Dt></BookgDt><ValDt><Dt>2026-09-14</Dt></ValDt>
        <AcctSvcrRef>bank-ref-1</AcctSvcrRef>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn><Prtry><Cd>example-code</Cd><Issr>Example bank</Issr></Prtry></BkTxCd>
        <NtryDtls>
          <Btch><PmtInfId>payments-1</PmtInfId><NbOfTxs>2</NbOfTxs><TtlAmt Ccy="EUR">125.50</TtlAmt><CdtDbtInd>DBIT</CdtDbtInd></Btch>
          <TxDtls>
            <Refs><EndToEndId>invoice-42</EndToEndId><TxId>tx-1</TxId></Refs>
            <Amt Ccy="EUR">100.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
            <RltdPties><Cdtr><Pty><Nm>Example &amp; Partners</Nm></Pty></Cdtr><CdtrAcct><Id><IBAN>NL91ABNA0417164300</IBAN></Id></CdtrAcct></RltdPties>
            <RmtInf><Ustrd>Invoice 42</Ustrd><Ustrd>Second line</Ustrd><Strd><CdtrRefInf><Ref>RF18539007547034</Ref></CdtrRefInf></Strd></RmtInf>
          </TxDtls>
          <TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs><Amt Ccy="EUR">25.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><RmtInf><Ustrd>Travel expenses</Ustrd></RmtInf></TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry><Amt Ccy="EUR">9.99</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>PDNG</Cd></Sts><BkTxCd/></Ntry>
    </Rpt>
  </BkToCstmrAcctRpt>
</Document>`;

export function camtExample() {
  const result = camt.parse(camtExampleXml);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data.reports.map(report => ({
    account: report.account.id,
    entries: report.entries.map(entry => ({
      amount: entry.amount, direction: entry.direction, status: entry.status,
      // Details are a breakdown of the entry, not additional account movements.
      transactions: entry.details.flatMap(group => group.transactions),
    })),
  }));
}
