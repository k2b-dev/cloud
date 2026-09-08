import { z } from "zod";
import { fail, ok, type ValueFieldType } from "./types";

export const MAX_PRINCIPALS_PER_FIELD = 100;

export const PrincipalReferenceSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("user"), id: z.string().uuid() }).strict(),
    z.object({ type: z.literal("group"), id: z.string().uuid() }).strict(),
  ])
  .readonly();

export type PrincipalReference = z.infer<typeof PrincipalReferenceSchema>;

const PrincipalConfigSchema = z
  .object({
    cardinality: z.enum(["single", "multiple"]).default("multiple"),
  })
  .strict();

const normalize = (raw: unknown): PrincipalReference[] | null | "invalid" => {
  if (raw === null || raw === undefined || raw === "") return null;
  const input = Array.isArray(raw) ? raw : [raw];
  if (input.length > MAX_PRINCIPALS_PER_FIELD) return "invalid";

  const values: PrincipalReference[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const parsed = PrincipalReferenceSchema.safeParse(item);
    if (!parsed.success) return "invalid";
    const key = `${parsed.data.type}:${parsed.data.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(parsed.data);
  }
  return values;
};

export const principalHandler: ValueFieldType = {
  type: "principal",
  kind: "value",
  configSchema: PrincipalConfigSchema,
  validate(raw, configRaw, required) {
    const config = PrincipalConfigSchema.safeParse(configRaw ?? {});
    if (!config.success) return fail("invalid field config");
    const normalized = normalize(raw);
    if (normalized === null || (normalized !== "invalid" && normalized.length === 0)) {
      return required ? fail("required") : ok(null);
    }
    if (normalized === "invalid") {
      return fail(`must contain at most ${MAX_PRINCIPALS_PER_FIELD} valid users or groups`);
    }
    if (config.data.cardinality === "single" && normalized.length > 1) {
      return fail("single-cardinality principal accepts at most one value");
    }
    return ok(normalized);
  },
};
