import type { Context } from "hono";
import { invokeCapabilityWithDataSchema } from "../../capabilities/server";
import type { CloudResourceRef } from "../../contracts/capabilities";
import { getLocale } from "../../server";
import { AttentionSchema } from "./attention-schema";
import { type CodeAttention, type CodePageInvoke, coreQuery, wrapped } from "./data";

export type { CodeAttention };

/** Core answers from a short cache; a slower answer only loses the dot, never delays the page beyond this. */
export const CODE_ATTENTION_TIMEOUT_MS = 800;

/**
 * Asks Core once, during SSR, whether the person may see this resource's Code and whether it needs attention (a failed
 * run, missing access, or a pending approval). It never throws: when Core does not answer in time or fails, the
 * result is null and the owner page renders without the dot.
 */
export const loadCodeAttention = async (
  c: Context,
  ref: CloudResourceRef,
  options: { timeoutMs?: number; invoke?: CodePageInvoke } = {},
): Promise<CodeAttention | null> => {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? CODE_ATTENTION_TIMEOUT_MS);
  const signal = AbortSignal.any([c.req.raw.signal, timeout]);
  const invoke: CodePageInvoke =
    options.invoke ??
    ((invocation, schema) =>
      invokeCapabilityWithDataSchema(invocation, schema, {
        cookie: c.req.header("cookie"),
        authorization: c.req.header("authorization"),
        locale: getLocale(c),
        requestId: c.req.header("x-request-id"),
        signal,
      }));
  const expired = new Promise<null>((resolve) => timeout.addEventListener("abort", () => resolve(null), { once: true }));
  const asked = invoke(coreQuery("code.attention", { owner: { kind: "resource", ref } }), wrapped(AttentionSchema))
    .then((result) => {
      if (!result.ok) return null;
      const items = result.data.data.data.items;
      return { visible: items.length > 0, attention: items.some((item) => item.reasons.length > 0) };
    })
    .catch(() => null);
  return Promise.race([asked, expired]);
};
