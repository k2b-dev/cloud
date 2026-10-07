import { expect, jest, test } from "bun:test";
import { ChunkName, chunkSource } from "../artifacts/runtime/chunks";
import { cliHostBundle } from "../artifacts/runtime/cli-bundle";
import { compileArtifact } from "../artifacts/runtime/compile";
import { createCliCodeHost } from "./code-host";

test("published actions execute in the isolated host and validate their returned value", async () => {
  const source = {
    entry: "main.ts",
    files: [
      {
        path: "app.actions.json",
        content: JSON.stringify({
          actions: [
            {
              name: "double",
              title: "Double",
              description: "Double a number",
              entry: "double.ts",
              inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
              outputSchema: { type: "number" },
            },
          ],
        }),
      },
      { path: "double.ts", content: "export default ({ value }: { value: number }) => value * 2;" },
    ],
  };
  const compiled = await compileArtifact(source, { action: "double", input: { value: 3 } });
  const bundle = await cliHostBundle();
  let outputSchema = { type: "number" };
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const path = String(input);
      const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
      if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.includes("runtime/action")) {
        const body = JSON.parse(await new Response(init?.body).text());
        if (typeof body.input.value === "string")
          return Response.json({ code: "ACTION_INPUT_INVALID", message: "value: expected number, received string" }, { status: 400 });
        expect(body).toEqual({
          id: "aBc234",
          action: "double",
          publishedVersion: 1,
          input: { value: 3 },
        });
        return Response.json({ compiled, outputSchema, resource: { id: "aBc234", kind: "app", sourceRevision: 1 } });
      }
      throw new Error(`Unexpected action host request: ${path}`);
    },
  });
  const call = {
    name: "code_action",
    conversationId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    args: { id: "aBc234", action: "double", publishedVersion: 1, input: { value: 3 } },
  };
  try {
    expect(await host.execute({ ...call, callId: "action" })).toMatchObject({ status: "ready", output: "6" });
    expect(await host.execute({ ...call, callId: "invalid-input", args: { ...call.args, input: { value: "3" } } })).toEqual({
      failed: true,
      error: "ACTION_INPUT_INVALID: value: expected number, received string",
    });
    outputSchema = { type: "string" };
    expect(await host.execute({ ...call, callId: "invalid-output" })).toMatchObject({
      runId: "invalid-output",
      status: "error",
      error: expect.stringContaining("schema"),
    });
  } finally {
    await host.close();
  }
}, 60000);

test("CLI runs one-off code in the existing isolated worker without a GUI chat", async () => {
  const code =
    'export default async (_input, {files,signal,progress}) => { await cloud.download("answer.txt", "42"); return { answer: 42, serverProcess: typeof process, networkBlocked: await fetch("https://example.invalid/").then(() => false, () => true) }; }';
  const bundle = await cliHostBundle();
  const compiled = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
  const requests: string[] = [];
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const path = String(input);
      const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
      if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
      requests.push(path);
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.endsWith("/claim")) return Response.json({ status: "execute" });
      if (path.endsWith("/complete")) return Response.json({ saved: true });
      if (path.endsWith("/compile")) return Response.json(compiled);
      if (path.includes("/files") && init?.method === "POST") {
        const form = await new Response(init.body, {
          headers: { "content-type": new Headers(init.headers).get("content-type")! },
        }).formData();
        expect(form.get("directory")).toBe("/files");
        return Response.json({ file: { path: "/files/answer-2.txt", version: 1 } });
      }
      if (path.includes("/files")) return Response.json({ files: [] });
      if (path.includes("/artifacts/")) return Response.json({ id: "aBc234", kind: "app", revision: 1 });
      throw new Error(`Unexpected host request ${path}`);
    },
  });
  const ids = { conversationId: "00000000-0000-4000-8000-000000000001", turnId: "00000000-0000-4000-8000-000000000001" };
  try {
    const result = await host.call({ ...ids, name: "code_run", callId: "one-off", args: { code } });
    expect(result).toMatchObject({
      status: "ready",
      output: JSON.stringify({ answer: 42, serverProcess: "undefined", networkBlocked: true }),
    });
    expect(requests.some((path) => path.endsWith("/compile"))).toBe(true);
    const claims = requests.filter((path) => path.endsWith("/claim")).length;
    const standalone = await host.execute({ ...ids, name: "code_run", callId: "standalone", args: { code } });
    expect(standalone).toMatchObject({
      status: "ready",
      output: JSON.stringify({ answer: 42, serverProcess: "undefined", networkBlocked: true }),
    });
    expect(requests.filter((path) => path.endsWith("/claim"))).toHaveLength(claims);
    const inspected = await host.execute({ ...ids, name: "code_inspect", callId: "inspect", args: { runId: "standalone" } });
    expect(inspected).toMatchObject({ runId: "standalone", status: "ready" });
    const exported = await host.execute({
      ...ids,
      name: "code_export",
      callId: "export",
      args: { runId: "standalone", name: "answer.txt" },
    });
    expect(exported).toMatchObject({ path: "/files/answer-2.txt", size: 2 });
    const rejected = await host.call({
      ...ids,
      name: "code_run",
      callId: "app-files",
      args: { id: "aBc234", inputPaths: ["private.csv"] },
    });
    expect(rejected).toMatchObject({ error: "Input not found: private.csv" });
  } finally {
    await host.close();
  }
}, 60000);

