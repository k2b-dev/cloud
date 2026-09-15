import { describe, expect, test } from "bun:test";
import { ArtifactPath, ArtifactSource, LIMITS } from "./contracts";
import { WorkerMessage } from "./runtime/protocol";

describe("Assistant artifact boundaries", () => {
  test("accepts explicit TypeScript entry and ordinary document files", () => {
    expect(ArtifactSource.parse({ entry: "src/main.ts", files: [
      { path: "src/main.ts", content: "export default () => 42" },
      { path: "notes.md", content: "Notes" },
    ] }).entry).toBe("src/main.ts");
  });

  test("rejects traversal, duplicate files while allowing incomplete sources", () => {
    for (const path of ["../secret", "/main.js", "src/../main.js", "./main.js", "a\\b.js"])
      expect(ArtifactPath.safeParse(path).success).toBe(false);
    expect(ArtifactSource.safeParse({ entry: "main.js", files: [{ path: "other.js", content: "" }] }).success).toBe(true);
    expect(ArtifactSource.safeParse({ entry: "main.js", files: [
      { path: "main.js", content: "" }, { path: "main.js", content: "" },
    ] }).success).toBe(false);
  });

  test("enforces UTF-8 byte budgets rather than only character counts", () => {
    expect(ArtifactSource.safeParse({ entry: "main.js", files: [
      { path: "main.js", content: "€".repeat(Math.ceil(LIMITS.fileBytes / 3)) },
    ] }).success).toBe(false);
  });

  test("does not expose the copied Kit database RPCs", () => {
    expect(WorkerMessage.safeParse({ type: "rpc", id: 0, method: "db.call", args: [] }).success).toBe(false);
    expect(WorkerMessage.safeParse({ type: "rpc", id: 0, method: "db.import", args: [] }).success).toBe(false);
  });
});

test("KV transport accommodates escaped JSON at its byte budget", async () => {
  const {StorageRequest,STORAGE_TRANSPORT_BYTES}=await import("./storage-contracts");
  const content=JSON.stringify("x".repeat(LIMITS.rpcBytes-2));
  const input={area:"kv",operation:"write",key:"full",content};
  expect(StorageRequest.safeParse(input).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(STORAGE_TRANSPORT_BYTES);
  expect(Buffer.byteLength(content)).toBe(LIMITS.rpcBytes);
});

test("selected-input and captured-output budgets agree with chat storage",async()=>{
  const limits=await import("@k2b/cloud/ai");
  expect(LIMITS.inputFileBytes).toBe(limits.AI_FILES_MAX_FILE_BYTES_DEFAULT);
  expect(LIMITS.inputBytes).toBe(limits.AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT);
});
