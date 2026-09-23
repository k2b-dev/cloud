import { expect, test } from "bun:test";
import { decodePdfRequest } from "../artifacts/pdf-contracts";
import { cliHostBundle } from "../artifacts/runtime/cli-bundle";
import { compileArtifact } from "../artifacts/runtime/compile";
import { createCliCodeHost } from "./code-host";

test("CLI PDF uses binary multipart, cancels an individual request and continues", async () => {
  const bundle = await cliHostBundle();
  let aborted = false;
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("host.js")) return new Response(bundle);
      if (url.pathname.endsWith("/compile")) return Response.json(await compileArtifact(await new Response(init?.body).json()));
      if (url.pathname.endsWith("/runtime/pdf")) {
        expect(url.searchParams.get("conversationId")).toBe("aBc234");
        const request = decodePdfRequest(await new Response(init?.body, { headers: init?.headers }).formData());
        if (request.operation === "render") {
          const signal = init?.signal;
          if (!signal) throw new Error("Missing signal");
          // Like a real fetch, honour an abort that already happened while the body was decoded.
          return new Promise<Response>((_resolve, reject) => {
            const cancel = () => {
              aborted = true;
              reject(new DOMException("Cancelled", "AbortError"));
            };
            if (signal.aborted) cancel();
            else signal.addEventListener("abort", cancel, { once: true });
          });
        }
        if (request.operation !== "attach") throw new Error("Unexpected operation");
        expect(request.document.size).toBe(17 * 1024 * 1024);
        expect(await request.attachments[0]!.data.text()).toBe("<data/>");
        return new Response("%PDF-output", { headers: { "Content-Type": "application/pdf" } });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  try {
    const result = await host.execute({
      name: "code_run",
      callId: "pdf",
      conversationId: "aBc234",
      turnId: "aBc234",
      args: {
        code: `export default async()=>{
      const abort=new AbortController();
      const operation=pdf.render({html:"slow"},{signal:abort.signal});
      setTimeout(()=>abort.abort(),300);
      let cancelled=false;try{await operation;}catch(error){cancelled=error.name==="AbortError";}
      const document=await pdf.attach({document:new Blob([new Uint8Array(17*1024*1024)]),attachments:[{name:"data.xml",data:new Blob(["<data/>"],{type:"application/xml"})}]});
      return {cancelled,type:document.type,content:await document.text()};
    }`,
      },
    });
    expect(result).toMatchObject({
      status: "ready",
      output: JSON.stringify({ cancelled: true, type: "application/pdf", content: "%PDF-output" }),
    });
    expect(aborted).toBe(true);
  } finally {
    await host.close();
  }
}, 60000);
