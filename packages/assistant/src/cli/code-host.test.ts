import { expect, test } from "bun:test";
import { createCliCodeHost } from "./code-host";
import { cliHostBundle } from "../artifacts/runtime/cli-bundle";
import { compileArtifact } from "../artifacts/runtime/compile";

test("published actions execute in the isolated host and validate their returned value", async () => {
  const source = { entry: "main.ts", files: [
    { path: "app.actions.json", content: JSON.stringify({ actions: [{ name: "double", title: "Double", description: "Double a number", entry: "double.ts", inputSchema: { type: "number" }, outputSchema: { type: "number" } }] }) },
    { path: "double.ts", content: "export default (value: number) => value * 2;" },
  ] };
  const compiled = await compileArtifact(source, { action: "double", input: 3 });
  const bundle = await cliHostBundle();
  let outputSchema = { type: "number" };
  const host = await createCliCodeHost({ fetch: async (input, init) => {
    const path = String(input);
    if (path.endsWith("host.js")) return new Response(bundle);
    if (path.includes("runtime/action")) {
      expect(JSON.parse(await new Response(init?.body).text())).toEqual({ id: "aBc234", action: "double", publishedVersion: 1, input: 3 });
      return Response.json({ compiled, outputSchema, resource: { id: "aBc234", kind: "app", sourceRevision: 1 } });
    }
    throw new Error(`Unexpected action host request: ${path}`);
  } });
  const call = { name: "code_action", conversationId: crypto.randomUUID(), turnId: crypto.randomUUID(), args: { id: "aBc234", action: "double", publishedVersion: 1, input: 3 } };
  try {
    expect(await host.execute({ ...call, callId: "action" })).toMatchObject({ status: "ready", output: "6", nodes: [] });
    outputSchema = { type: "string" };
    expect(await host.execute({ ...call, callId: "invalid-output" })).toMatchObject({ runId: "invalid-output", status: "error", error: expect.stringContaining("schema") });
  } finally { await host.close(); }
}, 60000);

test("CLI runs one-off code in the existing isolated worker without a GUI chat", async () => {
  const code = 'export default async () => { await files.save("42", "answer.txt"); return { answer: 42, serverProcess: typeof process, networkBlocked: await fetch("https://example.invalid/").then(() => false, () => true) }; }';
  const bundle = await cliHostBundle();
  const compiled = await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code}]});
  const requests: string[] = [];
  const host = await createCliCodeHost({fetch: async (input,init) => {
    const path = String(input); requests.push(path);
    if (path.endsWith("host.js")) return new Response(bundle);
    if (path.endsWith("/claim")) return Response.json({status:"execute"});
    if (path.endsWith("/complete")) return Response.json({saved:true});
    if (path.endsWith("/compile")) return Response.json(compiled);
    if (path.includes("/files") && init?.method==="POST"){
      const form=await new Response(init.body,{headers:{"content-type":new Headers(init.headers).get("content-type")!}}).formData();
      expect(form.get("directory")).toBe("/files");
      return Response.json({file:{path:"/files/answer-2.txt",version:1}});
    }
    if (path.includes("/files")) return Response.json({files:[]});
    if (path.includes("/artifacts/")) return Response.json({id:"aBc234",kind:"app",revision:1});
    throw new Error(`Unexpected host request ${path}`);
  }});
  const ids = {conversationId:"00000000-0000-4000-8000-000000000001",turnId:"00000000-0000-4000-8000-000000000001"};
  try {
    const result = await host.call({...ids,name:"code_run",callId:"one-off",args:{code}});
    expect(result).toMatchObject({status:"ready",output:JSON.stringify({answer:42,serverProcess:"undefined",networkBlocked:true})});
    expect(requests.some(path => path.endsWith("/compile"))).toBe(true);
    const claims = requests.filter(path => path.endsWith("/claim")).length;
    const standalone = await host.execute({...ids,name:"code_run",callId:"standalone",args:{code}});
    expect(standalone).toMatchObject({status:"ready",output:JSON.stringify({answer:42,serverProcess:"undefined",networkBlocked:true})});
    expect(requests.filter(path => path.endsWith("/claim"))).toHaveLength(claims);
    const inspected = await host.execute({...ids,name:"code_inspect",callId:"inspect",args:{runId:"standalone"}});
    expect(inspected).toMatchObject({runId:"standalone",status:"ready"});
    const exported = await host.execute({...ids,name:"code_export",callId:"export",args:{runId:"standalone",name:"answer.txt"}});
    expect(exported).toMatchObject({path:"/files/answer-2.txt",size:2});
    const rejected = await host.call({...ids,name:"code_run",callId:"app-files",args:{id:"aBc234",inputPaths:["private.csv"]}});
    expect(rejected).toMatchObject({error:"Input not found: private.csv"});
  } finally { await host.close(); }
}, 60000);

