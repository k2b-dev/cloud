import { createHash } from "node:crypto";
import { z } from "zod";
import { getCapability } from "../_internal/registry";
import { CodeBridgeRefusal } from "../code/bridge-contract";
import { type CodeFileRefSchema, codeFileBinding } from "../code/file-ref";
import type { CodeRunTokenClaims } from "../code/run-token";
import { capabilityActionPolicy } from "../contracts/capabilities";
import type { CodeRunnerDispatchDependencies } from "./capabilities";
import { dispatchCapabilityStream, inspectCodeStream } from "./capability-streams";

/** The sole byte reader for Code AI attachments and viewer tools. The source app rechecks current access. */
export async function readCodeAiFile(input: {
  ref: z.infer<typeof CodeFileRefSchema>;
  claims: CodeRunTokenClaims;
  request: Request;
  maxBytes: number;
  dependencies: CodeRunnerDispatchDependencies;
}): Promise<Uint8Array> {
  const { ref, claims, request, dependencies } = input;
  const continuation = codeFileBinding(claims);
  const source = await inspectCodeStream(ref.id, continuation).catch(() => {
    throw new CodeBridgeRefusal("code_file_invalid");
  });
  if (
    source.stream.direction !== "read" ||
    source.stream.size !== ref.size ||
    source.stream.mediaType !== ref.mediaType ||
    source.stream.name !== ref.name
  )
    throw new CodeBridgeRefusal("code_file_invalid");
  if (ref.size > input.maxBytes) throw new CodeBridgeRefusal("code_file_size_limit");
  const entry = await (dependencies.dispatch?.getCapability ?? getCapability)(source.appId);
  let bytes: Uint8Array | undefined;
  let status = 403;
  const result = await dependencies.host.withCall(
    {
      claims,
      call: source.codeCall,
      kind: source.kind === "queries" ? "query" : "action",
      policy: source.kind === "actions" && entry ? capabilityActionPolicy(entry.manifest, source.capabilityId) : undefined,
    },
    async (authority) => {
      if (!authority.consumeFileRef) throw new CodeBridgeRefusal("code_bridge_unavailable", 503);
      if (!(await authority.consumeFileRef(createHash("sha256").update(source.redemptionId).digest("hex"))))
        throw new CodeBridgeRefusal("code_file_spent");
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, claims.exp * 1000 - Date.now()))]);
      const read = await dispatchCapabilityStream(
        new Request(request.url, {
          method: "POST",
          headers: { "x-cloud-stream-id": ref.id, "accept-language": request.headers.get("accept-language") ?? "en" },
          signal,
        }),
        null,
        "read",
        {
          ...dependencies.dispatch,
          continuation,
          code: {
            binding: continuation,
            mandate: { mandateId: authority.mandateId, mandateRevision: authority.mandateRevision, ownerAppId: authority.ownerAppId },
            runId: claims.runId,
          },
          withMandateIssueAuthority: authority.withMandateIssueAuthority,
        },
      );
      status = read.status;
      if (!read.ok || !read.body) {
        await read.body?.cancel();
        authority.onRefusal?.(read.status === 403 || read.status === 404 ? "target_refused" : "bridge");
        return Response.json({ ok: false, error: { code: "code_file_source_refused", status } });
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = read.body.getReader();
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > input.maxBytes || size > ref.size) throw new CodeBridgeRefusal("code_file_size_limit");
          chunks.push(next.value);
        }
        if (size !== ref.size) throw new CodeBridgeRefusal("code_file_size_mismatch");
        bytes = Buffer.concat(chunks, size);
        return Response.json({ ok: true, data: null });
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  );
  if (!bytes) {
    const outcome = z.object({ error: z.object({ code: z.string() }) }).safeParse(await result.json());
    const code = outcome.success ? outcome.data.error.code : "code_file_source_refused";
    throw Object.assign(new Error(`${code} (${status})`), { code, status });
  }
  return bytes;
}
