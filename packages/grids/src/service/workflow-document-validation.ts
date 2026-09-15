import type { DateContext } from "@k2b/stdlib";
import { documentProfiles, profileKey, profileRegistry } from "../document-profiles";
import type { SqlClient } from "./audit";
import { type DocumentDbRow, mapDocumentTemplate } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { validateDocumentProfileInput } from "./document-profile-validation";
import { buildLiveRenderData, renderDocumentProfileInput } from "./document-rendering";
import { captureRecordSnapshotDraft } from "./document-snapshots";
import { get as getTable } from "./tables";
import { buildTemplateAppData } from "./template-context";
import { actionError, actorId, type GridsWorkflowActionScope, requireOk, type WorkflowEffectAccess } from "./workflow-action-scope";

const profiles = profileRegistry(documentProfiles);

/** Called after atomic changes, on their transaction. No PDF rendering or issuance. */
export async function validateWorkflowDocument(
  client: SqlClient,
  scope: GridsWorkflowActionScope,
  target: { templateId: string; tableId: string; recordId: string },
  dates: DateContext,
  effectAccess: WorkflowEffectAccess,
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
  // Match record issuance's graph authorization and snapshot context. No snapshot
  // is persisted. Scanner metadata created during rendering uses this same tx.
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
  const input = requireOk(await renderDocumentProfileInput(template, { ...rendered.data, snapshot }, dates.locale));
  const validated = validateDocumentProfileInput(profile, input, dates.locale);
  // This message is produced by our safe, localized diagnostic mapper, never
  // by the renderer or the raw validator. Published apps may display it.
  if (!validated.ok) throw actionError("DOCUMENT_INPUT_INVALID", validated.error.message);
}
