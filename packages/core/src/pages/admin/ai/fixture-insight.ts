/** Invented usage and people reports for the AI area's browser fixture (Usage, Budgets › use per person). */
import { quotaFixture } from "../settings/_components/ai-quota-fixture";
import { usageFixture as usageReport } from "../settings/_components/ai-usage-fixture";
import type { AiFixtureApi, AiFixtureInput } from "./fixture-types";
import type { AiPeopleData, AiUsageData } from "./insight-data";

export const usageFixture = (_input: AiFixtureInput): AiUsageData => ({ report: usageReport() });

export const peopleFixture = (_input: AiFixtureInput): AiPeopleData => ({
  config: { enabled: true, revision: 4, unit: "EUR", rules: [] },
  models: [],
  report: quotaFixture(),
});

export const insightApi: AiFixtureApi = () => undefined;
