import {expect,test} from "bun:test";
import {reconcile,exportRows,type Invoice,type Booking} from "./reconcile";
const invoice=(reference:string,cents:number,file=reference+".pdf"):Invoice=>({issuer:"DHL",reference,currency:"EUR",cents,date:"2026-09-01",source:{file,page:2,reason:"Invoice header"}});
const booking=(id:string,cents:number,references:string[]):Booking=>({id,cents,references,currency:"EUR",date:"2026-09-02",source:{file:"statement.pdf",page:3,reason:"Remittance references"}});
test("reconciles a multi-invoice payment including credit, preserves evidence and never double-counts aggregate payments",()=>{
 const result=reconcile([booking("bank1",1200,["I1","I2","C1"])],[invoice("I1",1000),invoice("I2",500),invoice("C1",-300),invoice("I1",1000,"duplicate.pdf")]);
 expect(result.matches[0]?.status).toBe("confirmed");expect(result.duplicates).toHaveLength(1);
 const rows=exportRows(result);expect(rows.confirmed.map(row=>row.bank_amount)).toEqual(["12,00","",""]);
 expect(rows.confirmed[0]).toMatchObject({file:"I1.pdf",page:2,bank_page:3});expect(rows.open[0]?.reason).toContain("Duplicate");
});
test("amount-only, missing, mismatched, ambiguous and reused invoices never become confirmed",()=>{
 const result=reconcile([booking("amount",1000,[]),booking("missing",1000,["unknown"]),booking("wrong",999,["I1"]),booking("ok",1000,["I1"]),booking("reuse",1000,["I1"])],[invoice("I1",1000)]);
 expect(result.matches.map(match=>match.status)).toEqual(["review","review","review","review","review"]);
 const conflict=reconcile([booking("b",1000,["I1"])],[invoice("I1",1000),invoice("I1",1001)]);
 expect(conflict.conflicts).toHaveLength(1);expect(conflict.matches[0]?.status).toBe("review");
 expect(()=>reconcile([],[invoice("unsafe",1.1)])).toThrow("integer cents");
});