test("closing the CLI host cancels its in-flight server request", async () => {
  const bundle = await cliHostBundle();
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      if (String(input).endsWith("host.js")) return new Response(bundle);
      if (!String(input).endsWith("/compile")) throw new Error(`Unexpected request ${input}`);
      const signal = init?.signal;
      if (!signal) throw new Error("Missing cancellation signal");
      started();
      return new Promise<Response>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Host closed", "AbortError"));
          },
          { once: true },
        ),
      );
    },
  });
  try {
    const pending = host
      .execute({
        name: "code_run",
        callId: "cancel",
        conversationId: "00000000-0000-4000-8000-000000000001",
        turnId: crypto.randomUUID(),
        args: { code: "export default () => 42" },
      })
      .catch(() => null);
    await requestStarted;
    await host.close();
    await pending;
    expect(aborted).toBe(true);
  } finally {
    await host.close();
  }
}, 60000);

test("a stalled startup fails at the deadline and names the step it stopped at", async () => {
  let requested!: () => void;
  const runtimeRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  jest.useFakeTimers();
  try {
    // The real child launches Chromium and opens the host page; then the
    // runtime download never answers, so only the deadline can end startup.
    const host = createCliCodeHost({
      fetch: async (input, init) => {
        if (!String(input).endsWith("host.js")) throw new Error(`Unexpected request ${input}`);
        requested();
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Host closed", "AbortError")), { once: true }),
        );
      },
    });
    // A startup failure before the runtime request rejects here instead of hanging.
    await Promise.race([runtimeRequested, host]);
    // The child sent this step over IPC before it requested the runtime. One
    // more event loop turn lets this process read it if both arrived together.
    await new Promise<void>((resolve) => setImmediate(resolve));
    jest.advanceTimersByTime(45_000);
    await expect(host).rejects.toThrow("Code host startup exceeded 45 seconds while loading the host runtime; no operation was executed");
  } finally {
    jest.useRealTimers();
  }
}, 60000);