test("closing the CLI host cancels its in-flight server request", async () => {
  const bundle = await cliHostBundle();
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => {started=resolve;});
  let aborted = false;
  const host = await createCliCodeHost({fetch: async (input,init) => {
    if (String(input).endsWith("host.js")) return new Response(bundle);
    if (!String(input).endsWith("/compile")) throw new Error(`Unexpected request ${input}`);
    const signal=init?.signal;
    if (!signal) throw new Error("Missing cancellation signal");
    started();
    return new Promise<Response>((_resolve,reject)=>signal.addEventListener("abort",()=>{
      aborted=true;reject(new DOMException("Host closed","AbortError"));
    },{once:true}));
  }});
  try {
    const pending=host.execute({name:"code_run",callId:"cancel",conversationId:"00000000-0000-4000-8000-000000000001",turnId:crypto.randomUUID(),args:{code:"export default () => 42"}}).catch(()=>null);
    await requestStarted;
    await host.close();
    await pending;
    expect(aborted).toBe(true);
  } finally {await host.close();}
},60000);

test("CLI worker chains capabilities through host approvals and keeps denial out of worker control", async () => {
  const code=`export default async () => {
    const first=await capabilities.run("demo.read",{});
    const [second]=await Promise.all([capabilities.run("demo.write",{value:first.data.value}),capabilities.run("demo.read",{})]);
    let denied=false;
    try {await capabilities.run("demo.denied",{});} catch {denied=true;}
    return {value:second.data.value,denied};
  }`;
  const compiled=await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code}]});
  const bundle=await cliHostBundle(),pending=new Map<string,string>(),decisions:string[]=[];
  const host=await createCliCodeHost({fetch:async(input,init)=>{
    const path=String(input);
    if(path.endsWith("host.js"))return new Response(bundle);
    if(path.endsWith("/claim"))return Response.json({status:"execute"});
    if(path.endsWith("/complete"))return Response.json({saved:true});
    if(path.endsWith("/compile"))return Response.json(compiled);
    if(path.endsWith("/capabilities")){
      const body=await new Response(init?.body).json();
      if(body.name==="demo.read")return Response.json({status:"completed",result:{ok:true,data:{data:{value:7}}}});
      pending.set(body.id,body.name);
      return Response.json({status:"approval",id:body.id,name:body.name,input:body.input,appId:"demo",localId:body.name.split(".")[1],kind:"action",schemaHash:"hash",title:"Write",review:null,allowAlways:false,scope:null});
    }
    if(path.endsWith("/resolve")){
      const decision=await new Response(init?.body).json();
      return Response.json(decision.approved ? {status:"completed",result:{ok:true,data:{data:{value:14}}}} : {status:"denied"});
    }
    throw new Error(`Unexpected request ${path}`);
  }},async request=>{
    decisions.push(request.name);
    // A human may take longer than the normal 45-second operation watchdog.
    if (request.name === "demo.write") await Bun.sleep(46000);
    return {approved:request.name!=="demo.denied"};
  });
  try {
    const result=await host.call({name:"code_run",callId:"chain",conversationId:"00000000-0000-4000-8000-000000000001",turnId:"00000000-0000-4000-8000-000000000001",args:{code}});
    expect(result).toMatchObject({status:"ready",output:JSON.stringify({value:14,denied:true})});
    expect(decisions).toEqual(["demo.write","demo.denied"]);
    expect(pending.size).toBe(2);
  } finally {await host.close();}
},90000);

