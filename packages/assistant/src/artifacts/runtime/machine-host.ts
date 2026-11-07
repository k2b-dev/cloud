import { z } from "zod";
import { LIMITS } from "../contracts";
import { MachineHostInput } from "../machine-contracts";
import { type ArtifactSession, createArtifactSession } from "./session";
import { RuntimeStorage } from "./shared-storage";

/** A single bounded machine action. No conversation, browser user, or personal approval context. */
export async function runMachine(raw: unknown) {
  const input = MachineHostInput.parse(raw);
  const abort = new AbortController();
  let session: ArtifactSession | undefined;
  const container = document.createElement("div");
  container.hidden = true;
  document.body.append(container);
  const request = async (operation: string, body: unknown, signal = abort.signal) => {
    const response = await fetch(`/api/assistant/artifacts/runtime/machine/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(z.object({ code: z.string() }).parse(await response.json()).code);
    return z.json().parse(await response.json());
  };
  try {
    const prepared = z
      .object({
        runtime: z.string(),
        code: z.string(),
        outputSchema: z.record(z.string(), z.json()).nullable(),
        context: z.object({ locale: z.string(), timeZone: z.string(), user: z.null() }),
      })
      .parse(await request("prepare", input));
    session = createArtifactSession(container, prepared, {
      changed: () => {},
      storage: async (value) => {
        const parsed = RuntimeStorage.parse(value);
        if (parsed.scope === "user") throw new Error("ACCESS_DENIED");
        if (parsed.area === "files" && (parsed.operation === "read" || parsed.operation === "write")) {
          const query = new URLSearchParams({ key: parsed.key! });
          let data: Blob | undefined;
          if (parsed.operation === "write") {
            if (typeof parsed.value !== "string" && !(parsed.value instanceof Blob)) throw new Error("INVALID_INPUT");
            data = parsed.value instanceof Blob ? parsed.value : new Blob([parsed.value], { type: "text/plain" });
            if (data.size > LIMITS.rpcBytes) throw new Error("STORAGE_FULL");
          }
          const response = await fetch(`/api/assistant/artifacts/runtime/machine/storage/file?${query}`, {
            method: data ? "PUT" : "GET",
            body: data,
            signal: abort.signal,
            headers: data ? { "content-type": data.type || "application/octet-stream" } : {},
          });
          if (response.status === 404 && !data) return null;
          if (!response.ok) throw new Error("STORAGE_FAILED");
          return data
            ? null
            : new File([await response.blob()], parsed.key!.split("/").pop()!, {
                type: response.headers.get("content-type") ?? "application/octet-stream",
              });
        }
        const result = await request("storage", {
          scope: parsed.scope,
          area: parsed.area,
          operation: parsed.operation,
          key: parsed.key,
          after: parsed.after,
          limit: parsed.limit,
          content: parsed.operation === "write" ? JSON.stringify(parsed.value) : undefined,
        });
        const storage = z
          .object({
            items: z.array(z.object({ key: z.string() })).optional(),
            item: z.object({ content: z.string() }).nullable().optional(),
          })
          .parse(result);
        if (storage.items) return storage.items.map((item) => item.key);
        if (storage.item) return z.json().parse(JSON.parse(storage.item.content));
        return null;
      },
      database: (value, signal) => request("database", value, signal),
      http: (value, signal) => request("http", value, signal),
    });
    const deadline = Date.now() + 45000; // Same operation deadline as the interactive Studio host.
    while (true) {
      const state = session.snapshot();
      if (state.status === "error") throw new Error("EXECUTION_FAILED");
      if (state.status === "ready" && !state.pendingRequests && state.work?.status !== "running") {
        if (prepared.outputSchema && !z.fromJSONSchema(prepared.outputSchema).safeParse(state.output).success)
          throw new Error("ACTION_OUTPUT_INVALID");
        const files: { key: string; name: string; size: number; type: string }[] = [];
        for (const file of session.files()) {
          const key = `runs/${input.requestId}/${file.name}`;
          const response = await fetch(`/api/assistant/artifacts/runtime/machine/storage/file?${new URLSearchParams({ key })}`, {
            method: "PUT",
            body: file,
            headers: { "content-type": file.type || "application/octet-stream" },
            signal: abort.signal,
          });
          if (!response.ok) throw new Error("STORAGE_FAILED");
          files.push({ key, name: file.name, size: file.size, type: file.type });
        }
        const result = { status: "completed", output: z.json().parse(state.output ?? null), files };
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > LIMITS.rpcBytes) throw new Error("OUTPUT_LIMIT");
        return result;
      }
      if (Date.now() >= deadline) throw new Error("EXECUTION_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    abort.abort();
    await session?.stop();
    container.remove();
  }
}