test("CLI worker chains capabilities through host approvals and keeps denial out of worker control", async () => {
  const code = `export default async (_input, {files,signal,progress}) => {
    const first=await cloud.capabilities.run("demo.read",{});
    const [second]=await Promise.all([cloud.capabilities.run("demo.write",{value:first.data.value}),cloud.capabilities.run("demo.read",{})]);
    let denied=false;
    try {await cloud.capabilities.run("demo.denied",{});} catch {denied=true;}
    return {value:second.data.value,denied};
  }`;
  const compiled = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
  const bundle = await cliHostBundle(),
    pending = new Map<string, string>(),
    decisions: string[] = [];
  const host = await createCliCodeHost(
    {
      fetch: async (input, init) => {
        const path = String(input);
        const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
        if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
        if (path.endsWith("host.js")) return new Response(bundle);
        if (path.endsWith("/claim")) return Response.json({ status: "execute" });
        if (path.endsWith("/complete")) return Response.json({ saved: true });
        if (path.endsWith("/compile")) return Response.json(compiled);
        if (path.endsWith("/capabilities")) {
          const body = await new Response(init?.body).json();
          if (body.name === "demo.read") return Response.json({ status: "completed", result: { ok: true, data: { data: { value: 7 } } } });
          pending.set(body.id, body.name);
          return Response.json({
            status: "approval",
            id: body.id,
            name: body.name,
            input: body.input,
            appId: "demo",
            localId: body.name.split(".")[1],
            kind: "action",
            schemaHash: "hash",
            title: "Write",
            review: null,
            allowAlways: false,
            scope: null,
          });
        }
        if (path.endsWith("/resolve")) {
          const decision = await new Response(init?.body).json();
          return Response.json(
            decision.approved ? { status: "completed", result: { ok: true, data: { data: { value: 14 } } } } : { status: "denied" },
          );
        }
        throw new Error(`Unexpected request ${path}`);
      },
    },
    async (request) => {
      decisions.push(request.name);
      // A human may take longer than the normal 45-second operation watchdog.
      if (request.name === "demo.write") await Bun.sleep(46000);
      return { approved: request.name !== "demo.denied" };
    },
  );
  try {
    const result = await host.call({
      name: "code_run",
      callId: "chain",
      conversationId: "00000000-0000-4000-8000-000000000001",
      turnId: "00000000-0000-4000-8000-000000000001",
      args: { code },
    });
    expect(result).toMatchObject({ status: "ready", output: JSON.stringify({ value: 14, denied: true }) });
    expect(decisions).toEqual(["demo.write", "demo.denied"]);
    expect(pending.size).toBe(2);
  } finally {
    await host.close();
  }
}, 90000);

test("chat inputs load on demand for one-off and saved scripts, and only selected inputs are readable", async () => {
  const scriptSource = await compileArtifact({
    entry: "main.ts",
    files: [{ path: "main.ts", content: "export default async (_input, {files}) => ({ name: files[0].path, text: await (await files[0].file()).text() })" }],
  });
  const bundle = await cliHostBundle();
  let reads = 0;
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const path = String(input);
      const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
      if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.endsWith("/compile")) return Response.json(await compileArtifact(await new Response(init?.body).json()));
      if (path.includes("/files/content?")) {
        reads++;
        return new Response("hello", { headers: { "content-type": "text/plain" } });
      }
      if (path.endsWith("/files")) return Response.json({ files: [{ path: "/folder/report.csv", size: 5, mediaType: "text/plain" }] });
      if (path.includes("/compiled")) return Response.json({ ...scriptSource, revision: 1 });
      if (path.includes("/artifacts/")) return Response.json({ id: "aBc234", kind: "app", revision: 1, sourceRevision: 1 });
      throw new Error(`Unexpected request ${path}`);
    },
  });
  const ids = { conversationId: "00000000-0000-4000-8000-000000000001", turnId: "00000000-0000-4000-8000-000000000001" };
  try {
    const listed = await host.execute({
      ...ids,
      name: "code_run",
      callId: "list-only",
      args: {
        code: "export default async (_input, {files,signal,progress}) =>({count:(files).length})",
        inputPaths: ["/folder/report.csv"],
      },
    });
    expect(listed).toMatchObject({ output: '{"count":1}' });
    expect(reads).toBe(0);
    const saved = await host.execute({
      ...ids,
      name: "code_run",
      callId: "saved",
      args: { id: "aBc234", inputPaths: ["/folder/report.csv"] },
    });
    expect(saved).toMatchObject({ status: "ready", output: JSON.stringify({ name: "/folder/report.csv", text: "hello" }) });
    expect(reads).toBe(1);
    const denied = await host.execute({
      ...ids,
      name: "code_run",
      callId: "unselected",
      args: {
        code: 'export default async (_input, {files,signal,progress}) =>await files.find(file=>file.path === "/not-selected.csv").file()',
        inputPaths: ["/folder/report.csv"],
      },
    });
    expect(denied).toMatchObject({ status: "error" });
    expect(reads).toBe(1);
  } finally {
    await host.close();
  }
}, 30000);

