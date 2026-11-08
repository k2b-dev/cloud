import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { runtimeSource } from "./compile";

async function worker() {
  const messages: { type: string; status?: string; text?: string }[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  const context = createContext({
    crypto,
    Blob,
    File,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, info() {}, warn() {}, error() {} },
    postMessage: (message: (typeof messages)[number]) => messages.push(message),
    addEventListener: (name: string, listener: typeof receive) => {
      if (name === "message") receive = listener;
    },
  });
  runInContext(await runtimeSource(), context);
  runInContext('__artifactInit({locale:"en-US",timeZone:"UTC",user:null},[]);', context);
  return { context, messages, stop: () => receive({ data: { type: "stop" } }) };
}
test("script failure reports a terminal work state before the error and cannot start twice", async () => {
  const { context, messages } = await worker();
  await runInContext('__artifactStart(async()=>{throw new Error("broken");});', context);
  expect(messages.map((message) => message.type)).toEqual(["work", "error"]);
  expect(messages[0]?.status).toBe("error");
  expect(messages[1]?.text).toContain("broken");
  await runInContext("__artifactStart(()=>42);", context);
  expect(messages).toHaveLength(2);
});
test("script context cancellation is distinct from failure and suppresses output", async () => {
  const { context, messages, stop } = await worker();
  const done = runInContext(
    `__artifactStart(async (_input,{signal,progress})=>{
    progress(2,4,"Importing");
    await new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}));
    return 42;
  });`,
    context,
  );
  stop();
  await done;
  expect(messages.at(-1)).toMatchObject({ type: "work", status: "cancelled", completed: 2, total: 4, label: "Importing" });
  expect(messages.some((message) => message.type === "error" || message.type === "output")).toBe(false);
});
