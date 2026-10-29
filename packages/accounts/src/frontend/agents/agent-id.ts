import { z } from "zod";

const AgentIdSchema = z.uuid();

/** The agent id from the page path, or null when it is not a UUID, so the page answers 404 without a database query. */
export const agentIdFromPath = (value: string | undefined): string | null => {
  const parsed = AgentIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
