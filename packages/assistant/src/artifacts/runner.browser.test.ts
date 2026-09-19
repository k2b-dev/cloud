import { afterAll, beforeAll, test, expect } from "bun:test";
import { chromium, type Browser } from "playwright";
import { compileArtifact } from "./runtime/compile";

let browser: Browser;
let code: string;
let appCss: string;
beforeAll(async () => {
  const build=Bun.spawn(["bun",new URL("./workspace-browser-build.ts",import.meta.url).pathname,"./runner-browser-harness.tsx"],{stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,exitCode]=await Promise.all([new Response(build.stdout).text(),new Response(build.stderr).text(),build.exited]);
  if(exitCode)throw new Error(stderr);
  code=stdout;
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud/", import.meta.url).pathname))).default;
  const css = await Bun.build({entrypoints:[new URL("../styles/app.css",import.meta.url).pathname],plugins:[tailwind]});
  if (!css.success) throw new Error(css.logs.join("\n"));
  appCss = await css.outputs[0]!.text();
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


test("standalone runner fades scroll edges and keeps footer controls stable during restart", async () => {
  const compiled = await compileArtifact({entry:"main.js",files:[{path:"main.js",content:`export default () => {
    for (let i=0;i<80;i++) ui.text({value:"Dashboard row " + i});
  }`}]});
  const mutations: string[] = [];
  const metadata={id:"Run001",title:"Long dashboard",sourceRevision:1,publishedVersion:1,serverAccess:true,canManage:true};
  const server=Bun.serve({port:0,fetch(request){
    const path=new URL(request.url).pathname;
    if(path==="/bundle.js")return new Response(code,{headers:{"content-type":"application/javascript"}});
    if(path==="/api/assistant/artifacts/Run001/fork") { mutations.push("fork"); return Response.json({id:"Copy01"}); }
    if(path==="/api/assistant/artifacts/Copy01/edit-chat") { mutations.push(new URL(request.url).search); return Response.json({href:"/copied"}); }
    if(path==="/app.css")return new Response(appCss,{headers:{"content-type":"text/css"}});
    if(path==="/ui.css")return new Response(Bun.file(new URL("../../../ui/dist/styles.css",import.meta.url)));
    if(path==="/api/assistant/runner/Run001")return Response.json(metadata);
    if(path==="/api/assistant/runner/Run001/compiled")return Response.json({...compiled,metadata});
    return new Response('<html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/ui.css"><style>body{margin:0;overflow:hidden}#root{display:flex;height:100dvh;min-height:0}</style><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script></body></html>',{headers:{"content-type":"text/html"}});
  }});
  const context=await browser.newContext();
  try {
    for (const width of [1200,390]) {
      const page=await context.newPage();
      await page.setViewportSize({width,height:700});
      await page.goto(new URL("?authorized=1&manager=1",server.url).href);
      await page.getByText("Dashboard row 79",{exact:true}).waitFor();
      expect(await page.locator('h1').count()).toBe(0);
      expect(await page.locator('.artifact-console__header').getByRole('button',{name:'Manage',exact:true}).count()).toBe(1);
      const manage=page.getByRole("button",{name:"Manage",exact:true});
      const before=await manage.boundingBox();
      const preview=page.locator('.artifact-panel__preview');
      const dimensions=await preview.evaluate(el=>({height:el.clientHeight,scrollHeight:el.scrollHeight,width:el.clientWidth,scrollWidth:el.scrollWidth}));
      expect(dimensions.height).toBeGreaterThan(0);
      expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height);
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
      await page.waitForFunction(()=>document.querySelector('.artifact-panel__preview')?.getAttribute('data-scroll-fade')==='bottom');
      expect(await preview.evaluate(el=>getComputedStyle(el).maskImage)).not.toBe("none");
      await preview.hover();
      await page.mouse.wheel(0,10000);
      await page.waitForFunction(()=>document.querySelector('.artifact-panel__preview')!.scrollTop>0);
      expect(await manage.boundingBox()).toEqual(before);
      await page.waitForFunction(()=>document.querySelector('.artifact-panel__preview')?.getAttribute('data-scroll-fade')==='top');
      await page.route('**/api/assistant/runner/Run001/compiled',async route=>{
        await new Promise(resolve=>setTimeout(resolve,500));
        await route.continue();
      });
      const restart=page.getByRole('button',{name:'Restart',exact:true});
      const previewBefore=await preview.boundingBox();
      await restart.click();
      await page.waitForFunction(()=>document.querySelector('button[aria-busy="true"]'));
      expect(await manage.boundingBox()).toEqual(before);
      expect(await preview.boundingBox()).toEqual(previewBefore);
      expect(await page.getByText('Loading',{exact:true}).count()).toBe(0);
      await page.waitForFunction(()=>!document.querySelector('button[aria-busy="true"]'));
      expect(await manage.boundingBox()).toEqual(before);
      await page.getByRole("button",{name:"Actions",exact:true}).click();
      await page.getByRole("menuitem",{name:"Copy app link",exact:true}).waitFor();
      expect(await page.getByRole("menuitem",{name:"Secrets",exact:true}).count()).toBe(0);
      await page.getByRole("menuitem",{name:"Create your own copy",exact:true}).click();
      await page.getByRole("dialog").waitFor();
      expect(await page.getByRole("dialog").textContent()).toContain("Data, secrets and sharing settings are not copied");
      await page.getByRole("button",{name:"Cancel",exact:true}).click();
      expect(mutations).toEqual([]);
      await page.getByRole("button",{name:"Actions",exact:true}).click();
      await page.getByRole("menuitem",{name:"Create your own copy",exact:true}).click();
      await page.getByRole("dialog").getByRole("button",{name:"Create your own copy",exact:true}).click();
      await page.waitForURL('**/copied');
      expect(mutations).toEqual(["fork","?intent=customize"]);
      mutations.length=0;
      await page.close();
    }
  } finally {await context.close();server.stop(true);}
},60000);
