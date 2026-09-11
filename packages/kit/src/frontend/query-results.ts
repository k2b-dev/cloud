import { z } from "zod";
const row = z.record(z.string(), z.json());
export const queryResult = z.object({ columns: z.array(z.string()).optional(), data: z.array(row) });
export const tableSchema = z.object({ columns: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()) });
export const cellText = (value: unknown) =>
  value === null ? "NULL" : value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
