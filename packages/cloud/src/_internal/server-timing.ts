import type { Context } from "hono";

type Phase = "auth" | "settings" | "runtime" | "ssr_data" | "ssr_finalize" | "ssr_render";

/** Measure the owning operation, not downstream middleware or another request. */
export async function measureServerPhase<T>(c: Context, phase: Phase, operation: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await operation();
  } finally {
    c.header("Server-Timing", `${phase};dur=${(performance.now() - start).toFixed(2)}`, { append: true });
  }
}
