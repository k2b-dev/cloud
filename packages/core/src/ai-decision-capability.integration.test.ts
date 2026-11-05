import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { databaseSuite, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { compileCapabilities, invokeCompiledCapability } from "../../cloud/src/_internal/capabilities";
import { setAiCredential } from "../../cloud/src/ai/credentials";
import { migrateCloudAi } from "../../cloud/src/ai/migrate";
import { aiModelCatalog, readAiModelProfiles } from "../../cloud/src/ai/model-catalog";
import { aiSettingsFixture } from "../../cloud/src/ai/model-fixture";
import { aiQuotas } from "../../cloud/src/ai/quotas";
import * as settings from "../../cloud/src/ai/settings";
import { decisionInputFixture } from "./ai-decision-capability.test-fixture";
import { aiCapabilities } from "./capabilities";

const personId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const modelId = "capability-decision";
const compiled = compileCapabilities("core", aiCapabilities);

databaseSuite()("core.ai.decide query and caller accounting", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let read: ReturnType<typeof spyOn<typeof settings, "readAiSettingsState">> | undefined;
  let requests = 0;
  const observed: { path: string; body: unknown }[] = [];
  beforeAll(async () => {
    setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
    database = await useMigratedDatabase("core_ai_decide");
    await migrateCloudAi();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${personId}::uuid,'decision-person','local','user')`;
    await sql`INSERT INTO auth.service_accounts(id,name,kind) VALUES(${serviceId}::uuid,'decision-code','code')`;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        observed.push({ path: new URL(request.url).pathname, body: await request.json() });
        return Response.json({
          answers: {
            category: { type: "choice", choice: "spam", probabilities: { support: 0.05, spam: 0.95 } },
            urgent: { type: "noul", noul: 0.99 },
            severity: { type: "score", score: 0.1, probabilities: { "0": 0.9, "1": 0.1 } },
          },
          usage: { input_tokens: 40, output_tokens: 3 },
        });
      },
    });
    await aiModelCatalog.createProvider(
      { id: modelId, type: "openai-compatible", label: "Decision fixture", baseUrl: `${server.url}v1`, dataBoundary: "hosted" },
      personId,
    );
    await setAiCredential(modelId, "fixture-key");
    await aiModelCatalog.createModels(
      modelId,
      [
        {
          id: modelId,
          providerModel: "clef",
          label: "Clef",
          kind: "decision",
          contextWindow: 32768,
          capabilities: [],
          pricing: { inputPerMillion: 1, outputPerMillion: 2 },
        },
      ],
      personId,
    );
    // Code accounts have explicit model grants; they do not inherit authenticated access.
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(service_account_id,permission) VALUES(${serviceId}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO ai.model_access(model_id,access_id) VALUES(${modelId},${access!.id}::uuid)`;
    const config = await aiQuotas.config();
    await aiQuotas.save({ ...config, enabled: false }, personId);
    const assignments = await aiModelCatalog.assignments();
    const assignment = assignments.find((a) => a.slot === "decision")!;
    await aiModelCatalog.assign("decision", modelId, assignment.revision, personId);
    read = spyOn(settings, "readAiSettingsState").mockResolvedValue(
      aiSettingsFixture({ profiles: await readAiModelProfiles(), assignments: await aiModelCatalog.assignments() }),
    );
  }, 120_000);
  afterAll(async () => {
    read?.mockRestore();
    server?.stop(true);
    await database?.drop();
    setSystemTime();
  });
  const invoke = (type: "user" | "service_account") => {
    const user = {
      id: personId,
      uid: "decision-person",
      provider: "local" as const,
      roles: ["user" as const],
      profile: "user" as const,
      givenname: "Decision",
      sn: "Person",
      displayName: "Decision Person",
      mail: null,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    const context: CapabilityExecutionContext = {
      actor:
        type === "user"
          ? { kind: "user", user }
          : {
              kind: "service_account",
              serviceAccount: {
                id: serviceId,
                name: "decision-code",
                kind: "code",
                status: "active",
                delegatedUserId: null,
                appId: null,
                resourceType: null,
                resourceId: null,
                createdBy: personId,
                createdAt: "2026-11-05T00:00:00.000Z",
              },
              delegatedUser: null,
              scopes: ["*"],
            },
      accessSubject: type === "user" ? { type: "user", userId: personId } : { type: "service_account", serviceAccountId: serviceId },
      user: null,
      locale: "en",
      requestId: `decision-${type}`,
      origin: "app",
      signal: new AbortController().signal,
    };
    return invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "ai.decide",
      expectedSchemaHash: compiled.queries.get("ai.decide")!.manifest.schemaHash,
      input: { ...decisionInputFixture, task: `decision.${type}` },
      context,
    });
  };
  test.each(["user", "service_account"] as const)("query charges %s allowance and preserves typed probabilities", async (type) => {
    const result = await invoke(type);
    expect(observed.at(-1)).toMatchObject({ path: "/v1/systemone", body: { questions: decisionInputFixture.questions } });
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: {
          answers: {
            category: { type: "choice", choice: "spam", confidence: 0.95, probabilities: { support: 0.05, spam: 0.95 } },
            urgent: { type: "noul", probability: 0.99, value: true },
            severity: { type: "score", level: 0, probabilities: [0.9, 0.1] },
          },
          usage: { input: 40, output: 3, total: 43 },
        },
      },
    });
    const [call] =
      await sql`SELECT kind,user_id,service_account_id,status,input::int,output::int,cost::float8 FROM ai.inference_calls WHERE task=${`decision.${type}`}`;
    expect(call).toMatchObject({
      kind: "chat",
      user_id: type === "user" ? personId : null,
      service_account_id: type === "service_account" ? serviceId : null,
      status: "ok",
      input: 40,
      output: 3,
    });
    expect(call!.cost).toBeCloseTo(0.000046, 9);
  });
  test("a service account without a model grant is refused before provider dispatch", async () => {
    const [grant] = await sql<
      { access_id: string }[]
    >`SELECT m.access_id FROM ai.model_access m JOIN auth.access a ON a.id=m.access_id WHERE m.model_id=${modelId} AND a.service_account_id=${serviceId}::uuid`;
    await sql`DELETE FROM ai.model_access WHERE model_id=${modelId} AND access_id=${grant!.access_id}::uuid`;
    const before = requests;
    try {
      expect(await invoke("service_account")).toMatchObject({ ok: false, error: { code: "model_policy_mismatch", status: 403 } });
      expect(requests).toBe(before);
    } finally {
      await sql`INSERT INTO ai.model_access(model_id,access_id) VALUES(${modelId},${grant!.access_id}::uuid)`;
    }
  });
  test("caller quota refusal happens before the provider is contacted", async () => {
    const config = await aiQuotas.config();
    await aiQuotas.save(
      {
        ...config,
        enabled: true,
        rules: [
          {
            scope: "*",
            anchor: "2026-11-01T00:00:00.000Z",
            hours: 24,
            grants: [{ principal: { type: "service_account", serviceAccountId: serviceId }, limit: 0 }],
          },
        ],
      },
      personId,
    );
    const before = requests;
    expect(await invoke("service_account")).toMatchObject({ ok: false, error: { code: "quota_exhausted", status: 429 } });
    expect(requests).toBe(before);
  });
});
