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
  const archive = await cloud.zip.create([{name:"bank/report.xml",data:"<Document>bank report</Document>"}], "input.zip");
  const zip = await cloud.zip.open(archive);
  const xml = await zip.text("bank/report.xml");
  const packed = await cloud.zip.create([{name:"report.xml",data:await zip.read("bank/report.xml")}], "reports.zip");
  await cloud.download(packed.name, packed);
  let network="allowed";
  try { await fetch("http://127.0.0.1:1"); } catch {network="blocked";}
  return {answer:42, xml, zipEntries:zip.entries.length, network, env:Object.keys(process.env)};
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
