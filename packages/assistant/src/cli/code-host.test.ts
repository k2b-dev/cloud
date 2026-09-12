import { expect, test } from "bun:test";
import { createCliCodeHost } from "./code-host";
import { cliHostBundle } from "../artifacts/runtime/cli-bundle";
import { compileArtifact } from "../artifacts/runtime/compile";

test("CLI runs one-off code in the existing isolated worker without a GUI chat", async () => {
  const code = 'export default async () => { await files.save("42", "answer.txt"); return { answer: 42, serverProcess: typeof process, networkBlocked: await fetch("https://example.invalid/").then(() => false, () => true) }; }';
  const bundle = await cliHostBundle();
  const compiled = await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code}]});
  const requests: string[] = [];
  const host = await createCliCodeHost({fetch: async (input) => {
    const path = String(input); requests.push(path);
    if (path.endsWith("host.js")) return new Response(bundle);
    if (path.endsWith("/claim")) return Response.json({status:"execute"});
    if (path.endsWith("/complete")) return Response.json({saved:true});
    if (path.endsWith("/compile")) return Response.json(compiled);
    if (path.includes("/files")) return Response.json({files:[]});
    if (path.includes("/artifacts/")) return Response.json({id:"00000000-0000-4000-8000-000000000001",kind:"app",revision:1});
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
    expect(exported).toMatchObject({path:"/artifact-standalone-answer.txt",size:2});
    const rejected = await host.call({...ids,name:"code_run",callId:"app-files",args:{id:ids.conversationId,inputPaths:["private.csv"]}});
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
    if(path.includes("/artifacts/"))return Response.json({id:"00000000-0000-4000-8000-000000000001",kind:"app",revision:1,sourceRevision:1});
    throw new Error(`Unexpected request ${path}`);
  }});
  const ids={conversationId:"00000000-0000-4000-8000-000000000001",turnId:"00000000-0000-4000-8000-000000000001"};
  try {
    const listed=await host.execute({...ids,name:"code_run",callId:"list-only",args:{code:"export default async()=>({count:(await files.list()).length})",inputPaths:["/folder/report.csv"]}});
    expect(listed).toMatchObject({output:'{"count":1}'});expect(reads).toBe(0);
    const picked=await host.execute({...ids,name:"code_run",callId:"picker",args:{id:ids.conversationId,inputPaths:["/folder/report.csv"]}});
    expect(picked).toMatchObject({output:JSON.stringify({hidden:0,path:"/folder/report.csv",text:"hello"})});expect(reads).toBe(1);
    const denied=await host.execute({...ids,name:"code_run",callId:"unselected",args:{code:'export default async()=>await files.read("/not-selected.csv")',inputPaths:["/folder/report.csv"]}});
    expect(denied).toMatchObject({status:"error"});expect(reads).toBe(1);
  }finally{await host.close();}
},30000);

test("database error codes survive HTTP and the worker bridge",async()=>{
  const id="00000000-0000-4000-8000-000000000001";
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
    await run("interactive",'export default()=>{ui.button("Keep",()=>{}, {id:"keep"});}');
    await run("retained-work",'export default()=>{work.run(async job=>{await new Promise(r=>setTimeout(r,30000));await job.checkpoint();});}');
    for(let i=0;i<32;i++)expect(await run(`probe-${i}`,`export default()=>${i}`)).toMatchObject({status:"ready"});
    expect(await host.execute({...ids,name:"code_inspect",callId:"files",args:{runId:"retained"}})).toMatchObject({files:[{name:"result.csv"}]});
    expect(await host.execute({...ids,name:"code_inspect",callId:"ui",args:{runId:"interactive"}})).toMatchObject({nodes:[{id:"keep"}]});
    expect(await host.execute({...ids,name:"code_inspect",callId:"work",args:{runId:"retained-work"}})).toMatchObject({work:{status:"running"}});
    expect(await host.execute({...ids,name:"code_inspect",callId:"old",args:{runId:"probe-0"}})).toHaveProperty("error");
    expect(await run("truncated",'export default()=>"x".repeat(20000)')).toMatchObject({outputTruncated:true});
  }finally{await host.close();}
},60000);
