import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-ai-usage-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ LocaleProvider }, { default: AiUsageAdminPanel }] = await Promise.all([import("@k2b/ui"), import("./AiUsageAdminPanel.tsx")]);

describe("AiUsageAdminPanel", () => {
  test("renders bounded AI-specific accounting, quality, and background surfaces", () => {
    const html = renderToString(() =>
      createComponent(AiUsageAdminPanel, {
        report: {
          pagination: {
            users: { page: 2, perPage: 100, total: 201 },
            capabilities: { page: 3, perPage: 100, total: 301 },
            backgroundTasks: { page: 1, perPage: 100, total: 102 },
            feedback: { page: 1, perPage: 100, total: 120 },
          },
          overview: {
            range: "30d",
            since: "2026-07-24T00:00:00.000Z",
            turns: 12,
            responses: 11,
            activeUsers: 3,
            inputTokens: 1000,
            outputTokens: 500,
            creditsUsed: 1.25,
            creditsCoverage: 0.75,
            failedTurns: 1,
            positiveFeedback: 4,
            negativeFeedback: 1,
            launchedChats: 2,
            modelSwitches: 1,
          },
          timeline: [{ bucket: "2026-08-23T00:00:00.000Z", turns: 12, tokens: 1500, failed: 1, credits: 1.25 }],
          models: [
            {
              modelProfileId: "fast",
              providerModel: "provider/fast",
              turns: 12,
              failed: 1,
              tokens: 1500,
              credits: 1.25,
              avgGenerationMs: 800,
              p95GenerationMs: 1200,
              avgOutputTokensPerSecond: 24,
              positiveFeedback: 4,
              negativeFeedback: 1,
              switchesAway: 1,
            },
          ],
          users: [{ userId: "user-1", label: "Ada", turns: 12, tokens: 1500, credits: 1.25, failed: 1, capabilities: 2, feedbackGiven: 5 }],
          capabilities: [{ name: "mail.draft.read", calls: 4, failed: 1, rejected: 0, avgDurationMs: 120, users: 2 }],
          backgroundTasks: [
            {
              appId: "core",
              task: "chat-enrich",
              modelProfileId: "fast",
              runs: 5,
              failed: 1,
              tokens: 400,
              credits: 0.25,
              creditsCoverage: 0.6,
              avgDurationMs: 900,
              lastError: "Invalid output",
              lastRunAt: "2026-08-23T10:00:00.000Z",
            },
          ],
          launches: [{ appId: "mail", chats: 2, users: 2 }],
          feedback: [
            {
              messageId: "mSg234",
              conversationId: "cHt234",
              conversationTitle: "Draft reply",
              userLabel: "Ada",
              modelProfileId: "fast",
              rating: "down",
              reasons: ["incorrect"],
              comment: "Wrong date",
              updatedAt: "2026-08-23T10:00:00.000Z",
            },
          ],
        },
      }),
    );

    expect(html).toContain("AI usage");
    expect(html).toContain('aria-label="AI usage range"');
    expect(html).toContain("Models");
    expect(html).toContain("Capabilities");
    expect(html).toContain("Background AI");
    expect(html).toContain("Launched by applications");
    expect(html).toContain("Message ranking");
    expect(html).toContain("Wrong date");
    expect(html).toContain("interactive chats");
    expect(html).toContain("Runs with price");
    expect(html).toContain("0.2500");
    expect(html).toContain("60.0%");
    expect(html).toContain("1 of 201 entries on this page");
    expect(html).toContain("range=30d&amp;capabilitiesPage=3&amp;usersPage=3");
    expect(html).toContain("range=30d&amp;usersPage=2&amp;capabilitiesPage=3&amp;backgroundTasksPage=2");
    expect(html).toContain("range=30d&amp;usersPage=2&amp;capabilitiesPage=3&amp;feedbackPage=2");
    expect(html).toContain("min-w-0 overflow-hidden");
    expect(html).toContain('data-file="AiUsageCharts.island.tsx"');
    expect(html.match(/data-interactive="true"/g)).toHaveLength(2);
  });

  test("renders German copy through the inherited request locale", () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de-CH",
        get children() {
          return createComponent(AiUsageAdminPanel, {
            report: {
              pagination: {
                users: { page: 1, perPage: 100, total: 0 },
                capabilities: { page: 1, perPage: 100, total: 0 },
                backgroundTasks: { page: 1, perPage: 100, total: 0 },
                feedback: { page: 1, perPage: 100, total: 0 },
              },
              overview: {
                range: "30d",
                since: "2026-07-24T00:00:00.000Z",
                turns: 0,
                responses: 0,
                activeUsers: 0,
                inputTokens: 0,
                outputTokens: 0,
                creditsUsed: 0,
                creditsCoverage: 0,
                failedTurns: 0,
                positiveFeedback: 0,
                negativeFeedback: 0,
                launchedChats: 0,
                modelSwitches: 0,
              },
              timeline: [{ bucket: "2026-08-23T00:00:00.000Z", turns: 0, tokens: 0, failed: 0, credits: 0 }],
              models: [],
              users: [],
              capabilities: [],
              backgroundTasks: [],
              launches: [],
              feedback: [],
            },
          });
        },
      }),
    );

    expect(html).toContain("KI-Nutzung");
    expect(html).toContain('aria-label="Zeitraum der KI-Nutzung"');
    expect(html).toContain("Keine KI-Durchläufe in diesem Zeitraum.");
  });
});