test("database error codes survive HTTP and the worker bridge", async () => {
  const id = "aBc234";
  const code =
    'export default async (_input, {files,signal,progress}) =>{try{await cloud.db.list("records",{}, {limit:1});return "unexpected success";}catch(error){return {code:error.code,message:error.message};}}';
  const source = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
  const bundle = await cliHostBundle();
  const host = await createCliCodeHost({
    fetch: async (input) => {
      const path = String(input);
      const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
      if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.endsWith("/files")) return Response.json({ files: [] });
      if (path.includes("/database")) return Response.json({ code: "DB_NOT_CONFIGURED", message: "Configure rsql first" }, { status: 503 });
      if (path.includes("/compiled")) return Response.json({ ...source, revision: 1 });
      if (path.includes("/artifacts/")) return Response.json({ id, kind: "script", revision: 1, sourceRevision: 1 });
      throw new Error(`Unexpected request ${path}`);
    },
  });
  try {
    const result = await host.execute({ name: "code_run", callId: "db-error", conversationId: id, turnId: id, args: { id } });
    expect(result).toMatchObject({
      status: "ready",
      output: JSON.stringify({ code: "unavailable", message: "Configure rsql first" }),
    });
  } finally {
    await host.close();
  }
}, 30000);

test("slow chat input crosses startup deadlines and invalid arguments remain input errors", async () => {
  const bundle = await cliHostBundle();
  let reads = 0;
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const path = String(input);
      const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
      if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.endsWith("/compile")) return Response.json(await compileArtifact(await new Response(init?.body).json()));
      if (path.endsWith("/files")) return Response.json({ files: [{ path: "/slow.csv", size: 4, mediaType: "text/csv" }] });
      if (path.includes("/files/content?")) {
        reads++;
        await Bun.sleep(22000);
        return new Response("x\n1\n");
      }
      throw new Error(`Unexpected request ${path}`);
    },
  });
  const ids = { conversationId: "00000000-0000-4000-8000-000000000001", turnId: "00000000-0000-4000-8000-000000000001" };
  try {
    const invalid = await host.execute({
      ...ids,
      name: "code_run",
      callId: "invalid",
      args: { code: "export default()=>42", id: ids.conversationId },
    });
    expect(invalid).toMatchObject({ failed: true, guidance: expect.stringContaining("schema") });
    expect(reads).toBe(0);
    const result = await host.execute({
      ...ids,
      name: "code_run",
      callId: "slow",
      args: {
        code: 'export default async (_input, {files,signal,progress}) =>({rows:(await cloud.sheet.parseCsv(await files[0].file(),{delimiter:","})).length})',
        inputPaths: ["/slow.csv"],
      },
    });
    expect(result).toMatchObject({ status: "ready", output: '{"rows":1}', outputTruncated: false });
    expect(reads).toBe(1);
  } finally {
    await host.close();
  }
}, 35000);

