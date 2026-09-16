import type { AiQuotaReport } from "@k2b/cloud/shared";
export function quotaFixture(patch: Partial<AiQuotaReport> = {}): AiQuotaReport {
  return {
    query: {
      view: "users",
      range: "30d",
      search: "",
      model: "",
      status: "all",
      sort: "lastUsed",
      direction: "desc",
      page: 1,
      identityType: "user",
    },
    since: "2026-08-15T00:00:00Z",
    until: "2026-09-15T00:00:00Z",
    asOf: "2026-09-15T00:00:00Z",
    overview: { cost: 1, accounts: 0, input: 0, output: 0, calls: 0, measured: 0, estimated: 0, unknown: 0 },
    items: [],
    timeline: [],
    models: [],
    selected: null,
    total: 0,
    page: 1,
    perPage: 25,
    ...patch,
  };
}
