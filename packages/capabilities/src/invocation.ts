import {
  CAPABILITY_FRAMEWORK_ERROR_CODES,
  CAPABILITY_MAX_RESULT_BYTES,
  CapabilityErrorSchema,
  capabilityResultSchema,
} from "@valentinkolb/cloud/contracts";
import { z } from "zod";
import { capabilityRuntimeMessages } from "./messages";

const ResultSchema = capabilityResultSchema(z.unknown());

export type CapabilityInvocationOutcome =
  | {
      ok: true;
      status: number;
      durationMs: number;
      result: z.infer<typeof ResultSchema>;
    }
  | {
      ok: false;
      status: number;
      durationMs: number;
      error: { code: string; message: string; details?: Record<string, unknown> };
    };

export const ambiguousActionNetworkOutcome = (input: {
  kind: "query" | "action";
  idempotencyKey?: string;
  durationMs: number;
  locale?: string;
}): CapabilityInvocationOutcome | undefined =>
  input.kind === "action" && !input.idempotencyKey
    ? {
        ok: false,
        status: 502,
        durationMs: input.durationMs,
        error: {
          code: CAPABILITY_FRAMEWORK_ERROR_CODES.actionOutcomeUnknown,
          message: capabilityRuntimeMessages.resolve([input.locale ?? "en"]).t.outcomeUnknown,
          details: { retrySafe: false },
        },
      }
    : undefined;

export const preserveAmbiguousActionOutcome = (
  outcome: CapabilityInvocationOutcome,
  input: { kind: "query" | "action"; idempotencyKey?: string; locale?: string },
): CapabilityInvocationOutcome =>
  !outcome.ok && ["INVALID_APP_RESPONSE", "RESPONSE_TOO_LARGE"].includes(outcome.error.code)
    ? (ambiguousActionNetworkOutcome({ ...input, durationMs: outcome.durationMs }) ?? outcome)
    : outcome;

const safeTextMessage = (text: string): string | undefined => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact || compact.startsWith("<")) return undefined;
  return compact.slice(0, 500);
};

const readBoundedText = async (response: Response): Promise<string | null> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CAPABILITY_MAX_RESULT_BYTES) return null;
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      total += chunk.value.byteLength;
      if (total > CAPABILITY_MAX_RESULT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return "";
  }
};

export async function readCapabilityOutcome(response: Response, durationMs: number, locale = "en"): Promise<CapabilityInvocationOutcome> {
  const t = capabilityRuntimeMessages.resolve([locale]).t;
  const text = await readBoundedText(response);
  if (text === null) {
    return {
      ok: false,
      status: response.status,
      durationMs,
      error: { code: "RESPONSE_TOO_LARGE", message: t.responseTooLarge },
    };
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (response.ok) {
    const result = ResultSchema.safeParse(body);
    if (result.success) return { ok: true, status: response.status, durationMs, result: result.data };
    return {
      ok: false,
      status: response.status,
      durationMs,
      error: { code: "INVALID_APP_RESPONSE", message: t.invalidResult },
    };
  }

  const error = CapabilityErrorSchema.safeParse(body);
  if (error.success) return { ok: false, status: response.status, durationMs, error: error.data };
  return {
    ok: false,
    status: response.status,
    durationMs,
    error: {
      code: "INVALID_APP_RESPONSE",
      message: safeTextMessage(text) ?? t.requestFailed({ status: response.status }),
    },
  };
}
