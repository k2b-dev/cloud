import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { runtimeSource } from "./compile";

test("the built eager worker installs only cloud and ui, with trusted viewer and script context", async () => {
  const messages: { type: string; value?: unknown; [key: string]: unknown }[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const context = createContext({
    crypto: { getRandomValues: (bytes: Uint8Array) => crypto.getRandomValues(bytes) },
    postMessage: (message: { type: string; value?: unknown }) => messages.push(message),
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    Blob,
    File,
    Response,
    TextEncoder,
    TextDecoder,
    URL,
  });
  runInContext(await runtimeSource(), context);
  runInContext(
    `__artifactInit({locale:"de-DE",timeZone:"Europe/Berlin",user:{id:"trusted",name:"Viewer"}},[{path:"/input.csv",size:12,type:"text/csv"}]);`,
    context,
  );
  const result = await runInContext(
    `__artifactStart(async (input, {files,signal,progress}) => {
   signal.addEventListener("abort",()=>{globalThis.observedAbort=true;});
   globalThis.lateProgress = progress;
   progress(1,2,"Checking");
   return {input,files:files.map(({path,size,type})=>({path,size,type})),aborted:signal.aborted,
     viewer:cloud.user,locale:cloud.locale,timeZone:cloud.timeZone,uuid:crypto.randomUUID(),
     frozen:Object.isFrozen(cloud)&&Object.isFrozen(cloud.kv.user),writable:Object.getOwnPropertyDescriptor(globalThis,"cloud").writable,
     removed:["ai","money","datev","sepa","camt","einvoice","ids","http","secret","capabilities","database","kv","files","work","pdf","sheet","store","opfs"].filter(name=>name in globalThis)};
 },{answer:42});`,
    context,
  );
  expect(result).toBeUndefined();
  expect(messages.find((message) => message.type === "output")?.value).toMatchObject({
    input: { answer: 42 },
    files: [{ path: "/input.csv", size: 12, type: "text/csv" }],
    viewer: { id: "trusted", name: "Viewer" },
    locale: "de-DE",
    timeZone: "Europe/Berlin",
    aborted: false,
    frozen: true,
    writable: false,
    removed: [],
  });
  expect(messages).toContainEqual({ type: "work", status: "running", completed: 1, total: 2, label: "Checking" });
  expect(messages.at(-1)?.type).toBe("ready");
  expect(listeners.has("unhandledrejection")).toBe(true);
  const output = messages.find((message) => message.type === "output")?.value;
  expect(output).toHaveProperty("uuid", expect.stringMatching(/^[a-f0-9-]{36}$/));

  const count = messages.length;
  expect(() => runInContext("lateProgress(2, 2)", context)).toThrow("Progress is only available while the entry function runs.");
  try {
    runInContext("lateProgress(2, 2)", context);
  } catch (error) {
    expect(error).toMatchObject({ name: "CloudError", code: "invalid" });
  }
  expect(messages).toHaveLength(count);

  // The application retains the exact signal it received, even after completion.
  expect(messages).toContainEqual({ type: "work", status: "completed", completed: 1, total: 2, label: "Checking" });
  listeners.get("message")?.({ data: { type: "stop" } });
  expect(runInContext("observedAbort", context)).toBe(true);
  expect(runInContext("cloud.user.id", context)).toBe("trusted");
}, 30000);

test("built worker imports the finance chunk and exports files through the cloud bridge", async () => {
  const { chunkSource } = await import("./chunks");
  const finance = await chunkSource("finance");
  const messages: { type: string; value?: unknown; method?: string; args?: unknown[] }[] = [];
  let receive: ((event: unknown) => void) | undefined;
  const context = createContext({
    crypto,
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    Blob,
    File,
    Response,
    TextEncoder,
    TextDecoder,
    // VM modules use a data URL; the browser uses a blob URL for these same bytes.
    URL: { createObjectURL: () => `data:text/javascript;base64,${Buffer.from(finance).toString("base64")}`, revokeObjectURL() {} },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      if (name === "message") receive = listener;
    },
    postMessage: (message: { type: string; id?: number; method?: string; args?: unknown[] }) => {
      messages.push(message);
      if (message.type === "rpc")
        queueMicrotask(() =>
          receive?.({ data: { type: "result", id: message.id, value: message.method === "runtime.chunk" ? finance : null } }),
        );
    },
  });
  runInContext(await runtimeSource(), context, { importModuleDynamically: (specifier) => import(specifier) });
  runInContext('__artifactInit({locale:"en-US",timeZone:"UTC",user:{id:"viewer",name:"Viewer"}},[]);', context);
  const reference = await Bun.file(new URL("../../../skills/code-mode/references/finance.md", import.meta.url)).text();
  const example = reference.match(/```js\n([\s\S]*?)```/)?.[1];
  expect(example).toBeDefined();
  await runInContext(example!.trim().replace(/;$/, "").replace("export default", "__artifactStart(") + ");", context);
  expect(messages.filter((message) => message.type === "error")).toEqual([]);
  expect(messages.find((message) => message.type === "output")?.value).toEqual({
    bookings: 2,
    debit: "123.45",
    credit: "3.00",
    transfers: 2,
    total: "12.31",
  });
  expect(messages.filter((message) => message.method === "runtime.chunk")).toHaveLength(1);
  const downloads = messages.filter((message) => message.method === "file.save");
  expect(downloads.map((message) => message.args?.[1])).toEqual(["buchungen.csv", "ueberweisungen.xml"]);
  expect(downloads.every((message) => message.args?.[0] instanceof Blob)).toBe(true);
  expect(messages.at(-1)?.type).toBe("ready");
}, 30000);

test("progress is closed even when the entry fails", async () => {
  const messages: unknown[] = [];
  const context = createContext({
    crypto,
    postMessage: (message: unknown) => messages.push(message),
    addEventListener() {},
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    Blob,
    File,
    Response,
    TextEncoder,
    TextDecoder,
    URL,
  });
  runInContext(await runtimeSource(), context);
  runInContext('__artifactInit({locale:"en-US",timeZone:"UTC",user:null},[]);', context);
  await runInContext('__artifactStart((_input,{progress})=>{globalThis.lateProgress=progress;throw new Error("failed");});', context);
  const count = messages.length;
  expect(() => runInContext("lateProgress(1)", context)).toThrow("only available while the entry function runs");
  expect(messages).toHaveLength(count);
}, 30000);
