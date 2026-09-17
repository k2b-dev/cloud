import { api } from "@k2b/cloud/browser";
import type { runnerApi } from "./runner-api";
import { RunnerCompiled, RunnerMetadata } from "./runner-contracts";
const client = api.create<typeof runnerApi>({ baseUrl: "/api/assistant/runner" });
async function checked(response: Pick<Response, "ok" | "status" | "json">) {
  const body: unknown = await response.json();
  if (!response.ok) throw Object.assign(new Error(body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : `HTTP ${response.status}`), { status: response.status });
  return body;
}
export const runnerClient = {
  get: async (id: string) => RunnerMetadata.parse(await checked(await client[":id"].$get({ param: { id } }))),
  compiled: async (id: string) => RunnerCompiled.parse(await checked(await client[":id"].compiled.$get({ param: { id } }))),
};
