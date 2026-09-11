import { api } from "@k2b/cloud/browser";
import { z } from "zod";
import type { ApiType } from "../api";
import { ArtifactUpdate } from "./contracts";
const client = api.create<ApiType>({ baseUrl: "/api/assistant" }).artifacts;
async function checked(response: Response): Promise<void> {
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    throw new Error(error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : `HTTP ${response.status}`);
  }
}
export const artifactClient = {
  list: async (page = 1) => {
    const response = await client.$get({ query: { page: String(page) } });
    await checked(response); return response.json();
  },
  get: async (id: string) => {
    const response = await client[":id"].$get({ param: { id } });
    await checked(response); return response.json();
  },
  update: async (id: string, input: z.infer<typeof ArtifactUpdate>) => {
    const response = await client[":id"].$put({ param: { id }, json: input });
    await checked(response);
    const result = await response.json();
    window.dispatchEvent(new Event("assistant-artifact-saved"));
    return result;
  },
  compiled: async (id: string, revision: number) => {
    const response = await client[":id"].compiled.$get({ param: { id }, query: { revision: String(revision) } });
    await checked(response);
    return z.object({ runtime: z.string(), code: z.string(), revision: z.number().int() }).parse(await response.json());
  },
};
