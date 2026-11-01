import { z } from "zod";
import { capabilityCallDigest, capabilityValueDigest } from "../capabilities/calls";
import { CapabilityIdempotencyKeySchema, NormalizedCapabilityCallSchema } from "../contracts/capabilities";
import { RunnerCallError, type RunnerJsonValue } from "./runner-protocol";
import type { CodeTestCall, CodeTestMock } from "./test-contract";
import type { CodeSdkManifest } from "./types";

const InvocationSchema = z
  .object({
    call: NormalizedCapabilityCallSchema,
    metadata: z.object({ idempotencyKey: CapabilityIdempotencyKeySchema.optional() }).strict(),
  })
  .strict();
const equal = (a: unknown, b: unknown) => capabilityValueDigest(a) === capabilityValueDigest(b);
/** Fake-only bridge. One instance per case preserves production-style keyed receipts across repeated runs.
 * Exact normalized targets/refs and manifest schemas are checked on every call, including a replay.
 * Successful replies are retained; errors are not. Keys are scoped by operation (one fictional Code principal).
 * There is deliberately no real-bridge fallback, even for a query, missing mock, AI or secret operation. */
export function createCodeTestBridge(manifest: CodeSdkManifest, mocks: CodeTestMock[]) {
  const receipts = new Map<string, { digest: string; data: RunnerJsonValue }>();
  const cursors = new Map<CodeTestMock, number>();
  let calls: CodeTestCall[] = [];
  let failure: string | null = null;
  return {
    /** Start a fresh attempt's call list while retaining only this case's fake receipts. */
    begin() {
      calls = [];
      failure = null;
    },
    calls: () => structuredClone(calls),
    failure: () => failure,
    async call(operation: string, raw: RunnerJsonValue): Promise<RunnerJsonValue> {
      const parsed = InvocationSchema.safeParse(raw);
      if (!parsed.success) {
        failure ??= "code_test_invalid_call";
        throw new RunnerCallError(failure);
      }
      const { call, metadata } = parsed.data;
      const row: CodeTestCall = {
        sequence: calls.length + 1,
        operation,
        call,
        idempotencyKey: metadata.idempotencyKey ?? null,
        replayed: false,
        result: { ok: false, error: "code_test_invalid_call" },
      };
      calls.push(row);
      const refuse = (code: string, fixtureFailure = true): never => {
        row.result = { ok: false, error: code };
        if (fixtureFailure) failure ??= code;
        throw new RunnerCallError(code);
      };
      const spec = manifest.operations.find((value) => value.capability === operation);
      if (!spec || call.capability !== operation || (spec.target === null ? call.target !== null : call.target?.type !== spec.target))
        return refuse("code_test_invalid_call");
      if (
        Object.keys(spec.refs).sort().join("\0") !== Object.keys(call.refs).sort().join("\0") ||
        Object.entries(spec.refs).some(([key, type]) => call.refs[key]?.type !== type)
      )
        return refuse("code_test_invalid_refs");
      if (!z.fromJSONSchema(spec.inputSchema).safeParse(call.input).success) return refuse("code_test_invalid_input");
      const key = metadata.idempotencyKey;
      if (spec.kind === "action" && spec.idempotency === "required" ? !key : key !== undefined)
        return refuse("code_test_invalid_idempotency");
      const receiptKey = JSON.stringify([operation, key]);
      const digest = capabilityCallDigest(call);
      const old = key ? receipts.get(receiptKey) : undefined;
      if (old) {
        if (old.digest !== digest) return refuse("idempotency_conflict", false);
        row.replayed = true;
        row.result = { ok: true, data: structuredClone(old.data) };
        return structuredClone(old.data);
      }
      const matches = mocks.filter(
        (mock) =>
          mock.operation === operation &&
          equal(mock.target, call.target) &&
          (mock.input === undefined || equal(mock.input, call.input)) &&
          (mock.refs === undefined || equal(mock.refs, call.refs)),
      );
      const specificity = (mock: CodeTestMock) => Number(mock.input !== undefined) + Number(mock.refs !== undefined);
      const best = matches.reduce((best, mock) => Math.max(best, specificity(mock)), -1);
      const selected = matches.filter((mock) => specificity(mock) === best);
      if (selected.length !== 1) return refuse(selected.length ? "code_test_ambiguous_mock" : "code_test_missing_mock");
      const mock = selected[0]!;
      const cursor = cursors.get(mock) ?? 0;
      const reply = mock.replies[cursor];
      if (!reply) return refuse("code_test_mock_exhausted");
      cursors.set(mock, cursor + 1);
      if (!reply.ok) return refuse(reply.error, false);
      if (!z.fromJSONSchema(spec.dataSchema).safeParse(reply.data).success) return refuse("code_test_invalid_fixture");
      const data = structuredClone(reply.data);
      row.result = { ok: true, data };
      if (key) receipts.set(receiptKey, { digest, data: structuredClone(data) });
      return structuredClone(data);
    },
  };
}