test("scratchpad pressure preserves exports and running work while reclaiming old results", async () => {
  const bundle = await cliHostBundle();
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const path = String(input);
      const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
      if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.endsWith("/compile")) return Response.json(await compileArtifact(await new Response(init?.body).json()));
      throw new Error(`Unexpected request ${path}`);
    },
  });
  const ids = { conversationId: "00000000-0000-4000-8000-000000000001", turnId: "00000000-0000-4000-8000-000000000001" };
  const run = (callId: string, code: string) => host.execute({ ...ids, name: "code_run", callId, args: { code } });
  try {
    await run(
      "retained",
      'export default async (_input, {files,signal,progress}) =>{await cloud.download("result.csv", "important");return 1;}',
    );
    await run(
      "retained-work",
      "export default async (_input,{signal,progress})=>{for(let i=0;!signal.aborted;i++){progress(i);await new Promise(r=>setTimeout(r,1000));}}",
    );
    for (let i = 0; i < 32; i++) expect(await run(`probe-${i}`, `export default()=>${i}`)).toMatchObject({ status: "ready" });
    expect(await host.execute({ ...ids, name: "code_inspect", callId: "files", args: { runId: "retained" } })).toMatchObject({
      files: [{ name: "result.csv" }],
    });
    expect(await host.execute({ ...ids, name: "code_inspect", callId: "work", args: { runId: "retained-work" } })).toMatchObject({
      work: { status: "running" },
    });
    expect(await host.execute({ ...ids, name: "code_inspect", callId: "old", args: { runId: "probe-0" } })).toMatchObject({ failed: true });
    expect(await run("truncated", 'export default()=>"x".repeat(20000)')).toMatchObject({ outputTruncated: true });
  } finally {
    await host.close();
  }
}, 60000);

test("slow database and shared storage calls do not consume the start deadline", async () => {
  const id = "aBc234";
  const code =
    'export default async () => { await cloud.db.list("records", {}, { limit: 1 }); await cloud.kv.set("done", true); return "Finished"; }';
  const compiled = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
  const bundle = await cliHostBundle();
  const host = await createCliCodeHost({
    fetch: async (input) => {
      const path = String(input);
      const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
      if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.includes("/compiled")) return Response.json({ ...compiled, revision: 1 });
      if (path.includes("/database")) {
        await Bun.sleep(17000);
        return Response.json([]);
      }
      if (path.includes("/storage")) {
        await Bun.sleep(17000);
        return Response.json({ written: true });
      }
      if (path.includes("/artifacts/")) return Response.json({ id, kind: "app", revision: 1, sourceRevision: 1 });
      throw new Error(`Unexpected request ${path}`);
    },
  });
  try {
    const ids = { conversationId: id, turnId: id };
    // 34 seconds of host waits: longer than the 15-second start watchdog and the 20-second start wait, shorter than the call budget.
    expect(await host.execute({ ...ids, name: "code_run", callId: "slow-io", args: { id } })).toMatchObject({
      status: "ready",
      output: '"Finished"',
    });
  } finally {
    await host.close();
  }
}, 45000);

// Each sequential replacement gets its own lifecycle budget. Keep all cycles in
// one test process so finalizers from older hosts run against the replacement.
test.each([0, 1, 2])(
  "replacing CLI hosts survives garbage collection without losing the new browser (cycle %i)",
  async (cycle) => {
    const bundle = await cliHostBundle();
    const code = "export default () => 42";
    const compiled = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
    const host = await createCliCodeHost({
      fetch: async (input) => {
        if (String(input).endsWith("host.js")) return new Response(bundle);
        if (String(input).endsWith("/compile")) return Response.json(compiled);
        throw new Error(`Unexpected host request ${input}`);
      },
    });
    try {
      for (let probe = 0; probe < 8; probe++) {
        // The old shared-process launcher loses its new Chromium pipe when
        // finalizers from a previously closed browser run here.
        Bun.gc(true);
        expect(
          await host.execute({
            name: "code_run",
            callId: `gc-${cycle}-${probe}`,
            conversationId: crypto.randomUUID(),
            turnId: crypto.randomUUID(),
            args: { code },
          }),
        ).toMatchObject({ status: "ready", output: "42" });
      }
    } finally {
      await host.close();
    }
    await host.close();
  },
  30000,
);

