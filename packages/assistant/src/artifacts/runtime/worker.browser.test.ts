import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { compileArtifact } from "./compile";
import type {} from "./browser-harness";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real opaque worker returns data, reuses list actions and remains terminable", async () => {
  const directory = await mkdtemp(join(tmpdir(),"assistant-worker-test-"));
  const output = join(directory,"harness.js");
  const build = Bun.spawn(["bun","build",new URL("./browser-harness.ts",import.meta.url).pathname,"--target","browser","--format","iife","--outfile",output],{ stdout: "pipe",stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const harness = await Bun.file(output).text();
  await rm(directory,{ recursive: true });
  const compile = (content: string) => compileArtifact({ entry: "main.js", files: [{ path: "main.js",content }] });
  const invalidLayoutSource = await compile('export default () => { ui.workbench({ controls: ui.text("Input"), content: [] }); };');
  const invalidOutputSource = await compile('export default () => ui.text("Output");');
  const headlessSource = await compile("export default () => ({ answer: 42 });");
  const csvSource = await compile(`export default async () => {
    const totals = {};
    for (const input of await files.list()) {
      for (const row of await sheet.fromCsv(await files.read(input.name), {delimiter:","})) {
        totals[row.name] = (totals[row.name] || 0) + Number(row.amount);
      }
    }
    await files.save(sheet.toCsv(Object.entries(totals).map(([name,amount]) => ({name,amount}))), "totals.csv");
    return {people: Object.keys(totals).length, total: Object.values(totals).reduce((a,b)=>a+b,0)};
  };`);
  const listSource = await compile(`export default () => {
    let count=0;
    const list=ui.list({id:"tasks",actions:[{id:"increment",label:"Increment",onClick(item){
      count++; list.set([{id:item.id,title:String(count)}]);
    }}]},[{id:"one",title:"0"}]);
  };`);
  const errorSource = await compile('export default () => { throw new Error("deliberate"); };');
  const recoverySource = await compile(`export default () => {
    let attempts=0;
    const message=ui.text("Waiting");
    ui.button("Retry",()=>{ if(++attempts===1) throw new Error("First attempt failed"); message.set("Recovered"); },{id:"retry"});
  };`);
  const infiniteSource = await compile("export default () => { while(true){} };");
  const sessionSource = await compile(`export default async () => {
    const result = await ui.modal.dialog({title:"Quantity",fields:{count:{type:"number",label:"Count",required:true,min:1}}});
    const before = await store.get("count");
    await store.set("count",result.count);
    const inputs = await files.list();
    const input = await files.read(inputs[0].name);
    await files.save(await input.text(),"copy.csv");
    return {before, count:await store.get("count")};
  };`);
  const agentSource = await compile(`export default () => {
    const tasks=ui.list({id:"tasks"});
    ui.button("Add",async()=>{
      const title=await ui.modal.text({title:"Add task",label:"Task",required:true});
      if(title!==null && await ui.modal.confirm({title:"Confirm task",message:"Add this task?"})) tasks.upsert([{id:ids.ulid(),title}]);
    },{id:"add"});
  };`);
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const server = Bun.serve({ hostname: "127.0.0.1",port: 0,fetch: () => new Response("<!doctype html><body></body>",{ headers: { "Content-Type": "text/html" } }) });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.addScriptTag({ content: harness });
    const headless = await page.evaluate((source) => runArtifactScenario({ source }),headlessSource);
    expect(headless.output).toEqual({ answer: 42 });
    expect(headless.nodes).toHaveLength(0);
    expect(headless.errors).toEqual([]);
    const csv = await page.evaluate(source => runArtifactCsvScenario(source), csvSource);
    expect(csv.state.output).toEqual({people:2,total:25});
    expect(csv.state.nodes).toHaveLength(0);
    expect(csv.content).toContain("Alice;17");
    expect(csv.content).toContain("Bob;8");
    const list = await page.evaluate((source) => runArtifactScenario({ source,
      events: Array.from({ length: 320 },() => ({ id: "tasks",action: "increment",item: "one" })),
    }),listSource);
    expect(list.nodes).toHaveLength(1);
    expect(list.nodes[0]!.items[0]!.title).toBe("320");
    expect(list.errors).toEqual([]);
    const failure = await page.evaluate((source) => runArtifactScenario({ source }),errorSource);
    expect(failure.errors.join(" ")).toContain("deliberate");
    const invalidLayout = await page.evaluate(source => runArtifactScenario({ source }), invalidLayoutSource);
    expect(invalidLayout.errors.join(" ")).toContain("controls and content arrays");
    const invalidOutput = await page.evaluate(source => runArtifactScenario({ source }), invalidOutputSource);
    expect(invalidOutput.errors.join(" ")).toContain("Do not return UI handles");
    const recovery = await page.evaluate((source) => runArtifactRecoveryScenario(source), recoverySource);
    expect(recovery.failed.status).toBe("error");
    expect(recovery.recovered.status).toBe("ready");
    expect(recovery.recovered.error).toBeUndefined();
    expect(recovery.recovered.logs.some((log) => log.text.includes("First attempt failed"))).toBe(true);
    expect(recovery.recovered.nodes.some((node) => node.label === "Recovered")).toBe(true);
    const infinite = await page.evaluate((source) => runArtifactScenario({ source,stopAfterMs: 150 }),infiniteSource);
    expect(infinite.responsive).toBe(true);
    expect(infinite.stopped).toBe(true);
    for (let iteration = 0; iteration < 2; iteration++) {
      const session = await page.evaluate((source) => runArtifactSessionScenario(source), sessionSource);
      expect(session.invalidRejected).toBe(true);
      expect(session.state.output).toEqual({ before: null, count: 3 });
      expect(session.content).toBe("name\nAlice");
      expect(session.state.files[0]?.name).toBe("copy.csv");
    }
    const agent = await page.evaluate((source) => runArtifactAgentScenario(source), agentSource);
    expect(agent[0]).toMatchObject({ runId: "start", status: "ready" });
    expect(agent[1]).toMatchObject({ status: "waiting", modal: { kind: "text", title: "Add task" } });
    expect(agent[2]).toEqual(agent[3]);
    expect(agent[2]).toMatchObject({ status: "waiting", modal: { id: "@modal:2", kind: "confirm" } });
    expect(agent[4]).toMatchObject({ nodes: [{ id: "tasks", totalItems: 1, items: [{ title: "Example" }] }] });
    expect(agent[5]).toEqual({ runId: "start", stopped: true });
    expect(agent[6]).toHaveLength(1);
  } finally { await browser.close(); await server.stop(true); }
},30000);
