import { afterAll, beforeAll, test, expect } from "bun:test";
import { chromium, type Browser } from "playwright";
import { compileArtifact } from "./runtime/compile";

let browser: Browser;
let code: string;
beforeAll(async () => {
  const build=Bun.spawn(["bun",new URL("./workspace-browser-build.ts",import.meta.url).pathname,"./runner-browser-harness.tsx"],{stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,exitCode]=await Promise.all([new Response(build.stdout).text(),new Response(build.stderr).text(),build.exited]);
  if(exitCode)throw new Error(stderr);
  code=stdout;
  browser=await chromium.launch({headless:true,timeout:10000});
},30000);
afterAll(async () => {await browser?.close();});

test("standalone public runner starts local code and blocks every server bridge without Assistant requests", async () => {
  const compiled=await compileArtifact({entry:"main.js",files:[{path:"main.js",content:`export default async () => {
    ui.text({value:"Local calculation: " + (6*7)});
    for (const [name,call] of [
      ["database",()=>database.connect()],
      ["files",()=>files.shared.list()],
      ["kv",()=>kv.shared.keys()],
      ["http",()=>http.fetch("https://example.com")],
      ["capabilities",()=>capabilities.run("core.entities.search",{})]
    ]) { try {await call();ui.text({value:"UNEXPECTED: " + name});} catch {ui.text({value:"Blocked: " + name});} }
    const selected=await files.open();
    if(selected)ui.text({value:"Local file: " + await selected.text()});
  }`}]});
  const metadata={id:"Run001",title:"Public calculator",sourceRevision:1,publishedVersion:1,serverAccess:false,canManage:false};
  const requests:string[]=[];
  const server=Bun.serve({port:0,fetch(request){
    const path=new URL(request.url).pathname;requests.push(path);
    if(path==="/bundle.js")return new Response(code,{headers:{"content-type":"application/javascript"}});
    if(path==="/api/assistant/runner/Run001")return Response.json(metadata);
    if(path==="/api/assistant/runner/Run001/compiled")return Response.json({...compiled,metadata});
    if(path.startsWith("/api/"))return new Response("Unexpected protected request",{status:403});
    return new Response('<html><meta charset="utf-8"><body><div id="root"></div><script src="/bundle.js"></script></body></html>',{headers:{"content-type":"text/html"}});
  }});
  const context=await browser.newContext();
  context.setDefaultTimeout(10000);
  try {
    const page=await context.newPage();
    const chooser=page.waitForEvent("filechooser");
    await page.goto(server.url.href);
    await page.getByText("Local calculation: 42",{exact:true}).waitFor();
    for(const name of ["database","files","kv","http","capabilities"])await page.getByText(`Blocked: ${name}`,{exact:true}).waitFor();
    await (await chooser).setFiles({name:"local.txt",mimeType:"text/plain",buffer:Buffer.from("works")});
    await page.getByText("Local file: works",{exact:true}).waitFor();
    expect(requests.filter(path=>path.startsWith("/api/") && !path.startsWith("/api/assistant/runner/"))).toEqual([]);
    expect(await page.getByRole("link",{name:"Manage",exact:true}).count()).toBe(0);
    expect(await page.getByText("UNEXPECTED:",{exact:false}).count()).toBe(0);
    expect(await page.locator('.k2b-app-workspace__sidebar').count()).toBe(0);
  } finally {await context.close();server.stop(true);}
},60000);

test("runner explains access changes, restarts with isolated public storage, and stops after revocation", async () => {
  const compiled=await compileArtifact({entry:"main.js",files:[{path:"main.js",content:`export default async () => {
    const count=(await kv.local.get("count") ?? 0)+1;
    await kv.local.set("count",count);
    ui.text({value:"Counter: "+count});
    ui.button({label:"Ping",onClick:()=>console.info("pong")});
  }`}]});
  let serverAccess=true, revoked=false, starts=0;
  const metadata=()=>({id:"Run001",title:"Public calculator",sourceRevision:1,publishedVersion:1,serverAccess,canManage:false});
  const server=Bun.serve({port:0,fetch(request){
    const path=new URL(request.url).pathname;
    if(path==="/bundle.js")return new Response(code,{headers:{"content-type":"application/javascript"}});
    if(path.startsWith("/api/assistant/runner/Run001")) {
      if(revoked)return Response.json({message:"Unavailable"},{status:404});
      if(path.endsWith("/compiled")){starts++;return Response.json({...compiled,metadata:metadata()});}
      return Response.json(metadata());
    }
    if(path.startsWith("/api/"))return new Response("Unexpected protected request",{status:403});
    return new Response('<html><meta charset="utf-8"><body><div id="root"></div><script src="/bundle.js"></script></body></html>',{headers:{"content-type":"text/html"}});
  }});
  const context=await browser.newContext();
  context.setDefaultTimeout(10000);
  try {
    const page=await context.newPage();
    await page.goto(new URL("?authorized=1",server.url).href);
    await page.getByText("Counter: 1",{exact:true}).waitFor();
    expect(await page.getByRole("button",{name:"Ping",exact:true}).isEnabled()).toBe(true);
    serverAccess=false;
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await page.getByRole("alert").filter({hasText:"App access changed"}).waitFor();
    expect(await page.getByRole("button",{name:"Ping",exact:true}).isDisabled()).toBe(true);
    await page.getByRole("button",{name:"Restart",exact:true}).click();
    await page.waitForFunction(()=>{const button=Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Ping");return button && !button.disabled && !document.querySelector('[role="alert"]');});
    expect(starts).toBe(2);
    expect(await page.getByText("Counter: 1",{exact:true}).count()).toBe(1);
    revoked=true;
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await page.getByRole("alert").filter({hasText:"no longer available"}).waitFor();
    expect(await page.getByRole("button",{name:"Ping",exact:true}).isDisabled()).toBe(true);
  } finally {await context.close();server.stop(true);}
},60000);