test("chat inputs load on demand and app fixtures are visible only to the picker",async()=>{
  const appCode='export default async()=>{const hidden=await files.list();const picked=await files.openFolder();return {hidden:hidden.length,path:files.path(picked[0]),text:await picked[0].text()};}';
  const appSource=await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:appCode}]});
  const bundle=await cliHostBundle();let reads=0;
  const host=await createCliCodeHost({fetch:async(input,init)=>{
    const path=String(input);
    if(path.endsWith("host.js"))return new Response(bundle);
    if(path.endsWith("/compile"))return Response.json(await compileArtifact(await new Response(init?.body).json()));
    if(path.includes("/files/content?")){reads++;return new Response("hello",{headers:{"content-type":"text/plain"}});}
    if(path.endsWith("/files"))return Response.json({files:[{path:"/folder/report.csv",size:5,mediaType:"text/plain"}]});
    if(path.includes("/compiled"))return Response.json({...appSource,revision:1});
    if(path.includes("/artifacts/"))return Response.json({id:"aBc234",kind:"app",revision:1,sourceRevision:1});
    throw new Error(`Unexpected request ${path}`);
  }});
  const ids={conversationId:"00000000-0000-4000-8000-000000000001",turnId:"00000000-0000-4000-8000-000000000001"};
  try {
    const listed=await host.execute({...ids,name:"code_run",callId:"list-only",args:{code:"export default async()=>({count:(await files.list()).length})",inputPaths:["/folder/report.csv"]}});
    expect(listed).toMatchObject({output:'{"count":1}'});expect(reads).toBe(0);
    const picked=await host.execute({...ids,name:"code_run",callId:"picker",args:{id:"aBc234",inputPaths:["/folder/report.csv"]}});
    expect(picked).toMatchObject({output:JSON.stringify({hidden:0,path:"/folder/report.csv",text:"hello"})});expect(reads).toBe(1);
    const denied=await host.execute({...ids,name:"code_run",callId:"unselected",args:{code:'export default async()=>await files.read("/not-selected.csv")',inputPaths:["/folder/report.csv"]}});
    expect(denied).toMatchObject({status:"error"});expect(reads).toBe(1);
  }finally{await host.close();}
},30000);

test("database error codes survive HTTP and the worker bridge",async()=>{
  const id="aBc234";
  const code='export default async()=>{try{await database.connect();return "unexpected success";}catch(error){return {code:error.code,message:error.message};}}';
  const source=await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code}]});
  const bundle=await cliHostBundle();
  const host=await createCliCodeHost({fetch:async(input)=>{
    const path=String(input);
    if(path.endsWith("host.js"))return new Response(bundle);
    if(path.endsWith("/files"))return Response.json({files:[]});
    if(path.includes("/database/connect"))return Response.json({code:"DB_NOT_CONFIGURED",message:"Configure rsql first"},{status:503});
    if(path.includes("/compiled"))return Response.json({...source,revision:1});
    if(path.includes("/artifacts/"))return Response.json({id,kind:"script",revision:1,sourceRevision:1});
    throw new Error(`Unexpected request ${path}`);
  }});
  try{
    const result=await host.execute({name:"code_run",callId:"db-error",conversationId:id,turnId:id,args:{id}});
    expect(result).toMatchObject({status:"ready",output:JSON.stringify({code:"DB_NOT_CONFIGURED",message:"Configure rsql first"})});
  }finally{await host.close();}
},30000);

