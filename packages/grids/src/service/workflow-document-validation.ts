import type { DateContext } from "@k2b/stdlib";
import { documentProfiles, profileKey, profileRegistry } from "../document-profiles";
import type { SqlClient } from "./audit";
import { documentIssuanceService } from "./document-issuance";
import { type DocumentDbRow, mapDocumentTemplate } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { validateDocumentProfileInput } from "./document-profile-validation";
import { buildLiveRenderData, renderDocumentProfileInput } from "./document-rendering";
import { captureRecordSnapshotDraft } from "./document-snapshots";
import { get as getTable } from "./tables";
import { buildTemplateAppData } from "./template-context";
import {
  actionError,
  actorId,
  documentActorForScope,
  type GridsWorkflowActionScope,
  requireOk,
  type WorkflowEffectAccess,
} from "./workflow-action-scope";

const profiles = profileRegistry(documentProfiles);

/** Validate after atomic changes, reserving finalized documents on the same transaction. No PDF rendering. */
export async function validateWorkflowDocument(
  client: SqlClient,
  scope: GridsWorkflowActionScope,
  target: { templateId: string; tableId: string; recordId: string },
  dates: DateContext,
  effectAccess: WorkflowEffectAccess,
  stepKey: string,
) {
  const t = documentServiceText(dates.locale);
  await effectAccess.requireTable(target.tableId);
  const [row] = await client<DocumentDbRow[]>`
    SELECT * FROM grids.document_templates WHERE id = ${target.templateId}::uuid FOR SHARE
  `;
  const template = row ? mapDocumentTemplate(row) : null;
  const table = await getTable(target.tableId, { client });
  if (!template || !table || table.baseId !== scope.baseId || template.tableId !== table.id)
    throw actionError("DOCUMENT_TEMPLATE_INVALID", t.templateWrongTable);
  if (template.deletedAt || !template.enabled) throw actionError("DOCUMENT_TEMPLATE_DISABLED", t.templateDisabled);
  if (template.renderer.kind !== "profile") throw actionError("DOCUMENT_PROFILE_REQUIRED", t.profileRequired);
  const profile = profiles.get(profileKey(template.renderer.id, template.renderer.version));
  if (!profile) throw actionError("DOCUMENT_PROFILE_INVALID", t.unknownProfile({ profile: template.renderer.id }));
  const viewer = {
    userId: scope.principal.userId,
    userGroups: scope.principal.groupIds,
    serviceAccountId: scope.principal.serviceAccountId,
  };
  const app = await buildTemplateAppData();
  // Match record issuance's graph authorization and snapshot context. Scanner
  // metadata and the finalized document reservation use this same transaction.
  const { snapshot, record } = requireOk(
    await captureRecordSnapshotDraft({
      client,
      templateApp: app,
      baseId: table.baseId,
      tableId: table.id,
      recordId: target.recordId,
      actorId: actorId(scope),
      viewer,
      dateConfig: dates,
      canReadTable: ({ tableId }) => effectAccess.canReadTable(tableId),
    }),
  );
  const rendered = requireOk(
    await buildLiveRenderData({ client, app, template, table, record, dateConfig: dates, createdAt: new Date(record.updatedAt) }),
  );
  if (record.finalizedAt && template.issuancePolicy === "oncePerFinalizedRecord") {
    // Freeze business settings, template, input and number together with the
    // finalized record. A later worker only renders this durable reservation.
    const reserved = await documentIssuanceService.reserveDocumentInTransaction(client, {
      template,
      snapshot,
      renderData: { ...rendered.data, snapshot },
      actor: documentActorForScope(scope),
      idempotencyKey: `${scope.runId}:${template.id}:${record.id}`,
      workflowRunId: scope.runId,
      // One atomic step may reserve several documents. Each retains its own
      // stable provenance under the document workflow-step uniqueness contract.
      workflowStepKey: `${stepKey}:document:${template.id}:${record.id}`,
      dateConfig: dates,
      canReadTable: ({ tableId }) => effectAccess.canReadTable(tableId),
    });
    // Reservation diagnostics come from the same safe profile mapper; expose
    // invalid input consistently whether it is checked or reserved.
    if (!reserved.ok && reserved.error.code === "BAD_INPUT") throw actionError("DOCUMENT_INPUT_INVALID", reserved.error.message);
    requireOk(reserved);
    return;
  }
  const input = requireOk(await renderDocumentProfileInput(template, { ...rendered.data, snapshot }, dates.locale));
  const validated = validateDocumentProfileInput(profile, input, dates.locale);
  // This message is produced by our safe, localized diagnostic mapper, never
  // by the renderer or the raw validator. Published apps may display it.
  if (!validated.ok) throw actionError("DOCUMENT_INPUT_INVALID", validated.error.message);
}
