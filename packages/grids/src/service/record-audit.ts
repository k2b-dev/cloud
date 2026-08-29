import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { AuditQuestion, RecordAuditContext, RecordMutationAudit, TableAuditPolicy } from "../contracts";
import { RecordMutationAuditSchema, TableAuditPolicySchema } from "../contracts";
import { type RecordAuditOperation, recordAuditRequirementFor } from "../record-audit-policy";
import type { SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";

export const loadTableAuditPolicy = async (client: SqlClient, tableId: string, locale?: string): Promise<Result<TableAuditPolicy>> => {
  const messages = getGridsCrudMessages(locale);
  const [row] = await client<Array<{ audit_policy: unknown }>>`
    SELECT t.audit_policy
    FROM grids.tables t
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.id = ${tableId}::uuid AND t.deleted_at IS NULL
    FOR SHARE OF t
  `;
  if (!row) return fail(err.notFound(messages.table));
  const parsed = TableAuditPolicySchema.safeParse(row.audit_policy ?? {});
  return parsed.success ? ok(parsed.data) : fail(err.internal(messages.storedAuditInvalid));
};

const answerForQuestion = (
  question: AuditQuestion,
  rawValue: string | undefined,
  locale?: string,
): Result<RecordAuditContext["answers"][number] | null> => {
  const messages = getGridsCrudMessages(locale);
  const value = rawValue?.trim() ?? "";
  if (!value) {
    return question.required ? fail(err.badInput(messages.auditAnswerRequired({ label: question.label }))) : ok(null);
  }

  if (question.type === "select") {
    const option = question.options.find((candidate) => candidate.id === value);
    if (!option) return fail(err.badInput(messages.auditAnswerInvalid({ label: question.label })));
    return ok({
      questionId: question.id,
      label: question.label,
      type: question.type,
      required: question.required,
      value,
      optionLabel: option.label,
    });
  }

  return ok({
    questionId: question.id,
    label: question.label,
    type: question.type,
    required: question.required,
    value,
  });
};

/**
 * Validates operation metadata against the table policy and returns the
 * immutable, display-ready snapshot written to the audit log.
 */
export const buildRecordAuditContext = (
  policy: TableAuditPolicy,
  operation: RecordAuditOperation,
  changedFieldIds: string[],
  audit?: RecordMutationAudit,
  locale?: string,
): Result<RecordAuditContext | null> => {
  const messages = getGridsCrudMessages(locale);
  const requirement = recordAuditRequirementFor(policy, operation, changedFieldIds);
  const parsedAudit = RecordMutationAuditSchema.safeParse(audit ?? {});
  if (!parsedAudit.success) {
    return fail(err.badInput(parsedAudit.error.issues[0]?.message ?? messages.invalidAuditAnswers));
  }
  const suppliedAnswers = parsedAudit.data.answers;

  if (!requirement) {
    return Object.keys(suppliedAnswers).length === 0 ? ok(null) : fail(err.badInput(messages.auditAnswersUnexpected({ operation })));
  }

  const questionIds = new Set(requirement.questions.map((question) => question.id));
  const unknownQuestionId = Object.keys(suppliedAnswers).find((questionId) => !questionIds.has(questionId));
  if (unknownQuestionId) return fail(err.badInput(messages.unknownAuditQuestion({ id: unknownQuestionId })));

  const answers: RecordAuditContext["answers"] = [];
  for (const question of requirement.questions) {
    const answer = answerForQuestion(question, suppliedAnswers[question.id], locale);
    if (!answer.ok) return answer;
    if (answer.data) answers.push(answer.data);
  }

  return ok({ version: 1, operation, questions: requirement.questions, answers });
};
