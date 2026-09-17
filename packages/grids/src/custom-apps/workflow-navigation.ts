import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import type { CustomAppAction, CustomAppPage } from "./contracts";

const RecordResultSchema = z.object({ kind: z.literal("record"), tableId: ShortIdSchema, recordId: ShortIdSchema });

/** Resolve only the canonical record result; workflow payloads are never URL templates. */
export const customAppWorkflowSuccessParams = (
  navigation: NonNullable<Extract<CustomAppAction, { kind: "workflow" }>["onSuccessNavigate"]>,
  targetPage: CustomAppPage,
  pageParams: Readonly<Record<string, string>>,
  publicResult: unknown,
): Record<string, string> | null => {
  const result = RecordResultSchema.safeParse(publicResult);
  const params: Record<string, string> = {};
  for (const [parameterId, binding] of Object.entries(navigation.params)) {
    if (binding.source === "RESULT") {
      if (!result.success || targetPage.parameters[parameterId]?.tableId !== result.data.tableId) return null;
      params[parameterId] = result.data.recordId;
    } else {
      const value = pageParams[binding.path];
      if (!value) return null;
      params[parameterId] = value;
    }
  }
  return params;
};
