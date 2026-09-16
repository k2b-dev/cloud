import { sql } from "bun";
import type { BackgroundDocumentState } from "../custom-apps/background-state";
import type { CustomAppCapabilities, CustomAppDefinition, CustomAppPage } from "../custom-apps/contracts";
import { customAppDocumentDownloadUrl } from "../custom-apps/routing";
import { resolvePublicIds } from "./public-resources";

/** Caller has admitted the published page/records. Return presentation only,
 * never another actor's run ID, inputs, output or error payload. */
export async function loadBackgroundDocumentStates(input: {
  baseId: string;
  appId: string;
  publishedAt: string;
  page: CustomAppPage;
  capabilities: CustomAppCapabilities;
  records: Array<{ id: string; finalizedAt?: string | null }>;
}): Promise<Record<string, BackgroundDocumentState>> {
  if (!input.records.length) return {};
  const blocks = input.page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
  const background = blocks.flatMap((block) =>
    block.type === "actions"
      ? block.actions.flatMap((action) =>
          action.kind === "workflow" && action.background ? [{ block, action, background: action.background }] : [],
        )
      : [],
  );
  const documentBlocks = new Set(background.map((item) => item.background.documentBlockId));
  const requestedTemplates = new Set(
    (await resolvePublicIds("documentTemplate", [...new Set(background.map((item) => item.background.documentTemplateId))])).values(),
  );
  const templateIds = [
    ...new Set(
      input.capabilities.documents
        .filter((cap) => cap.pageId === input.page.id && documentBlocks.has(cap.blockId))
        .flatMap((cap) => cap.templateIds.filter((id) => requestedTemplates.has(id))),
    ),
  ];
  const launchers = input.capabilities.workflowLaunchers.filter(
    (cap) =>
      "pageId" in cap &&
      cap.pageId === input.page.id &&
      background.some(({ block, action }) => cap.blockId === block.id && cap.actionId === action.id),
  );
  if (!templateIds.length || !launchers.length) return {};
  const ids = input.records.map((record) => record.id);
  const [documents, runs] = await Promise.all([
    sql<Array<{ record_id: string; short_id: string; document_number: string; template_id: string }>>`
      SELECT DISTINCT ON (record_id) record_id::text, short_id, document_number, template_id::text
      FROM grids.documents WHERE base_id = ${input.baseId}::uuid
        AND record_id = ANY(${sql.array(ids, "UUID")}::uuid[])
        AND template_id = ANY(${sql.array(templateIds, "UUID")}::uuid[])
      ORDER BY record_id, created_at DESC, id DESC
    `,
    sql<Array<{ record_id: string; state: string }>>`
      SELECT DISTINCT ON (r.authorization_snapshot->'authorization'->>'recordId')
        r.authorization_snapshot->'authorization'->>'recordId' AS record_id, r.state
      FROM workflows.run r JOIN grids.workflow_run_profile p ON p.run_id = r.id
      WHERE p.base_id = ${input.baseId}::uuid AND r.mode = 'execute'
        AND p.launcher_id = ANY(${sql.array(
          launchers.map((cap) => cap.launcherId),
          "UUID",
        )}::uuid[])
        AND r.authorization_snapshot->'authorization'->>'kind' = 'custom-app-action'
        AND r.authorization_snapshot->'authorization'->>'background' = 'true'
        AND r.authorization_snapshot->'authorization'->>'customAppId' = ${input.appId}
        AND r.authorization_snapshot->'authorization'->>'publishedAt' = ${input.publishedAt}
        AND r.authorization_snapshot->'authorization'->>'pageId' = ${input.page.id}
        AND (r.authorization_snapshot->'authorization'->>'recordId')::uuid = ANY(${sql.array(ids, "UUID")}::uuid[])
      ORDER BY r.authorization_snapshot->'authorization'->>'recordId',
        (r.state IN ('queued', 'running', 'waiting')) DESC, r.created_at DESC, r.id DESC
    `,
  ]);
  const docsByRecord = new Map(documents.map((doc) => [doc.record_id, doc]));
  const runsByRecord = new Map(runs.map((run) => [run.record_id, run]));
  return Object.fromEntries(
    input.records.map((record) => {
      const doc = docsByRecord.get(record.id);
      const run = runsByRecord.get(record.id);
      if (doc) {
        const capability = input.capabilities.documents.find(
          (cap) => cap.pageId === input.page.id && documentBlocks.has(cap.blockId) && cap.templateIds.includes(doc.template_id),
        )!;
        return [
          record.id,
          {
            status: "ready",
            document: { id: doc.short_id, number: doc.document_number, blockId: capability.blockId },
          } satisfies BackgroundDocumentState,
        ];
      }
      return [
        record.id,
        {
          status:
            run && ["queued", "running", "waiting"].includes(run.state)
              ? "running"
              : run?.state === "needs_attention"
                ? "attention"
                : run
                  ? "failed"
                  : record.finalizedAt
                    ? "missing"
                    : "draft",
        } satisfies BackgroundDocumentState,
      ];
    }),
  );
}

export function backgroundDocumentHref(
  appShortId: string,
  pageId: string,
  pageParams: Record<string, string>,
  state: BackgroundDocumentState,
) {
  return state.document
    ? customAppDocumentDownloadUrl(appShortId, pageId, state.document.blockId, state.document.id, pageParams)
    : undefined;
}

export function backgroundStatusPage(definition: CustomAppDefinition, pageId: string | undefined) {
  return definition.pages.find((page) => page.id === pageId && page.record && !page.availableWhen);
}
