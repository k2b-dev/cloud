import { CloudResourceReferenceSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { fail, ok, type ValueFieldType } from "./types";
import { fieldValidationMessages } from "./validation-messages";

// Presentation is a retained label, never an authorization or a stored URL.
export const ResourceValueSchema = CloudResourceReferenceSchema.pick({ type: true, id: true, title: true });
export const resourceHandler: ValueFieldType = {
  type: "resource",
  kind: "value",
  configSchema: z.object({}).strict(),
  validate(raw, config, required, context) {
    const t = fieldValidationMessages(context?.locale);
    if (!this.configSchema.safeParse(config ?? {}).success) return fail(t.config);
    if (raw === null || raw === undefined || raw === "") return required ? fail(t.required) : ok(null);
    const parsed = ResourceValueSchema.safeParse(raw);
    return parsed.success ? ok(parsed.data) : fail(t.resource);
  },
};
