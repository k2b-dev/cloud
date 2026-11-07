import { CodeResourceId } from "@k2b/cloud/ai/browser";
import { z } from "zod";
import { LIMITS } from "./contracts";
import { HttpsUrl, SecretName } from "./http-contracts";

const DataRight = z.enum(["none", "read", "write"]);
export const MachineRights = z
  .object({
    execute: z.boolean().default(false),
    storage: DataRight.default("none"),
    database: DataRight.default("none"),
    secrets: z.array(SecretName).max(LIMITS.files).default([]),
    http: z
      .array(
        z
          .object({
            origin: HttpsUrl.refine((value) => new URL(value).origin === value, "Use an exact HTTPS origin"),
            methods: z
              .array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]))
              .min(1)
              .max(7),
          })
          .strict(),
      )
      .max(LIMITS.files)
      .default([]),
    sharing: z.boolean().default(false),
  })
  .strict();
export type MachineRights = z.infer<typeof MachineRights>;
export const MachineExecution = z
  .object({
    requestId: z.uuid(),
    createdAt: z.number().int(),
    publishedVersion: z.number().int().positive(),
    action: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9_]*$/)
      .max(80)
      .optional(),
    input: z.json().optional(),
  })
  .strict();
export type MachineExecution = z.infer<typeof MachineExecution>;
export const MachineHostInput = MachineExecution.extend({ artifactId: CodeResourceId });
export type MachineHostInput = z.infer<typeof MachineHostInput>;