test("slow chat input crosses startup deadlines and invalid arguments remain input errors",async()=>{
  const bundle=await cliHostBundle();
  let reads=0;
  const host=await createCliCodeHost({fetch:async(input,init)=>{
    const path=String(input);
    if(path.endsWith("host.js"))return new Response(bundle);
    if(path.endsWith("/compile"))return Response.json(await compileArtifact(await new Response(init?.body).json()));
    if(path.endsWith("/files"))return Response.json({files:[{path:"/slow.csv",size:4,mediaType:"text/csv"}]});
    if(path.includes("/files/content?")){reads++;await Bun.sleep(22000);return new Response("x\n1\n");}
    throw new Error(`Unexpected request ${path}`);
  }});
  const ids={conversationId:"00000000-0000-4000-8000-000000000001",turnId:"00000000-0000-4000-8000-000000000001"};
  try{
    const invalid=await host.execute({...ids,name:"code_run",callId:"invalid",args:{code:"export default()=>42",id:ids.conversationId}});
    expect(invalid).toMatchObject({kind:"input"});expect(reads).toBe(0);
    const result=await host.execute({...ids,name:"code_run",callId:"slow",args:{code:'export default async()=>({rows:(await sheet.fromCsv(await files.read("/slow.csv"),{delimiter:","})).length})',inputPaths:["/slow.csv"]}});
    expect(result).toMatchObject({status:"ready",output:'{"rows":1}',outputTruncated:false});expect(reads).toBe(1);
  }finally{await host.close();}
},35000);

test("scratchpad pressure preserves exports and interactive runs while reclaiming old results",async()=>{
  const bundle=await cliHostBundle();
  const host=await createCliCodeHost({fetch:async(input,init)=>{
    const path=String(input);
    if(path.endsWith("host.js"))return new Response(bundle);
    if(path.endsWith("/compile"))return Response.json(await compileArtifact(await new Response(init?.body).json()));
    throw new Error(`Unexpected request ${path}`);
  }});
  const ids={conversationId:"00000000-0000-4000-8000-000000000001",turnId:"00000000-0000-4000-8000-000000000001"};
  const run=(callId:string,code:string)=>host.execute({...ids,name:"code_run",callId,args:{code}});
  try{
    await run("retained",'export default async()=>{await files.save("important","result.csv");return 1;}');
    await run("interactive",'export default()=>{ui.button({label:"Keep",onClick:()=>{},id:"keep"});}');
    await run("retained-work",'export default()=>{work.run(async job=>{for(;;){await new Promise(r=>setTimeout(r,1000));await job.checkpoint();}});}');
    for(let i=0;i<32;i++)expect(await run(`probe-${i}`,`export default()=>${i}`)).toMatchObject({status:"ready"});
    expect(await host.execute({...ids,name:"code_inspect",callId:"files",args:{runId:"retained"}})).toMatchObject({files:[{name:"result.csv"}]});
    expect(await host.execute({...ids,name:"code_inspect",callId:"ui",args:{runId:"interactive"}})).toMatchObject({nodes:[{id:"keep"}]});
    expect(await host.execute({...ids,name:"code_inspect",callId:"work",args:{runId:"retained-work"}})).toMatchObject({work:{status:"running"}});
    expect(await host.execute({...ids,name:"code_inspect",callId:"old",args:{runId:"probe-0"}})).toHaveProperty("error");
    expect(await run("truncated",'export default()=>"x".repeat(20000)')).toMatchObject({outputTruncated:true});
  }finally{await host.close();}
},60000);

