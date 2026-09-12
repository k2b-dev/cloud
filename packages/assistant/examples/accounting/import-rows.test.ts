import {expect,test} from "bun:test";
import {importRows,type ImportDatabase,type ImportRow} from "./import-rows";
test("retries an interrupted multi-batch import without duplicates and rejects changed input",async()=>{
 const stored=new Map<string,string>();let batches=0,fail=true;
 const db:ImportDatabase={query:async(_sql,keys)=>({data:keys.filter(key=>stored.has(key)).map(key=>({import_key:key,payload:stored.get(key)!}))}),table:()=>({insert:async rows=>{if(++batches===2&&fail)throw new Error("connection lost");for(const row of rows)stored.set(row.import_key,row.payload);}})};
 const rows:ImportRow[]=Array.from({length:2500},(_,i)=>({import_key:`folder/file.xlsx::Ledger::${i+2}`,payload:JSON.stringify([i,"12.34"])}));
 await expect(importRows(db,rows,async()=>{})).rejects.toThrow("connection lost");expect(stored.size).toBe(200);
 fail=false;expect(await importRows(db,rows,async()=>{})).toEqual({inserted:2300,skipped:200});expect(stored.size).toBe(2500);
 expect(await importRows(db,rows,async()=>{})).toEqual({inserted:0,skipped:2500});
 await expect(importRows(db,[{...rows[0]!,payload:"changed"}],async()=>{})).rejects.toThrow("changed");
});
