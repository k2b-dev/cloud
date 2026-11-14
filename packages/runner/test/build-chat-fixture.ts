import { generateCodeSdk } from "@k2b/cloud/code";
import { compileRunnerScript } from "../../assistant/src/chat-code/runtime/runner-compile";

const compiled = await compileRunnerScript(
  {
    entry: "main.ts",
    files: [
      {
        path: "main.ts",
        content: `
import {sheet} from "@sdk";
export default async () => {
  const csv = await sheet.toCsv([{answer:42}], {bom:false});
  await cloud.download("answer.csv", csv);
  let network="allowed";
  try { await fetch("http://127.0.0.1:1"); } catch {network="blocked";}
  return {answer:42, network, env:Object.keys(process.env)};
}`,
      },
    ],
  },
  generateCodeSdk([], { mode: "code_run" }),
);
await Bun.write(
  Bun.argv[2]!,
  JSON.stringify({ kind: "chat", ...compiled, context: { locale: "en-US", timeZone: "UTC", user: null }, files: [] }),
);