test("finance exports and resource-scoped one-offs use the existing worker and management routes", async () => {
  const id = "aBc234";
  const bundle = await cliHostBundle();
  const document = await Bun.file(new URL("../../skills/code-mode/references/finance.md", import.meta.url)).text();
  const example = document.match(/```js\n([\s\S]*?)```/)![1]!;
  const code = example.replace(
    "return { bookings:",
    `const records = await cloud.db.list("records",{}, {limit:1});
    await cloud.kv.set("probe", {ok:true});
    return { records, invalid: (await cloud.finance.datev.validate({})).ok, personal: await cloud.kv.user.get("probe"), bookings:`,
  );
  const requests: string[] = [];
  let denied = false;
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const path = String(input);
      const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
      if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
      requests.push(path);
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.endsWith("/access"))
        return denied ? Response.json({ code: "ACCESS_DENIED", message: "Manage required" }, { status: 403 }) : Response.json([]);
      if (path.endsWith("/compile")) {
        const compiled = await compileArtifact(await new Response(init?.body).json());
        expect(compiled.runtime).not.toContain("libxml2");
        return Response.json(compiled);
      }
      if (new URL(path, "http://localhost").pathname === `/api/assistant/artifacts/${id}/database`) {
        expect(new URL(path, "http://localhost").searchParams.get("conversationId")).toBe(id);
        expect(await new Response(init?.body).json()).toEqual({ operation: "list", table: "records", where: {}, limit: 1 });
        return Response.json([]);
      }
      if (path.endsWith("/storage/manage")) {
        const request = await new Response(init?.body).json();
        expect(request).toMatchObject({ area: "kv", key: "probe" });
        expect(request.scope).toBe(request.operation === "write" ? "shared" : "user");
        return Response.json({ item: null });
      }
      throw new Error(`Unexpected request ${path}`);
    },
  });
  try {
    const args = { code, resourceId: id };
    const result = await host.execute({ name: "code_run", callId: "finance", conversationId: id, turnId: id, args });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ready" });
    if (!result || typeof result !== "object" || !("output" in result)) throw new Error("Missing output");
    expect(JSON.parse(String(result.output))).toMatchObject({
      records: [],
      bookings: 2,
      transfers: 2,
      total: "12.31",
      debit: "123.45",
      credit: "3.00",
      invalid: false,
      personal: null,
    });
    expect(JSON.stringify(result)).toContain("buchungen.csv");
    expect(JSON.stringify(result)).toContain("ueberweisungen.xml");
    expect(requests.some((path) => path.endsWith("/storage/manage"))).toBe(true);
    denied = true;
    const rejected = await host.execute({ name: "code_run", callId: "denied-context", conversationId: id, turnId: id, args });
    expect(rejected).toEqual({ failed: true, error: "ACCESS_DENIED: Manage required" });
  } finally {
    await host.close();
  }
}, 30000);

test("HTTP crosses the real CLI worker bridge as secret references and waits for trusted consent", async () => {
  const code =
    'export default async (_input, {files,signal,progress}) =>{const response=await cloud.http.fetch("https://api.example.com/data",{headers:{Authorization:cloud.http.secret("crm",{prefix:"Bearer "})}});return {status:response.status,data:await response.json()};}';
  const bundle = await cliHostBundle(),
    compiled = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
  let sent = 0,
    approved = 0;
  const host = await createCliCodeHost(
    {
      fetch: async (input, init) => {
        const path = String(input);
        const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
        if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
        if (path.endsWith("host.js")) return new Response(bundle);
        if (path.endsWith("/compile")) return Response.json(compiled);
        const body = await new Response(init?.body).json();
        if (path.endsWith("/runtime/http")) {
          expect(body.request.headers.authorization).toEqual({ secret: "crm", prefix: "Bearer " });
          return Response.json({
            id: body.id,
            url: body.request.url,
            method: "GET",
            headers: body.request.headers,
            bodyBytes: 0,
            bodyPreview: "",
            bodyTruncated: false,
          });
        }
        if (path.includes("/runtime/http/")) {
          expect(approved).toBe(1);
          expect(body.approved).toBe(true);
          sent++;
          return Response.json({ status: 200, headers: { "content-type": "application/json" }, body: btoa('{"count":7}') });
        }
        throw new Error(`Unexpected path ${path}`);
      },
    },
    async (request) => {
      expect("type" in request && request.type).toBe("http");
      expect(request.name).toBe("http.fetch:https://api.example.com");
      approved++;
      return { approved: true };
    },
  );
  try {
    const result = await host.execute({
      name: "code_run",
      callId: "http-test",
      conversationId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      args: { code },
    });
    expect(result).toMatchObject({ status: "ready", output: JSON.stringify({ status: 200, data: { count: 7 } }) });
    expect(sent).toBe(1);
  } finally {
    await host.close();
  }
}, 60000);

