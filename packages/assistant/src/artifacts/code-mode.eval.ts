import { createCloudAiCodeTools } from "@k2b/cloud/ai/tools";
import { defineTool, nessi, type Provider, type StoreEntry } from "@k2b/nessi";
import { z } from "zod";
import { CODE_SOURCE_TOOLS, createAiConversationArtifact, listAiConversationFiles, readAiConversationFile } from "@k2b/cloud/ai";
import { artifactCodeHandlers, type CodeToolContext } from "./code-tools";
import { agentHost } from "./agent-host";
import { artifacts } from "./service";

/** Opt-in real-model acceptance test, executed only by the disposable integration runner. */
export async function evaluateCodeMode(context: CodeToolContext, turnId: string) {
  const endpoint = process.env.ASSISTANT_EVAL_URL;
  if (!endpoint || !context.conversationId) throw new Error("Disposable evaluation context required");
  const inputDirectory = process.env.ASSISTANT_EVAL_FILES;
  if (!inputDirectory) throw new Error("ASSISTANT_EVAL_FILES must name the three-CSV fixture directory");
  for (const name of ["umsaetze.csv", "produkte.csv", "ziele.csv"]) {
    const file = Bun.file(`${inputDirectory}/${name}`);
    await createAiConversationArtifact({
      conversationId: context.conversationId,
      ownerUserId: context.actor.kind === "user" ? context.actor.user.id : "",
      path: `/${name}`,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mediaType: "text/csv",
      producerCallKey: `eval:${name}`,
    });
  }
  const originalIds = new Set((await artifacts.list(context, 1, "app")).items.map((item) => item.id));
  let apps: Awaited<ReturnType<typeof artifacts.get>>[] = [];
  const history: StoreEntry[] = [];
  const events: unknown[] = [];
  const started = Date.now();
  const provider: Provider = {
    name: "configured-eval",
    family: "openai-compatible",
    model: process.env.ASSISTANT_EVAL_MODEL ?? "configured",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
    async complete(input) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.ASSISTANT_EVAL_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ...input, signal: undefined }),
        signal: input.signal,
      });
      if (!response.ok) throw new Error(`Evaluation provider failed: ${response.status}`);
      return response.json();
    },
    async *stream(input) {
      const result = await this.complete(input);
      for (const [index, block] of result.message.content.entries()) {
        const blockId = `block-${index}`;
        if (block.type === "tool_call") {
          yield { type: "block_start", blockId, index, kind: "tool_call", callId: block.id, name: block.name };
          yield { type: "block_end", blockId, index, block };
        } else if (block.type === "text") {
          yield { type: "block_start", blockId, index, kind: "text" };
          yield { type: "block_delta", blockId, delta: block.text };
          yield { type: "block_end", blockId, index, block };
        }
      }
      yield { type: "usage", usage: result.usage ?? { input: 0, output: 0, total: 0 }, finishReason: result.finishReason };
    },
  };
  const runtime = async (name: "code_run" | "code_inspect" | "code_interact" | "code_export", args: unknown, callId?: string) => {
    if (!callId) throw new Error("Missing tool call ID");
    for (;;) {
      context.signal.throwIfAborted();
      const state = await agentHost.call({ turnId, callId, name, args }, context);
      if (state.approvals.length) throw new Error("This offline CSV task must not need external approval");
      if (state.status === "done") return state.result;
      if (state.status === "lost") throw new Error("Evaluation host lost; no replay");
      await Bun.sleep(100);
    }
  };
  const runtimeTools = createCloudAiCodeTools();
  const getCodeToolInputSchema = (name: string) => {
    const tool = runtimeTools.find((tool) => tool.def.name === name);
    if (!tool) throw new Error("Missing runtime tool");
    return tool.def.inputSchema;
  };
  const tools = [
    defineTool({
      name: "load_skill",
      description: "Read assistant-code-mode or assistant-data-analysis workflow",
      inputSchema: z.object({ name: z.enum(["assistant-code-mode", "assistant-data-analysis"]) }),
    }).server(async ({ name }) =>
      Bun.file(new URL(`../../skills/${name === "assistant-code-mode" ? "code-mode" : "data-analysis"}/SKILL.md`, import.meta.url)).text(),
    ),
    defineTool({
      name: "read_file",
      description: "Read exact chat file path, or /skills/assistant-code-mode/references/<name>.md",
      inputSchema: z.object({ path: z.string() }),
    }).server(async ({ path }) => {
      if (/^\/skills\/assistant-code-mode\/references\/[a-z-]+\.md$/.test(path))
        return Bun.file(new URL(`../../skills/code-mode/references/${path.split("/").at(-1)}`, import.meta.url)).text();
      const stat = (await listAiConversationFiles(context.conversationId!)).find((file) => file.path === path);
      if (!stat) throw new Error("File not found. Use exact manifest paths; do not invent /input.");
      const file = await readAiConversationFile({
        conversationId: context.conversationId!,
        ownerUserId: context.actor.kind === "user" ? context.actor.user.id : "",
        path,
        version: stat.version,
      });
      return new TextDecoder().decode(file?.bytes);
    }),
    defineTool({
      name: "code_create",
      description: CODE_SOURCE_TOOLS.code_create.description,
      inputSchema: CODE_SOURCE_TOOLS.code_create.input,
    }).server(async (args) => {
      const result = await artifactCodeHandlers.code_create(args, context);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    }),
    defineTool({
      name: "code_write",
      description: CODE_SOURCE_TOOLS.code_write.description,
      inputSchema: CODE_SOURCE_TOOLS.code_write.input,
    }).server(async (args) => {
      const result = await artifactCodeHandlers.code_write(args, context);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    }),
    defineTool({
      name: "code_read",
      description: CODE_SOURCE_TOOLS.code_read.description,
      inputSchema: CODE_SOURCE_TOOLS.code_read.input,
    }).server(async (args) => {
      const result = await artifactCodeHandlers.code_read(args, context);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    }),
    defineTool({
      name: "code_run",
      description: "Run a one-off script or saved resource; returns runId and state",
      inputSchema: getCodeToolInputSchema("code_run"),
    }).server((args, ctx) => runtime("code_run", args, ctx.callId)),
    defineTool({
      name: "code_inspect",
      description: "Inspect bounded UI state and returned control event examples",
      inputSchema: getCodeToolInputSchema("code_inspect"),
    }).server((args, ctx) => runtime("code_inspect", args, ctx.callId)),
    defineTool({
      name: "code_interact",
      description: "Interact with exact control ID and typed event, or a batch of up to three steps",
      inputSchema: getCodeToolInputSchema("code_interact"),
    }).server((args, ctx) => runtime("code_interact", args, ctx.callId)),
    defineTool({
      name: "code_export",
      description: "Export a captured file to the chat; returns path and version for code_write fromChatFile",
      inputSchema: getCodeToolInputSchema("code_export"),
    }).server((args, ctx) => runtime("code_export", args, ctx.callId)),
  ];
  const loop = nessi({
    provider,
    systemPrompt: `You are the Assistant. Follow the available skills and inspect their relevant references. Build and verify the user's requested dashboard. Use exact file paths. Current chat files: ${JSON.stringify(await listAiConversationFiles(context.conversationId))}. Local source code and export data are persisted in this disposable workspace.`,
    input:
      "Erstelle aus den drei CSV-Dateien ein interaktives Umsatz-Dashboard mit Umsatz, Marge und Zielerreichung, Monatsverlauf, Datumsbereich, Mehrfachauswahl der Regionen und Reset. Nutze die Code- und Daten-Skills. Übernimm Daten deterministisch, prüfe die Kennzahlen unabhängig und teste die echte gespeicherte App einschließlich Filter und Reset. Berichte die getestete Revision und Grenzen.",
    tools,
    maxTurns: 40,
    maxOutputTokens: 12000,
    disableReasoning: true,
    signal: context.signal,
    store: {
      load: async () => history,
      append: async (message) => {
        history.push({ seq: history.length + 1, kind: "message", message });
      },
    },
  });
  try {
    for await (const event of loop) {
      if (event.type === "turn_start" || event.type === "tool_execution_end" || event.type === "loop_end") {
        events.push(event);
        console.log(
          JSON.stringify({
            eval: event.type,
            ...(event.type === "tool_execution_end" ? { name: event.name, error: event.isError } : {}),
            elapsedMs: Date.now() - started,
          }),
        );
      }
    }
  } finally {
    const listed = await artifacts.list(context, 1, "app");
    apps = await Promise.all(listed.items.filter((item) => !originalIds.has(item.id)).map((item) => artifacts.get(item.id, context)));
    await Bun.write(
      "/tmp/assistant-code-mode-eval.json",
      JSON.stringify({ model: provider.model, disableReasoning: true, elapsedMs: Date.now() - started, history, events, apps }, null, 2),
    );
  }
  return { history, events, apps };
}