test("slow database and shared storage calls do not consume the short callback deadline",async()=>{
  const id="aBc234";
  const code='export default()=>{ui.button({label:"Import",onClick:async()=>{await database.connect();await kv.shared.set("done",true);ui.text({value:"Finished"});},id:"import"});}';
  const compiled=await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code}]});
  const bundle=await cliHostBundle();
  const host=await createCliCodeHost({fetch:async input=>{
    const path=String(input);
    if(path.endsWith("host.js"))return new Response(bundle);
    if(path.includes("/compiled"))return Response.json({...compiled,revision:1});
    if(path.includes("/database/connect")){await Bun.sleep(17000);return Response.json({connected:true});}
    if(path.includes("/storage")){await Bun.sleep(17000);return Response.json({written:true});}
    if(path.includes("/artifacts/"))return Response.json({id,kind:"app",revision:1,sourceRevision:1});
    throw new Error(`Unexpected request ${path}`);
  }});
  try{
    const ids={conversationId:id,turnId:id};
    expect(await host.execute({...ids,name:"code_run",callId:"slow-io",args:{id}})).toMatchObject({status:"ready"});
    expect(await host.execute({...ids,name:"code_interact",callId:"import",args:{runId:"slow-io",id:"import"}})).toMatchObject({status:"ready",nodes:[{id:"import"},{type:"text",value:"Finished"}]});
  }finally{await host.close();}
},45000);

// Each sequential replacement gets its own lifecycle budget. Keep all cycles in
// one test process so finalizers from older hosts run against the replacement.
test.each([0, 1, 2])("replacing CLI hosts survives garbage collection without losing the new browser (cycle %i)", async (cycle) => {
  const bundle = await cliHostBundle();
  const code = "export default () => 42";
  const compiled = await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code}]});
  const host = await createCliCodeHost({fetch: async input => {
    if (String(input).endsWith("host.js")) return new Response(bundle);
    if (String(input).endsWith("/compile")) return Response.json(compiled);
    throw new Error(`Unexpected host request ${input}`);
  }});
  try {
    for (let probe = 0; probe < 8; probe++) {
      // The old shared-process launcher loses its new Chromium pipe when
      // finalizers from a previously closed browser run here.
      Bun.gc(true);
      expect(await host.execute({name:"code_run",callId:`gc-${cycle}-${probe}`,conversationId:crypto.randomUUID(),turnId:crypto.randomUUID(),args:{code}}))
        .toMatchObject({status:"ready",output:"42"});
    }
  } finally { await host.close(); }
  await host.close();
}, 30000);

test("finance exports and resource-scoped one-offs use the existing worker and management routes", async () => {
  const id = "aBc234";
  const bundle = await cliHostBundle();
  const document = await Bun.file(new URL("../../skills/code-mode/references/finance.md", import.meta.url)).text();
  const example = document.match(/```js\n([\s\S]*?)```/)![1]!;
  const code = example.replace("return { bookings:", `const db = await database.connect();
    const tables = await db.tables();
    await kv.shared.set("probe", {ok:true});
    return { tables, invalid: datev.validate({}).ok, local: await kv.local.get("probe"), bookings:`);
  const requests: string[] = [];
  let denied = false;
  const host = await createCliCodeHost({ fetch: async (input, init) => {
    const path = String(input); requests.push(path);
    if (path.endsWith("host.js")) return new Response(bundle);
    if (path.endsWith("/access")) return denied ? Response.json({code:"ACCESS_DENIED",message:"Manage required"},{status:403}) : Response.json([]);
    if (path.endsWith("/compile")) {
      const compiled = await compileArtifact(await new Response(init?.body).json());
      expect(compiled.runtime).not.toContain("libxml2");
      return Response.json(compiled);
    }
    if (path.includes("/database/maintenance/connect")) return Response.json({connected:true});
    if (path.includes("/database/maintenance")) return Response.json({tables:[]});
    if (path.endsWith("/storage/manage")) return Response.json({saved:true});
    throw new Error(`Unexpected request ${path}`);
  }});
  try {
    const args = {code, resourceId:id};
    const result = await host.execute({name:"code_run",callId:"finance",conversationId:id,turnId:id,args});
    expect(result).toMatchObject({status:"ready"});
    if (!result || typeof result !== "object" || !("output" in result)) throw new Error("Missing output");
    expect(JSON.parse(String(result.output))).toMatchObject({bookings:2,transfers:2,total:"12.31",debit:"123.45",credit:"3.00",invalid:false,local:null});
    expect(JSON.stringify(result)).toContain("buchungen.csv");
    expect(JSON.stringify(result)).toContain("ueberweisungen.xml");
    expect(requests.some(path=>path.endsWith("/storage/manage"))).toBe(true);
    denied = true;
    const rejected = await host.execute({name:"code_run",callId:"denied-context",conversationId:id,turnId:id,args});
    expect(rejected).toMatchObject({error:"Manage required"});
  } finally { await host.close(); }
}, 30000);