test("code_present saves one-off HTML apps only after their static checks pass", async () => {
  const bundle = await cliHostBundle();
  const posted: unknown[] = [];
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const path = String(input);
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.endsWith("/presentations")) {
        posted.push(JSON.parse(await new Response(init?.body).text()));
        return Response.json({ presentationId: "00000000-0000-4000-8000-000000000009", title: "Overview" });
      }
      if (path.includes("/artifacts/aBc234"))
        return Response.json({ id: "aBc234", title: "Ledger", source: { entry: "main.ts", files: [{ path: "main.ts", content: "" }] } });
      throw new Error(`Unexpected request ${path}`);
    },
  });
  const ids = { conversationId: "00000000-0000-4000-8000-000000000001", turnId: "00000000-0000-4000-8000-000000000001" };
  const present = (callId: string, args: unknown) => host.execute({ ...ids, name: "code_present", callId, args });
  try {
    const rejected = (await present("broken", {
      title: "Broken",
      files: [
        { path: "index.html", content: '<h1>Hi</h1><img src="https://example.com/x.png">' },
        { path: "app.js", content: 'import _ from "lodash";\nlocalStorage.setItem("a", "b");' },
      ],
    })) as { failed: boolean; error: string };
    expect(rejected.failed).toBe(true);
    for (const problem of ["example.com/x.png", '"lodash"', "localStorage"]) expect(rejected.error).toContain(problem);
    expect(await present("no-interface", { id: "aBc234" })).toMatchObject({ failed: true, error: expect.stringContaining("no index.html") });
    expect(posted).toEqual([]);
    expect(
      await present("ok", {
        title: "Overview",
        files: [
          { path: "index.html", content: "<main><h1>Overview</h1><button>One</button><button>Two</button></main>" },
          { path: "style.css", content: "@media (prefers-color-scheme: dark) { h1 { color: white } }" },
        ],
      }),
    ).toMatchObject({ userVisible: true, title: "Overview", warnings: [expect.objectContaining({ kind: "theme" })] });
    expect(posted).toHaveLength(1);
  } finally {
    await host.close();
  }
}, 30000);

test("shared files cross the CLI/browser host as binary above the JSON budget", async () => {
  const bundle = await cliHostBundle();
  let stored = new Uint8Array();
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("host.js")) return new Response(bundle);
      if (url.pathname.endsWith("/access")) return Response.json([]);
      if (url.pathname.endsWith("/compile")) return Response.json(await compileArtifact(await new Response(init?.body).json()));
      if (url.pathname.endsWith("/storage/file")) {
        expect(url.searchParams.get("management")).toBe("true");
        if (init?.method === "PUT") {
          stored = new Uint8Array(await new Response(init.body).arrayBuffer());
          return Response.json({ written: true });
        }
        return new Response(stored, { headers: { "content-type": "application/octet-stream" } });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  try {
    const result = await host.execute({
      name: "code_run",
      callId: "binary",
      conversationId: "aBc234",
      turnId: "aBc234",
      args: {
        resourceId: "aBc234",
        code: `export default async (_input, {files,signal,progress}) =>{
      const bytes=new Uint8Array(16*1024*1024);bytes[0]=255;
      await cloud.files.write("binary",new Blob([bytes]));
      const file=await cloud.files.read("binary");
      return {size:file.size,first:new Uint8Array(await file.arrayBuffer())[0]};
    }`,
      },
    });
    expect(result).toMatchObject({ status: "ready" });
    expect(stored.length).toBe(16 * 1024 * 1024);
    expect(JSON.stringify(result)).toContain("16777216");
    expect(JSON.stringify(result)).toContain("255");
  } finally {
    await host.close();
  }
}, 30000);

