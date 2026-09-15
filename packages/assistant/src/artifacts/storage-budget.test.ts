import { expect, test } from "bun:test";
import { checkStorageBudget } from "./storage-budget";
import { StorageJsonRequest } from "./storage-contracts";
const base={area:"files" as const,bytes:10,total:90,previous:0,items:10000,exists:false,limits:{total:100,file:50}};
test("files are bounded by bytes, not count",()=>{
  expect(checkStorageBudget(base)).toBe(true);
  expect(checkStorageBudget({...base,bytes:11})).toBe(false);
  expect(checkStorageBudget({...base,total:0,bytes:51})).toBe(false);
});
test("KV retains its independent count limit",()=>{
  expect(checkStorageBudget({...base,area:"kv"})).toBe(false);
  expect(checkStorageBudget({...base,area:"kv",items:999})).toBe(true);
});
test("lower limits permit shrinking existing content but not growth",()=>{
  expect(checkStorageBudget({...base,exists:true,total:200,previous:90,bytes:80})).toBe(true);
  expect(checkStorageBudget({...base,exists:true,total:200,previous:90,bytes:91})).toBe(false);
});
test("file JSON transport cannot bypass the binary path",()=>{
  expect(StorageJsonRequest.safeParse({area:"files",operation:"write",key:"x",content:"eA=="}).success).toBe(false);
  expect(StorageJsonRequest.safeParse({area:"files",operation:"list"}).success).toBe(true);
});
