// Reference application logic, not a platform accounting API. Format-specific
// PDF parsers supply these records and must be validated against real documents.
export type Evidence = { file: string; page: number; reason: string };
export type Invoice = { issuer: string; reference: string; currency: string; cents: number; date: string; source: Evidence };
export type Booking = { id: string; currency: string; cents: number; date: string; references: string[]; source: Evidence };
export type Match = { booking: Booking; invoices: Invoice[]; difference: number; status: "confirmed" | "review"; reason: string };

export function reconcile(bookings: Booking[], invoices: Invoice[]) {
  for (const record of [...bookings,...invoices]) {
    if (!Number.isSafeInteger(record.cents)) throw new Error("Amounts must be safe integer cents");
    if (!record.currency || !record.source.file || !Number.isInteger(record.source.page) || record.source.page < 1)
      throw new Error("Currency and source file/page are required");
  }
  const byIdentity = new Map<string, Invoice[]>();
  for (const invoice of invoices) {
    if (!invoice.reference || !invoice.issuer) throw new Error("Invoice issuer and reference are required");
    const key=JSON.stringify([invoice.issuer,invoice.reference,invoice.currency]);
    const group=byIdentity.get(key) ?? [];
    group.push(invoice);byIdentity.set(key,group);
  }
  const duplicates: Invoice[][]=[], conflicts: Invoice[][]=[], unique: Invoice[]=[];
  for(const group of byIdentity.values()) {
    if(group.some(item=>item.cents!==group[0]!.cents || item.date!==group[0]!.date))conflicts.push(group);
    else {unique.push(group[0]!);if(group.length>1)duplicates.push(group);}
  }
  const byReference=new Map<string,Invoice[]>();
  for(const invoice of unique) {
    const group=byReference.get(invoice.reference)??[];group.push(invoice);byReference.set(invoice.reference,group);
  }
  const potentialOwners=new Map<Invoice,Set<Booking>>();
  for(const booking of bookings) {
    const groups=[...new Set(booking.references)].map(ref=>(byReference.get(ref)??[]).filter(invoice=>invoice.currency===booking.currency));
    if(!groups.length || groups.some(group=>group.length!==1))continue;
    const selected=groups.flat();
    if(selected.reduce((sum,invoice)=>sum+BigInt(invoice.cents),0n)!==BigInt(booking.cents))continue;
    for(const invoice of selected){const owners=potentialOwners.get(invoice)??new Set<Booking>();owners.add(booking);potentialOwners.set(invoice,owners);}
  }
  const used=new Set<Invoice>(),seenBookings=new Set<string>();
  const matches:Match[]=[];
  for(const booking of bookings) {
    const refs=[...new Set(booking.references)];
    const candidates=refs.map(ref=>(byReference.get(ref)??[]).filter(invoice=>invoice.currency===booking.currency));
    const selected=candidates.flat();
    const difference=Number(BigInt(booking.cents)-selected.reduce((sum,invoice)=>sum+BigInt(invoice.cents),0n));
    if(!Number.isSafeInteger(difference))throw new Error("Amount total exceeds integer precision");
    let reason="Exact references and cent total";
    if(seenBookings.has(booking.id))reason="Duplicate bank booking ID";
    else if(!refs.length)reason="No invoice references; amount-only candidates need review";
    else if(candidates.some(group=>group.length!==1))reason="Missing or ambiguous invoice reference";
    else if(selected.some(invoice=>(potentialOwners.get(invoice)?.size??0)>1))reason="Invoice matches multiple bank bookings";
    else if(selected.some(invoice=>used.has(invoice)))reason="Invoice already assigned to another booking";
    else if(difference!==0)reason="Referenced invoices do not equal the bank amount";
    const status=reason==="Exact references and cent total"?"confirmed":"review";
    if(status==="confirmed")for(const invoice of selected)used.add(invoice);
    seenBookings.add(booking.id);
    matches.push({booking,invoices:refs.length?selected:unique.filter(invoice=>!used.has(invoice)&&invoice.currency===booking.currency&&invoice.cents===booking.cents),difference,status,reason});
  }
  return {matches,duplicates,conflicts,unmatched:unique.filter(invoice=>!used.has(invoice))};
}

export function exportRows(result: ReturnType<typeof reconcile>) {
  const euro=(cents:number)=>`${cents<0?"-":""}${Math.floor(Math.abs(cents)/100)},${String(Math.abs(cents)%100).padStart(2,"0")}`;
  const confirmed=result.matches.filter(match=>match.status==="confirmed").flatMap(match=>match.invoices.map((invoice,index)=>({
    bank_id:match.booking.id,bank_file:match.booking.source.file,bank_page:match.booking.source.page,
    // The aggregate payment appears only once, never once per invoice.
    bank_amount:index===0?euro(match.booking.cents):"",currency:invoice.currency,
    invoice:invoice.reference,invoice_amount:euro(invoice.cents),file:invoice.source.file,page:invoice.source.page,reason:match.reason,
  })));
  const open=result.matches.filter(match=>match.status!=="confirmed").map(match=>({
    reference:match.booking.id,file:match.booking.source.file,page:match.booking.source.page,amount:euro(match.booking.cents),reason:match.reason,
  }));
  for(const invoice of result.unmatched)open.push({reference:invoice.reference,file:invoice.source.file,page:invoice.source.page,amount:euro(invoice.cents),reason:"Unassigned invoice"});
  for(const group of result.conflicts)for(const invoice of group)open.push({reference:invoice.reference,file:invoice.source.file,page:invoice.source.page,amount:euro(invoice.cents),reason:"Conflicting duplicate invoice"});
  for(const group of result.duplicates)for(const invoice of group.slice(1))open.push({reference:invoice.reference,file:invoice.source.file,page:invoice.source.page,amount:euro(invoice.cents),reason:"Duplicate document; excluded from totals"});
  return {confirmed,open};
}
