import type { sql } from "bun";
import { applySchemaScript } from "../migrate-catalog";
import orderingSchema from "./workflow-effect-order-schema.sql" with { type: "text" };

export const ensureMailWorkflowEffectOrderSchema = async (db: typeof sql): Promise<void> => {
  await applySchemaScript(db, orderingSchema);
};
