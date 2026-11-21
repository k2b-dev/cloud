import { getApp } from "../_internal/registry";
import { bindView } from "../blocks/bind";
import { validateBlocks } from "../blocks/validate";
import type { CapabilityClientResult } from "./types";

/** Keep the raw view in the result; validation only uses the temporary bound tree. */
export async function validateReceivedCapabilityView<T>(
  result: CapabilityClientResult<T>,
  appId: string,
): Promise<CapabilityClientResult<T>> {
  if (!result.ok || !result.data.view) return result;
  try {
    const app = await getApp(appId);
    if (!app || app.id !== appId) throw new Error("Missing view app registration");
    validateBlocks(bindView(result.data.view, result.data.data).blocks, "result", {
      appId,
      appPrefixes: app.routes,
      envelope: result.data,
    });
    return result;
  } catch {
    return { ok: false, error: { code: "INVALID_APP_RESPONSE", message: "Cloud returned an invalid capability result view", status: 502 } };
  }
}
