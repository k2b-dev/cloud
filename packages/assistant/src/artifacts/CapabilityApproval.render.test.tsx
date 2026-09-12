import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, createRoot } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "assistant-empty-chat-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { createCodeApprovals } = await import("./CapabilityApproval");
import type { CapabilityApproval } from "./runtime/capabilities";

test("pending code approval remains visible outside its originating chat and names shared data access",async()=>{
  const approvals=createRoot(()=>createCodeApprovals());
  const signal=new AbortController();
  const request={status:"approval",id:"00000000-0000-4000-8000-000000000001",name:"contacts.list",input:{},appId:"contacts",localId:"list",kind:"query",schemaHash:"test",approval:null,title:"Read contacts",review:null,allowAlways:false,scope:null,resource:{id:"00000000-0000-4000-8000-000000000002",title:"Shared app"}} satisfies CapabilityApproval;
  const pending=approvals.ask(request,signal.signal,"old-chat").catch(error=>error.message);
  const html=renderToString(()=>createComponent(approvals.View,{conversationTitle:id=>id==="old-chat"?"Original chat":undefined}));
  expect(html).toContain("Original chat");expect(html).toContain("Shared app");
  expect(html).toContain("personal remembered approvals");
  signal.abort();expect(await pending).toBe("Run stopped");
  expect(renderToString(()=>createComponent(approvals.View,{conversationTitle:()=>undefined}))).not.toContain("Shared app");
});
