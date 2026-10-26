import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { MailWorkflow } from "../../contracts";
import MailWorkflowSettings from "./MailWorkflowSettings";
import { dryRunFixtureBatch, dryRunTagFixtureItems } from "./mail-workflow-dry-run-fixtures";

export type DryRunHarnessOptions = {
  locale: "en" | "de";
  /** Batches answered at once; later ones wait for `releaseDryRun()`. */
  answerBatches: number;
  /** The next batch after the answered ones fails with this message. */
  failWith?: string;
  /** Saves a typo in the stored YAML, so validation fails. */
  invalid?: boolean;
};

declare global {
  interface Window {
    mountWorkflowDryRun: (options: DryRunHarnessOptions) => void;
    releaseDryRun: () => void;
    dryRunRequests: unknown[];
  }
}

const now = "2026-10-26T09:00:00.000Z";
const SOURCE = `# Lange Mails markieren
inputs:
  message: { type: mailMessage, required: true }
  conversation: { type: mailConversation, required: true }
triggers:
  messageReceived:
    with: { message: "\${{ trigger.message }}", conversation: "\${{ trigger.conversation }}" }
steps:
  - if:
      all:
        - not: { equals: ["\${{ inputs.message.isBulk }}", true] }
        - any:
            - greaterThan: ["\${{ inputs.message.textLength }}", 150]
            - greaterThan: ["\${{ inputs.conversation.messageCount }}", 3]
    then:
      - addLocalTag: { conversation: inputs.conversation, tag: Lang }
`;
const workflow: MailWorkflow = {
  id: "Wf001",
  mailboxId: "Box001",
  name: "Lange Mails markieren",
  description: "Markiert lange Mails und lange Unterhaltungen, nie Verteiler.",
  priority: 100,
  currentVersionId: "Ver004",
  activeVersionId: "Ver004",
  enabled: true,
  createdAt: now,
  updatedAt: now,
};
const budget = {
  maxTargets: 1_000,
  maxMoves: 1_000,
  maxCopies: 1_000,
  maxSends: 1_000,
  maxDrafts: 1_000,
  maxFlagChanges: 2_000,
  maxNotifications: 1_000,
  maxKeywordChanges: 2_000,
  maxCollaborationChanges: 2_000,
  maxAiCalls: 10,
};
const detail = {
  ...workflow,
  currentVersion: {
    id: "Ver004",
    identity: "wf_lange@4",
    workflowId: "Wf001",
    mailboxId: "Box001",
    source: SOURCE,
    sourceHash: "a".repeat(64),
    boundPlan: {},
    diagnostics: [],
    effectBudget: budget,
    languageId: "mail",
    languageVersion: 1,
    manifestHash: "b".repeat(64),
    createdAt: now,
  },
  activations: [],
};

window.mountWorkflowDryRun = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = options.locale;
  let answered = 0;
  let release: () => void = () => undefined;
  const released = new Promise<void>((done) => {
    release = done;
  });
  window.releaseDryRun = () => release();
  window.dryRunRequests = [];
  const originalFetch = window.fetch;
  window.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), location.href), init);
      const path = new URL(request.url).pathname;
      if (path === "/api/mail/mailboxes/Box001/workflows/Wf001" && request.method === "GET") {
        const source = options.invalid ? SOURCE.replace("message.textLength", "message.textLenght") : SOURCE;
        return Response.json({ ...detail, currentVersion: { ...detail.currentVersion, source } });
      }
      if (path === "/api/mail/mailboxes/Box001/workflows/validate") {
        const { source } = (await request.json()) as { source: string };
        const typo = source.split("\n").findIndex((line) => line.includes("textLenght"));
        return Response.json({
          valid: typo < 0,
          source,
          sourceHash: null,
          ir: null,
          boundPlan: null,
          diagnostics:
            typo < 0
              ? []
              : [
                  {
                    severity: "error",
                    code: "reference.unknown",
                    message: "Unbekanntes Feld message.textLenght. Meinten Sie message.textLength?",
                    path: ["steps", 0],
                    location: { line: typo + 1, column: 33 },
                  },
                ],
        });
      }
      if (path === "/api/mail/mailboxes/Box001/workflows/autocomplete") return Response.json({ diagnostics: [], items: [] });
      if (path === "/api/mail/mailboxes/Box001/workflows/try") {
        const body = (await request.json()) as { cursor?: string | null };
        window.dryRunRequests.push(body);
        if (answered >= options.answerBatches) {
          if (options.failWith) return Response.json({ code: "UNAVAILABLE", message: options.failWith }, { status: 503 });
          await released;
        }
        answered += 1;
        // A short pause per batch, as the server needs to read mails.
        await new Promise((done) => setTimeout(done, 40));
        return Response.json(dryRunFixtureBatch(body.cursor ?? null, { items: dryRunTagFixtureItems, maxAiCallsPerDay: null }));
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <main class="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4">
          <MailWorkflowSettings
            mailboxId="Box001"
            mailboxName="Vertrieb"
            initialWorkflows={[workflow]}
            referenceConfiguration={{
              mailboxId: "Box001",
              pattern: "VT-{yyyy}-{seq:4}",
              nextSequence: "1",
              enabled: true,
              includeInReplySubjects: false,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            }}
            onReferenceConfigurationChange={() => undefined}
          />
        </main>
      </LocaleProvider>
    ),
    host,
  );
};
