import { z } from "zod";

/** Machine storage uses the existing Files base IDs and permission levels. */
export const MachineStorageInputSchema = z
  .object({ ownerId: z.string().uuid(), area: z.enum(["cloud", "freeipa"]).default("cloud") })
  .strict();
export const StorageGrantInputSchema = z
  .object({
    principal: z.discriminatedUnion("type", [
      z.object({ type: z.literal("user"), userId: z.string().uuid() }),
      z.object({ type: z.literal("group"), groupId: z.string().uuid() }),
      z.object({ type: z.literal("service_account"), serviceAccountId: z.string().uuid() }),
    ]),
    path: z.string().max(4096).default(""),
    permission: z.enum(["read", "write", "admin"]),
  })
  .strict();
export type MachineOwner = { id: string; name: string; kind: "standalone" | "agent" };
export type MachineStorage = { id: string; baseId: string; owner: MachineOwner; area: "cloud" | "freeipa"; state: string };
