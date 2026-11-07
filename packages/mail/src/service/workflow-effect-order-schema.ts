import type { sql } from "bun";
import orderingSchema from "./workflow-effect-order-schema.sql" with { type: "text" };

export const ensureMailWorkflowEffectOrderSchema = async (db: typeof sql): Promise<void> => {
  await db.unsafe(orderingSchema).simple();
};
