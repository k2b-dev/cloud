import { createHash } from "node:crypto";
import { stableCustomAppValue } from "../custom-apps/stable-value";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { buildDslSqlRecordSource } from "../query-dsl/sql-record-source";
import { normalizeRefKey } from "../ref-syntax";
import { listByTable } from "./fields";
import type { Form } from "./forms";
import { relationLabelFields } from "./relation-targets";
import { get as getTable } from "./tables";
import type { Field } from "./types";

/** Selection discloses only the pinned target's presentable fields, never a caller-supplied table. */
export const customAppFormRelationScope = async (form: Pick<Form, "config" | "tableId">, fields: Field[], fixedIds: readonly string[]) => {
  const source = await getTable(form.tableId);
  if (!source) return null;
  const inputIds = new Set(
    form.config.fields.filter((entry) => entry.kind === "user_input" && !fixedIds.includes(entry.fieldId)).map((entry) => entry.fieldId),
  );
  const relations = fields.filter((field) => inputIds.has(field.id) && field.type === "relation" && !field.deletedAt);
  const targets = await Promise.all(
    relations.map(async (field) => {
      const id = field.config.targetTableId;
      if (typeof id !== "string") return null;
      const table = await getTable(id);
      if (!table || table.baseId !== source.baseId) return null;
      const targetFields = await listByTable(id);
      const labels = relationLabelFields(targetFields);
      const recordSource = table.kind === "federated" ? await buildDslSqlRecordSource(id, { [id]: targetFields }) : null;
      const dependencies = new Set(labels.map((label) => label.id));
      const bindings: Record<string, string[]> = {};
      let invalid = false;
      const visit = (dependency: Field): void => {
        if (dependency.type !== "formula" || typeof dependency.config.expression !== "string") return;
        const parsed = parseFormula(dependency.config.expression);
        if (!parsed.ok) {
          invalid = true;
          return;
        }
        for (const ref of collectFieldRefs(parsed.ast)) {
          const key = normalizeRefKey(ref);
          const matches = targetFields.filter((candidate) =>
            [candidate.shortId, candidate.name].some((alias) => normalizeRefKey(alias) === key),
          );
          bindings[key] = matches.map((candidate) => candidate.id).sort();
          if (matches.length !== 1) {
            invalid = true;
            return;
          }
          for (const candidate of matches) {
            if (dependencies.has(candidate.id)) continue;
            dependencies.add(candidate.id);
            visit(candidate);
          }
        }
      };
      for (const label of labels) visit(label);
      if (invalid) return null;
      return {
        field,
        tableId: id,
        tableKind: table.kind,
        recordSource,
        labels,
        targetFields: targetFields.filter((candidate) => dependencies.has(candidate.id)),
        bindings,
      };
    }),
  );
  if (targets.some((target) => !target)) return null;
  const selected = targets.filter((target) => target !== null);
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        stableCustomAppValue(
          [...selected]
            .sort((a, b) => (a.field.id < b.field.id ? -1 : 1))
            .map(({ field, tableId, tableKind, recordSource, labels, targetFields, bindings }) => ({
              fieldId: field.id,
              config: field.config,
              tableId,
              tableKind,
              publication: recordSource ? { id: recordSource.revisionId, token: recordSource.revisionToken } : null,
              bindings,
              labels: labels.map((label) => ({ id: label.id, type: label.type, config: label.config })),
              fields: [...targetFields]
                .sort((a, b) => (a.id < b.id ? -1 : 1))
                .map((target) => ({ id: target.id, type: target.type, config: target.config })),
            })),
        ),
      ),
    )
    .digest("hex");
  return { targets: selected, hash, baseId: source.baseId };
};