test("HTTP crosses the real CLI worker bridge as secret references and waits for trusted consent",async()=>{
  const code='export default async()=>{const response=await http.fetch("https://api.example.com/data",{headers:{Authorization:secret("crm",{prefix:"Bearer "})}});return {status:response.status,data:await response.json()};}';
  const bundle=await cliHostBundle(), compiled=await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code}]});
  let sent=0,approved=0;
  const host=await createCliCodeHost({fetch:async(input,init)=>{
    const path=String(input);
    if(path.endsWith("host.js"))return new Response(bundle);
    if(path.endsWith("/compile"))return Response.json(compiled);
    const body=await new Response(init?.body).json();
    if(path.endsWith("/runtime/http")){
      expect(body.request.headers.authorization).toEqual({secret:"crm",prefix:"Bearer "});
      return Response.json({id:body.id,url:body.request.url,method:"GET",headers:body.request.headers,bodyBytes:0,bodyPreview:"",bodyTruncated:false});
    }
    if(path.includes("/runtime/http/")){
      expect(approved).toBe(1);expect(body.approved).toBe(true);sent++;
      return Response.json({status:200,headers:{"content-type":"application/json"},body:btoa('{"count":7}')});
    }
    throw new Error(`Unexpected path ${path}`);
  }},async request=>{expect("type" in request && request.type).toBe("http");expect(request.name).toBe("http.fetch:https://api.example.com");approved++;return {approved:true};});
  try{
    const result=await host.execute({name:"code_run",callId:"http-test",conversationId:crypto.randomUUID(),turnId:crypto.randomUUID(),args:{code}});
    expect(result).toMatchObject({status:"ready",output:JSON.stringify({status:200,data:{count:7}})});expect(sent).toBe(1);
  }finally{await host.close();}
},60000);