test("native host transport reads and writes a 50 MiB binary file without IPC body copies", async () => {
  const code = `export default async (_input, {files,signal,progress}) => {
    const source = await cloud.capabilities.run("demo.read", {});
    const file = await cloud.capabilities.streams.read(source.stream);
    const target = await cloud.capabilities.run("demo.write", {});
    const result = await cloud.capabilities.streams.write(target.stream, file);
    return { size: file.size, saved: result.data.bytes };
  }`;
  const compiled = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
  const bundle = await cliHostBundle();
  const size = 50 * 1024 * 1024;
  let uploaded = 0;
  const host = await createCliCodeHost({
    fetch: async (input, init) => {
      const path = String(input);
      const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
      if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
      if (path.endsWith("host.js")) return new Response(bundle);
      if (path.endsWith("/compile")) return Response.json(compiled);
      if (path.endsWith("/capabilities")) {
        const request = await new Response(init?.body).json();
        return Response.json({
          status: "completed",
          result: {
            ok: true,
            data: {
              data: {},
              stream: {
                id: request.id,
                direction: request.name === "demo.read" ? "read" : "write",
                size,
                mediaType: "application/octet-stream",
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              },
            },
          },
        });
      }
      if (path.endsWith("/stream/read")) {
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent === size) return controller.close();
              const chunk = new Uint8Array(64 * 1024).fill(173);
              sent += chunk.length;
              controller.enqueue(chunk);
            },
          }),
        );
      }
      if (path.endsWith("/stream/write")) {
        if (!(init?.body instanceof ReadableStream)) throw new Error("Expected streaming request body");
        for await (const chunk of init.body) {
          if (!(chunk instanceof Uint8Array) || chunk.some((byte) => byte !== 173)) throw new Error("Binary data corrupted");
          uploaded += chunk.length;
        }
        return Response.json({ data: { bytes: uploaded } });
      }
      throw new Error(`Unexpected request ${path}`);
    },
  });
  try {
    expect(
      await host.execute({
        name: "code_run",
        callId: "large-stream",
        conversationId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        args: { code },
      }),
    ).toMatchObject({ status: "ready", output: JSON.stringify({ size, saved: size }) });
    expect(uploaded).toBe(size);
  } finally {
    await host.close();
  }
}, 60000);

test("code hosts run without a tab and keep their globals isolated", async () => {
  const bundle = await cliHostBundle();
  const fetchHost = async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const chunk = ChunkName.safeParse(path.split("/chunks/")[1]);
    if (chunk.success) return new Response(await chunkSource(chunk.data), { headers: { "Content-Type": "text/javascript" } });
    if (path.endsWith("host.js")) return new Response(bundle);
    if (path.endsWith("/compile")) return Response.json(await compileArtifact(JSON.parse(await new Response(init?.body).text())));
    if (path.includes("/files")) return Response.json({ files: [] });
    throw new Error(`Unexpected unattended request ${path}`);
  };
  const first = await createCliCodeHost({ fetch: fetchHost });
  let second: Awaited<ReturnType<typeof createCliCodeHost>> | undefined;
  const ids = { conversationId: crypto.randomUUID(), turnId: crypto.randomUUID() };
  try {
    second = await createCliCodeHost({ fetch: fetchHost });
    const call = {
      ...ids,
      name: "code_run",
      callId: "isolated",
      args: { code: "export default () => { globalThis.marker = 123; return 42; }" },
    };
    expect(await first.execute(call)).toMatchObject({ status: "ready", output: "42" });
    expect(
      await second.execute({ ...call, turnId: crypto.randomUUID(), args: { code: "export default () => typeof globalThis.marker;" } }),
    ).toMatchObject({ status: "ready", output: '"undefined"' });
    // Scripts have no UI tree; interfaces are HTML apps.
    expect(await first.execute({ ...call, callId: "ui", args: { code: "export default () => typeof ui;" } })).toMatchObject({
      status: "ready",
      output: '"undefined"',
    });
  } finally {
    await first.close();
    await second?.close();
  }
}, 60000);