test("CLI uses UI typed controls and bounded explorer inspection", async () => {
  const code = `export default()=>{
    const output=ui.text({id:"output",value:"Before"});
    ui.number({id:"count",label:"Count",value:1,onChange(value){output.setValue("Count: "+value);}});
    ui.chartExplorer({id:"chart",label:"Chart",columns:[{key:"value",label:"Value"}],data:{rowKey:"id",rows:[{id:"a",value:4}],chart:{kind:"bar",category:"id",value:"value"}}});
  };`;
  const bundle=await cliHostBundle();
  const compiled=await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code}]});
  const host=await createCliCodeHost({fetch:async input=>{
    const path=String(input);
    if(path.endsWith("host.js"))return new Response(bundle);
    if(path.endsWith("/compile"))return Response.json(compiled);
    if(path.includes("/files"))return Response.json({files:[]});
    throw new Error(`Unexpected request ${path}`);
  }});
  const ids={conversationId:"00000000-0000-4000-8000-000000000001",turnId:"00000000-0000-4000-8000-000000000001"};
  try{
    expect(await host.execute({...ids,name:"code_run",callId:"analytics",args:{code}})).toMatchObject({status:"ready"});
    expect(await host.execute({...ids,name:"code_interact",callId:"change",args:{runId:"analytics",id:"count",event:{type:"change",value:7}}})).toMatchObject({status:"ready",nodes:expect.arrayContaining([expect.objectContaining({id:"output",value:"Count: 7"})])});
    expect(await host.execute({...ids,name:"code_inspect",callId:"inspect",args:{runId:"analytics",nodeId:"chart",limit:1}})).toMatchObject({nodes:[expect.objectContaining({rows:[{id:"a",value:4}],totalRows:1})]});
    expect(await host.execute({...ids,name:"code_interact",callId:"batch",args:{runId:"analytics",steps:[
      {id:"count",event:{type:"change",value:8}},{id:"chart",event:{type:"view",value:"table"}},{id:"count",event:{type:"change",value:9}},
    ]}})).toMatchObject({completedSteps:3,nextStep:null,nodes:expect.arrayContaining([expect.objectContaining({id:"output",value:"Count: 9"})])});
    const failed=await host.execute({...ids,name:"code_interact",callId:"batch-failure",args:{runId:"analytics",steps:[
      {id:"count",event:{type:"change",value:10}},{id:"missing"},{id:"count",event:{type:"change",value:11}},
    ]}});
    expect(failed).toHaveProperty("error");
    expect(await host.execute({...ids,name:"code_inspect",callId:"after-failure",args:{runId:"analytics"}}))
      .toMatchObject({nodes:expect.arrayContaining([expect.objectContaining({id:"output",value:"Count: 10"})])});

  }finally{await host.close();}
},60000);

test("documented CSV dashboard uses numeric KPIs and survives real filter/reset interactions",async()=>{
  const reference=await Bun.file(new URL("../../skills/code-mode/references/examples.md",import.meta.url)).text();
  const section=reference.split("## CSV dashboard with a KPI")[1]!;
  const code=section.match(/```js\n([\s\S]*?)```/)?.[1];
  const csv=section.match(/```csv\n([\s\S]*?)```/)?.[1];
  if(!code||!csv)throw new Error("Missing runnable dashboard example");
  const compiled=await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code},{path:"sales.csv",content:csv}]});
  const bundle=await cliHostBundle();
  const host=await createCliCodeHost({fetch:async input=>{
    const path=String(input);
    if(path.endsWith("host.js"))return new Response(bundle);
    if(path.includes("/compiled"))return Response.json({...compiled,revision:7});
    if(path.includes("/files"))return Response.json({files:[]});
    if(path.includes("/artifacts/"))return Response.json({id:"aBc234",kind:"app",revision:7,sourceRevision:7});
    throw new Error(`Unexpected request: ${path}`);
  }});
  const identity={conversationId:crypto.randomUUID(),turnId:crypto.randomUUID()};
  const run=async(name:string,callId:string,args:unknown)=>host.execute({...identity,name,callId,args});
  try {
    expect(await run("code_run","demo",{id:"aBc234"})).toMatchObject({status:"ready",revision:7,nodes:expect.arrayContaining([expect.objectContaining({id:"revenue",type:"stat",value:600})])});
    expect(await run("code_interact","filter",{runId:"demo",steps:[{id:"regions",event:{type:"change",value:["North"]}},{id:"dates",event:{type:"change",value:{start:"2026-02-01",end:"2026-02-28"}}}]})).toMatchObject({status:"ready",completedSteps:2,nodes:expect.arrayContaining([expect.objectContaining({id:"revenue",value:300})])});
    expect(await run("code_interact","reset",{runId:"demo",steps:[{id:"reset"},{id:"monthly",event:{type:"view",value:"table"}}]})).toMatchObject({status:"ready",completedSteps:2,nodes:expect.arrayContaining([expect.objectContaining({id:"revenue",value:600}),expect.objectContaining({id:"monthly",view:"table",totalRows:2})])});
    await host.health();
  } finally {await host.close();}
},60000);

test("shared files cross the CLI/browser host as binary above the JSON budget",async()=>{
  const bundle=await cliHostBundle();
  let stored=new Uint8Array();
  const host=await createCliCodeHost({fetch:async(input,init)=>{
    const url=new URL(String(input),"http://localhost");
    if(url.pathname.endsWith("host.js"))return new Response(bundle);
    if(url.pathname.endsWith("/access"))return Response.json([]);
    if(url.pathname.endsWith("/compile"))return Response.json(await compileArtifact(await new Response(init?.body).json()));
    if(url.pathname.endsWith("/storage/file")){
      expect(url.searchParams.get("management")).toBe("true");
      if(init?.method==="PUT"){
        stored=new Uint8Array(await new Response(init.body).arrayBuffer());
        return Response.json({written:true});
      }
      return new Response(stored,{headers:{"content-type":"application/octet-stream"}});
    }
    throw new Error(`Unexpected request ${url}`);
  }});
  try{
    const result=await host.execute({name:"code_run",callId:"binary",conversationId:"aBc234",turnId:"aBc234",args:{resourceId:"aBc234",code:`export default async()=>{
      const bytes=new Uint8Array(17*1024*1024);bytes[0]=255;
      await files.shared.write("binary",new Blob([bytes]));
      const file=await files.shared.read("binary");
      return {size:file.size,first:new Uint8Array(await file.arrayBuffer())[0]};
    }`}});
    expect(result).toMatchObject({status:"ready"});
    expect(stored.length).toBe(17*1024*1024);
    expect(JSON.stringify(result)).toContain('17825792');
    expect(JSON.stringify(result)).toContain('255');
  }finally{await host.close();}
},30000);

test("native host transport reads and writes a 50 MiB binary file without IPC body copies", async () => {
  const code = `export default async () => {
    const source = await capabilities.run("demo.read", {});
    const file = await capabilities.streams.read(source.stream);
    const target = await capabilities.run("demo.write", {});
    const result = await capabilities.streams.write(target.stream, file);
    return { size: file.size, saved: result.data.bytes };
  }`;
  const compiled = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
  const bundle = await cliHostBundle();
  const size = 50 * 1024 * 1024;
  let uploaded = 0;
  const host = await createCliCodeHost({ fetch: async (input, init) => {
    const path = String(input);
    if (path.endsWith("host.js")) return new Response(bundle);
    if (path.endsWith("/compile")) return Response.json(compiled);
    if (path.endsWith("/capabilities")) {
      const request = await new Response(init?.body).json();
      return Response.json({ status: "completed", result: { ok: true, data: { data: {}, stream: {
        id: request.id, direction: request.name === "demo.read" ? "read" : "write", size,
        mediaType: "application/octet-stream", expiresAt: new Date(Date.now() + 60000).toISOString(),
      } } } });
    }
    if (path.endsWith("/stream/read")) {
      let sent = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (sent === size) return controller.close();
        const chunk = new Uint8Array(64 * 1024).fill(173); sent += chunk.length; controller.enqueue(chunk);
      } }));
    }
    if (path.endsWith("/stream/write")) {
      if (!(init?.body instanceof ReadableStream)) throw new Error("Expected streaming request body");
      for await (const chunk of init.body) {
        if (!(chunk instanceof Uint8Array) || chunk.some(byte => byte !== 173)) throw new Error("Binary data corrupted");
        uploaded += chunk.length;
      }
      return Response.json({ data: { bytes: uploaded } });
    }
    throw new Error(`Unexpected request ${path}`);
  } });
  try {
    expect(await host.execute({ name: "code_run", callId: "large-stream", conversationId: crypto.randomUUID(), turnId: crypto.randomUUID(), args: { code } }))
      .toMatchObject({ status: "ready", output: JSON.stringify({ size, saved: size }) });
    expect(uploaded).toBe(size);
  } finally { await host.close(); }
}, 60000);
