import type {
  WorkflowBoundPlan,
  WorkflowCondition,
  WorkflowDiagnostic,
  WorkflowIr,
  WorkflowIrStep,
  WorkflowJsonValue,
  WorkflowSourceLocation,
} from "@valentinkolb/cloud/workflows";
import { workflowPathKey } from "@valentinkolb/cloud/workflows";
import {
  bindWorkflow,
  compileWorkflow,
  isWorkflowReservedReferenceRoot,
  parseWorkflowValueString,
  parseWorkflowYaml,
  resolveWorkflowValuePathDescriptor,
  type WorkflowValuePathDescriptor,
  workflowMessageExpressions,
} from "@valentinkolb/cloud/workflows/language";
import { normalizeWorkflowSchedule } from "@valentinkolb/cloud/workflows/runtime";
import {
  getWorkflowCatalogRef,
  snapshotWorkflowCatalog,
  type WorkflowCatalog,
  type WorkflowCatalogEntry,
  type WorkflowCatalogIndex,
  type WorkflowFieldCatalogEntry,
} from "../service/workflow-catalog";
import { gridsWorkflows } from "./module";

export type BindGridsWorkflowResult =
  | { ok: true; plan: WorkflowBoundPlan; source?: string }
  | { ok: false; diagnostics: WorkflowDiagnostic[] };

type CanonicalEdit =
  | { kind: "value" | "key"; path: Array<string | number>; value: string }
  | { kind: "reference"; path: Array<string | number>; from: string; to: string };

type ValueInfo = WorkflowValuePathDescriptor & { tableId?: string };

const textValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "core.text" };
const dateTimeValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "core.dateTime" };
const recordValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "grids.record" };
const gridsValueDescriptors: Record<string, WorkflowValuePathDescriptor> = {
  "core.textArray": { kind: "array", type: "core.textArray", items: textValue },
  "grids.record": recordValue,
  "grids.recordList": { kind: "array", type: "grids.recordList", items: recordValue },
  "grids.document": {
    kind: "object",
    type: "grids.document",
    properties: {
      id: textValue,
      shortId: textValue,
      templateId: textValue,
      workflowRunId: textValue,
      snapshotId: textValue,
      baseId: textValue,
      tableId: textValue,
      recordId: textValue,
      documentNumber: textValue,
      filename: textValue,
      tags: { kind: "array", type: "core.array", items: textValue },
      createdBy: textValue,
      createdAt: dateTimeValue,
    },
  },
  "grids.documentLink": {
    kind: "object",
    type: "grids.documentLink",
    properties: { kind: textValue, id: textValue, documentId: textValue, url: textValue, expiresAt: dateTimeValue },
  },
  "grids.emailDelivery": {
    kind: "object",
    type: "grids.emailDelivery",
    properties: {
      templateId: textValue,
      subject: textValue,
      recipients: {
        kind: "array",
        type: "core.array",
        items: {
          kind: "object",
          type: "grids.emailRecipient",
          properties: { id: textValue, deliveryId: textValue, kind: textValue, recipient: textValue, status: textValue },
        },
      },
    },
  },
};

const valueDescriptor = (type: string): WorkflowValuePathDescriptor => gridsValueDescriptors[type] ?? { kind: "scalar", type };

type BindingContext = {
  ir: WorkflowIr;
  catalog: WorkflowCatalog;
  inputs: Map<string, ValueInfo>;
  bindings: Record<string, WorkflowJsonValue>;
  diagnostics: WorkflowDiagnostic[];
  canonicalEdits: CanonicalEdit[];
};

const locationForPath = (
  path: Array<string | number>,
  locations: Record<string, WorkflowSourceLocation>,
): WorkflowSourceLocation | undefined => {
  for (let length = path.length; length >= 0; length -= 1) {
    const location = locations[workflowPathKey(path.slice(0, length))];
    if (location) return location;
  }
  return undefined;
};

const addDiagnostic = (context: BindingContext, code: string, message: string, path: Array<string | number>): void => {
  const location = locationForPath(path, context.ir.sourceLocations);
  context.diagnostics.push({ code, message, severity: "error", path, ...(location ? { location } : {}) });
};

const bindId = (context: BindingContext, path: Array<string | number>, id: string): void => {
  context.bindings[workflowPathKey(path)] = id;
};

const resolveCatalogRef = <T extends WorkflowCatalogEntry>(
  context: BindingContext,
  index: WorkflowCatalogIndex<T>,
  reference: string,
  label: string,
  path: Array<string | number>,
  canonicalKind: "value" | "key" | null = "value",
): T | null => {
  if (index.ambiguous.has(reference)) {
    addDiagnostic(context, "binding.ambiguous", `Ambiguous ${label} reference "${reference}"`, path);
    return null;
  }
  const entry = getWorkflowCatalogRef(index, reference);
  if (!entry) {
    addDiagnostic(context, "binding.unknown", `Unknown or inaccessible ${label} "${reference}"`, path);
    return null;
  }
  bindId(context, path, entry.id);
  if (canonicalKind) context.canonicalEdits.push({ kind: canonicalKind, path, value: entry.shortId });
  return entry;
};

const referenceSource = (value: string): string | null => {
  const parsed = parseWorkflowValueString(value);
  return parsed.kind === "literal" ? value : null;
};

const bindField = (
  context: BindingContext,
  tableId: string,
  reference: string,
  path: Array<string | number>,
  canonicalKind: "value" | "key" | null = "value",
): WorkflowFieldCatalogEntry | null => {
  const fields = context.catalog.fieldsByTable.get(tableId);
  if (!fields) {
    addDiagnostic(context, "binding.unknown", `No accessible fields exist for the referenced table`, path);
    return null;
  }
  return resolveCatalogRef(context, fields, reference, "field", path, canonicalKind);
};

const relationValue = (field: WorkflowFieldCatalogEntry, path: Array<string | number>, context: BindingContext): ValueInfo | null => {
  if (!field.relation) return null;
  bindId(context, [...path, "$relationTarget"], field.relation.targetTableId);
  context.bindings[workflowPathKey([...path, "$relationCardinality"])] = field.relation.cardinality;
  const descriptor = valueDescriptor(field.relation.cardinality === "single" ? "grids.record" : "grids.recordList");
  return { ...descriptor, tableId: field.relation.targetTableId };
};

const resolveReference = (
  reference: string,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
  triggerValues?: ReadonlyMap<string, ValueInfo>,
): ValueInfo | null => {
  const parts = reference.split(".");
  const root = parts.shift();
  let value: ValueInfo | undefined;
  let fieldParts: string[];

  if (triggerValues && root !== "trigger") {
    addDiagnostic(context, "reference.scope", `Reference "${reference}" is not available while binding a trigger`, path);
    return null;
  }

  if (root === "inputs") {
    const inputName = parts.shift();
    value = inputName ? context.inputs.get(inputName) : undefined;
    if (!value) {
      addDiagnostic(context, "reference.unknown", `Unknown input reference "${reference}"`, path);
      return null;
    }
    fieldParts = parts;
  } else if (root === "trigger") {
    if (!triggerValues) {
      addDiagnostic(context, "reference.scope", "Trigger values are only available in trigger with bindings", path);
      return null;
    }
    const eventName = parts.shift();
    value = eventName ? triggerValues.get(eventName) : undefined;
    if (!value) {
      addDiagnostic(context, "reference.unknown", `Unknown trigger value reference "${reference}"`, path);
      return null;
    }
    fieldParts = parts;
  } else {
    value = root ? scope.get(root) : undefined;
    if (!root || !value) {
      addDiagnostic(context, "reference.unknown", `Unknown value reference "${reference}"`, path);
      return null;
    }
    fieldParts = parts;
  }

  if (fieldParts.length === 0) return value;
  if (value.type === "grids.record") {
    if (fieldParts.length === 1 && fieldParts[0] === "recordId") return valueDescriptor("core.text");
    if (value.tableId) {
      const fieldReference = fieldParts.length <= 2 ? fieldParts[0]! : fieldParts.join(".");
      const field = bindField(context, value.tableId, fieldReference, path, null);
      if (field) {
        const sourcePath = path.slice(-2)[0] === "expression" && typeof path.at(-1) === "number" ? path.slice(0, -2) : path;
        const referenceParts = reference.split(".");
        const canonicalReference = [
          ...referenceParts.slice(0, referenceParts.length - fieldParts.length),
          field.shortId,
          ...fieldParts.slice(1),
        ].join(".");
        context.canonicalEdits.push({ kind: "reference", path: sourcePath, from: reference, to: canonicalReference });
        const relation = relationValue(field, path, context);
        if (!relation || fieldParts.length === 1) return relation ?? valueDescriptor("core.value");
        if (fieldParts.length === 2 && fieldParts[1] === "recordId" && field.relation?.cardinality === "single") {
          return valueDescriptor("core.text");
        }
      }
    }
    addDiagnostic(context, "reference.path", `Reference "${reference}" does not support field path "${fieldParts.join(".")}"`, path);
    return null;
  }
  const resolved = resolveWorkflowValuePathDescriptor(value, fieldParts);
  if (resolved) {
    return resolved.type === "grids.record" && value.tableId ? { ...resolved, tableId: value.tableId } : resolved;
  }
  addDiagnostic(context, "reference.path", `Reference "${reference}" does not support field path "${fieldParts.join(".")}"`, path);
  return null;
};

const bindValue = (
  value: WorkflowJsonValue,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
): ValueInfo => {
  if (typeof value === "string") {
    const parsed = parseWorkflowValueString(value);
    if (parsed.kind === "invalid") {
      addDiagnostic(context, "reference.invalid", "Invalid workflow value expression", path);
    } else if (parsed.kind === "expression" && parsed.expression.kind === "reference") {
      return resolveReference(parsed.expression.reference, path, scope, context) ?? valueDescriptor("core.value");
    } else if (parsed.kind === "expression" && parsed.expression.kind === "now") {
      return dateTimeValue;
    }
    return textValue;
  }
  if (typeof value === "number") return valueDescriptor("core.number");
  if (typeof value === "boolean") return valueDescriptor("core.boolean");
  if (value === null) return valueDescriptor("core.null");
  if (Array.isArray(value)) {
    const elements = value.map((item, index) => bindValue(item, [...path, index], scope, context));
    return { kind: "array", type: "core.array", items: valueDescriptor("core.value"), elements };
  }
  const properties = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindValue(item, [...path, key], scope, context)]));
  return { kind: "object", type: "core.object", properties };
};

const expectReference = (
  value: WorkflowJsonValue | undefined,
  expectedType: string,
  label: string,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
): ValueInfo | null => {
  if (typeof value !== "string") return null;
  const source = referenceSource(value);
  if (!source) {
    addDiagnostic(context, "reference.invalid", `${label} must be a value reference`, path);
    return null;
  }
  const actual = resolveReference(source, path, scope, context);
  if (actual && actual.type !== expectedType) {
    addDiagnostic(context, "reference.type", `${label} references ${actual.type}, expected ${expectedType}`, path);
    return null;
  }
  return actual;
};

const defineValue = (
  name: WorkflowJsonValue | undefined,
  value: ValueInfo,
  path: Array<string | number>,
  scope: Map<string, ValueInfo>,
  context: BindingContext,
): void => {
  if (typeof name !== "string") return;
  if (isWorkflowReservedReferenceRoot(name) || scope.has(name)) {
    addDiagnostic(context, "scope.duplicate", `Value name "${name}" is already defined in this scope`, path);
    return;
  }
  scope.set(name, value);
};

const bindFieldMap = (
  value: WorkflowJsonValue | undefined,
  tableId: string | undefined,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [field, fieldValue] of Object.entries(value)) {
    if (tableId) bindField(context, tableId, field, [...path, field], "key");
    bindValue(fieldValue, [...path, field], scope, context);
  }
};

const bindAtomicFieldMap = (
  value: WorkflowJsonValue | undefined,
  tableId: string | undefined,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [field, fieldValue] of Object.entries(value)) {
    if (tableId) {
      const target = bindField(context, tableId, field, [...path, field, "$target"], null);
      if (target) context.canonicalEdits.push({ kind: "key", path: [...path, field], value: target.shortId });
    }
    bindValue(fieldValue, [...path, field], scope, context);
  }
};

const bindFilterFields = (
  value: WorkflowJsonValue | undefined,
  tableId: string | undefined,
  path: Array<string | number>,
  context: BindingContext,
): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (typeof value.fieldId === "string") {
    if (tableId) bindField(context, tableId, value.fieldId, [...path, "fieldId"]);
    else addDiagnostic(context, "binding.scope", "A recordEvent filter requires a bound table", [...path, "fieldId"]);
  }
  if (Array.isArray(value.filters)) {
    value.filters.forEach((filter, index) => bindFilterFields(filter, tableId, [...path, "filters", index], context));
  }
};

const bindMessage = (
  value: WorkflowJsonValue | undefined,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
): void => {
  if (typeof value !== "string") return;
  const expressions = workflowMessageExpressions(value);
  if (value.replace(/\$\{\{\s*[^{}]+?\s*\}\}/g, "").includes("${{")) {
    addDiagnostic(context, "reference.invalid", "Invalid workflow message expression", path);
    return;
  }
  expressions.forEach((expression, index) => {
    if (!expression.expression) {
      addDiagnostic(context, "reference.invalid", `Invalid workflow message expression "${expression.source}"`, path);
    } else if (expression.expression.kind === "reference") {
      resolveReference(expression.expression.reference, [...path, "expression", index], scope, context);
    }
  });
};

const bindAction = (step: Extract<WorkflowIrStep, { kind: "action" }>, scope: Map<string, ValueInfo>, context: BindingContext): void => {
  const config = step.config;
  const path = [...step.sourcePath, step.action];
  const outputType = gridsWorkflows.manifest.actions.find((action) => action.kind === step.action)?.outputType;
  let output: ValueInfo | undefined = outputType ? valueDescriptor(outputType) : undefined;

  if (step.action === "finalizeRecord" || step.action === "closeRecord") {
    expectReference(config.record, "grids.record", "record", [...path, "record"], scope, context);
    if (step.action === "closeRecord" && config.expectedMode !== undefined) {
      expectReference(config.expectedMode, "core.text", "expectedMode", [...path, "expectedMode"], scope, context);
    }
    if (step.action === "closeRecord" && config.expectedPolicyRevision !== undefined) {
      expectReference(
        config.expectedPolicyRevision,
        "core.number",
        "expectedPolicyRevision",
        [...path, "expectedPolicyRevision"],
        scope,
        context,
      );
    }
  } else if (step.action === "createCorrectionDraft") {
    const original = expectReference(config.original, "grids.record", "original", [...path, "original"], scope, context);
    if (original?.tableId) {
      if (typeof config.typeField === "string") bindField(context, original.tableId, config.typeField, [...path, "typeField"]);
      if (typeof config.originalField === "string") bindField(context, original.tableId, config.originalField, [...path, "originalField"]);
      if (Array.isArray(config.copyFields)) {
        const boundFieldIds = new Set<string>();
        config.copyFields.forEach((field, index) => {
          if (typeof field !== "string") return;
          const fieldPath = [...path, "copyFields", index];
          const bound = bindField(context, original.tableId!, field, fieldPath);
          if (!bound) return;
          if (boundFieldIds.has(bound.id)) {
            addDiagnostic(context, "binding.duplicate", `Correction prefill field "${field}" is selected more than once`, fieldPath);
            return;
          }
          boundFieldIds.add(bound.id);
        });
      }
    }
  } else if (step.action === "updateRecord") {
    const record = expectReference(config.record, "grids.record", "record", [...path, "record"], scope, context);
    bindFieldMap(config.set, record?.tableId, [...path, "set"], scope, context);
    if (config.audit !== undefined) bindValue(config.audit, [...path, "audit"], scope, context);
  } else if (step.action === "createRecord") {
    const table =
      typeof config.table === "string"
        ? resolveCatalogRef(context, context.catalog.tables, config.table, "table", [...path, "table"])
        : null;
    bindFieldMap(config.values, table?.id, [...path, "values"], scope, context);
    output = { ...recordValue, ...(table ? { tableId: table.id } : {}) };
  } else if (step.action === "atomicRecords") {
    if (Array.isArray(config.locks)) {
      config.locks.forEach((record, index) => {
        expectReference(record, "grids.record", "lock", [...path, "locks", index], scope, context);
      });
    }
    if (Array.isArray(config.checks)) {
      config.checks.forEach((rawCheck, checkIndex) => {
        if (!rawCheck || typeof rawCheck !== "object" || Array.isArray(rawCheck)) return;
        const check = rawCheck as Record<string, WorkflowJsonValue>;
        const table =
          typeof check.table === "string"
            ? resolveCatalogRef(context, context.catalog.tables, check.table, "table", [...path, "checks", checkIndex, "table"])
            : null;
        if (!Array.isArray(check.where)) return;
        check.where.forEach((rawPredicate, predicateIndex) => {
          if (!rawPredicate || typeof rawPredicate !== "object" || Array.isArray(rawPredicate)) return;
          const predicate = rawPredicate as Record<string, WorkflowJsonValue>;
          if (table && typeof predicate.field === "string") {
            bindField(context, table.id, predicate.field, [...path, "checks", checkIndex, "where", predicateIndex, "field"]);
          }
          if (predicate.value !== undefined) {
            bindValue(predicate.value, [...path, "checks", checkIndex, "where", predicateIndex, "value"], scope, context);
          }
        });
      });
    }
    if (Array.isArray(config.changes)) {
      config.changes.forEach((rawChange, changeIndex) => {
        if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) return;
        const change = rawChange as Record<string, WorkflowJsonValue>;
        const basePath = [...path, "changes", changeIndex];
        if (change.createRecord && typeof change.createRecord === "object" && !Array.isArray(change.createRecord)) {
          const create = change.createRecord as Record<string, WorkflowJsonValue>;
          const table =
            typeof create.table === "string"
              ? resolveCatalogRef(context, context.catalog.tables, create.table, "table", [...basePath, "createRecord", "table"])
              : null;
          bindAtomicFieldMap(create.values, table?.id, [...basePath, "createRecord", "values"], scope, context);
        }
        if (change.updateRecord && typeof change.updateRecord === "object" && !Array.isArray(change.updateRecord)) {
          const update = change.updateRecord as Record<string, WorkflowJsonValue>;
          const record = expectReference(update.record, "grids.record", "record", [...basePath, "updateRecord", "record"], scope, context);
          bindAtomicFieldMap(update.set, record?.tableId, [...basePath, "updateRecord", "set"], scope, context);
          if (update.ifVersion !== undefined) bindValue(update.ifVersion, [...basePath, "updateRecord", "ifVersion"], scope, context);
          if (update.audit !== undefined) bindValue(update.audit, [...basePath, "updateRecord", "audit"], scope, context);
        }
      });
    }
  } else if (step.action === "generateDocument") {
    const template =
      typeof config.template === "string"
        ? resolveCatalogRef(context, context.catalog.templates, config.template, "document template", [...path, "template"])
        : null;
    const record = expectReference(config.record, "grids.record", "record", [...path, "record"], scope, context);
    if (template && record?.tableId && template.tableId !== record.tableId) {
      addDiagnostic(context, "binding.scope", "Record table does not match the document template table", [...path, "record"]);
    }
    if (config.filename !== undefined) bindValue(config.filename, [...path, "filename"], scope, context);
    if (config.tags !== undefined) bindValue(config.tags, [...path, "tags"], scope, context);
  } else if (step.action === "createDocumentLink") {
    expectReference(config.document, "grids.document", "document", [...path, "document"], scope, context);
    if (config.comment !== undefined) bindValue(config.comment, [...path, "comment"], scope, context);
  } else if (step.action === "sendEmail") {
    if (typeof config.template === "string") {
      resolveCatalogRef(context, context.catalog.emailTemplates, config.template, "email template", [...path, "template"]);
    }
    if (config.to !== undefined) bindValue(config.to, [...path, "to"], scope, context);
    if (config.data !== undefined) bindValue(config.data, [...path, "data"], scope, context);
  } else if (step.action === "httpRequest") {
    if (config.json !== undefined) bindValue(config.json, [...path, "json"], scope, context);
  } else if (step.action === "setVariable") {
    const value = bindValue(config.value!, [...path, "value"], scope, context);
    defineValue(config.name, value, [...path, "name"], scope, context);
  } else if (step.action === "fail" || step.action === "succeed") {
    bindMessage(config.message, [...path, "message"], scope, context);
  }

  if (step.action !== "setVariable" && output) {
    defineValue(config.saveAs, output, [...path, "saveAs"], scope, context);
  }
};

const bindCondition = (
  condition: WorkflowCondition,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
): void => {
  if (condition.operator === "all" || condition.operator === "any") {
    condition.conditions.forEach((child, index) => bindCondition(child, [...path, condition.operator, index], scope, context));
    return;
  }
  if (condition.operator === "not") {
    bindCondition(condition.condition, [...path, "not"], scope, context);
    return;
  }
  if (condition.operator === "exists") {
    resolveReference(condition.reference, [...path, "exists"], scope, context);
    return;
  }
  const operands = condition.operands.map((operand, index) => bindValue(operand, [...path, condition.operator, index], scope, context));
  if (condition.operator === "equals" || condition.operator === "notEquals") return;
  if (condition.operator === "includes") {
    const left = operands[0]!;
    const right = operands[1]!;
    if (left.kind !== "array" && left.type !== "core.value") {
      addDiagnostic(context, "condition.type", `includes operand 1 has type ${left.type}, expected an array`, [...path, "includes", 0]);
    } else if (left.kind === "array" && left.items.type !== "core.value" && right.type !== "core.value" && left.items.type !== right.type) {
      addDiagnostic(context, "condition.type", `includes operand 2 has type ${right.type}, expected ${left.items.type}`, [
        ...path,
        "includes",
        1,
      ]);
    }
    return;
  }
  operands.forEach((operand, index) => {
    const value = condition.operands[index];
    if (operand.type !== "core.text" && !(operand.type === "core.value" && typeof value === "string")) {
      addDiagnostic(context, "condition.type", `${condition.operator} operand has type ${operand.type}, expected core.text`, [
        ...path,
        condition.operator,
        index,
      ]);
    }
  });
};

const bindSteps = (steps: WorkflowIrStep[], scope: Map<string, ValueInfo>, context: BindingContext): void => {
  for (const step of steps) {
    if (step.kind === "action") {
      bindAction(step, scope, context);
    } else if (step.kind === "if") {
      bindCondition(step.condition, [...step.sourcePath, "if"], scope, context);
      bindSteps(step.then, new Map(scope), context);
      bindSteps(step.else, new Map(scope), context);
    } else if (step.kind === "switch") {
      bindValue(step.value, [...step.sourcePath, "switch"], scope, context);
      step.cases.forEach((item, index) => {
        bindValue(item.when, [...step.sourcePath, "cases", index, "when"], scope, context);
        bindSteps(item.steps, new Map(scope), context);
      });
      bindSteps(step.default, new Map(scope), context);
    } else {
      const iterable = expectReference(step.reference, "grids.recordList", "forEach", [...step.sourcePath, "forEach"], scope, context);
      const loopScope = new Map(scope);
      defineValue(
        step.alias,
        { ...recordValue, ...(iterable?.tableId ? { tableId: iterable.tableId } : {}) },
        [...step.sourcePath, "as"],
        loopScope,
        context,
      );
      bindSteps(step.steps, loopScope, context);
    }
  }
};

const typesCompatible = (expected: string, actual: string): boolean =>
  expected === actual ||
  expected === "core.value" ||
  ((expected === "core.date" || expected === "core.dateTime") && actual === "core.text");

const bindTriggers = (context: BindingContext): void => {
  const descriptors = new Map(gridsWorkflows.manifest.triggers.map((trigger) => [trigger.kind, trigger]));
  for (const trigger of context.ir.triggers) {
    const path = ["triggers", trigger.kind] as Array<string | number>;
    const descriptor = descriptors.get(trigger.kind);
    if (!descriptor) continue;
    if (trigger.kind === "schedule") {
      try {
        normalizeWorkflowSchedule({
          cron: typeof trigger.config.cron === "string" ? trigger.config.cron : "",
          timezone: typeof trigger.config.timezone === "string" ? trigger.config.timezone : "UTC",
        });
      } catch (error) {
        addDiagnostic(context, "schedule.invalid", error instanceof Error ? error.message : "Invalid workflow schedule", path);
      }
    }
    const configuredTable =
      trigger.kind === "recordEvent" && typeof trigger.config.table === "string"
        ? resolveCatalogRef(context, context.catalog.tables, trigger.config.table, "table", [...path, "table"])
        : null;
    let triggerTableId = configuredTable?.id;
    if (trigger.kind === "recordEvent" && !triggerTableId) {
      for (const [inputName, value] of Object.entries(trigger.with)) {
        if (typeof value !== "string") continue;
        const parsed = parseWorkflowValueString(value);
        if (parsed.kind === "expression" && parsed.expression.kind === "reference" && parsed.expression.reference === "trigger.record") {
          triggerTableId = context.inputs.get(inputName)?.tableId ?? triggerTableId;
        }
      }
      if (triggerTableId) bindId(context, [...path, "table"], triggerTableId);
    }
    const eventValues = new Map(
      Object.entries(descriptor.eventValues).map(([name, type]) => [
        name,
        { ...valueDescriptor(type), ...(type === "grids.record" && triggerTableId ? { tableId: triggerTableId } : {}) },
      ]),
    );
    if (trigger.kind === "recordEvent") bindFilterFields(trigger.config.filter, triggerTableId, [...path, "filter"], context);

    for (const input of context.ir.inputs) {
      if (input.config.required === true && trigger.with[input.name] === undefined) {
        addDiagnostic(context, "trigger.required", `Trigger must bind required input "${input.name}"`, [...path, "with", input.name]);
      }
    }
    for (const [inputName, value] of Object.entries(trigger.with)) {
      const input = context.inputs.get(inputName);
      if (!input) continue;
      const bindingPath = [...path, "with", inputName];
      let actual: ValueInfo;
      if (typeof value === "string") {
        const parsed = parseWorkflowValueString(value);
        if (parsed.kind === "expression" && parsed.expression.kind === "reference") {
          const resolved = resolveReference(parsed.expression.reference, bindingPath, new Map(), context, eventValues);
          if (!resolved) continue;
          actual = resolved;
        } else if (parsed.kind === "expression" && parsed.expression.kind === "now") {
          actual = dateTimeValue;
        } else if (parsed.kind === "invalid") {
          addDiagnostic(context, "reference.invalid", "Invalid trigger binding expression", bindingPath);
          continue;
        } else {
          actual = textValue;
        }
      } else if (typeof value === "number") actual = valueDescriptor("core.number");
      else if (typeof value === "boolean") actual = valueDescriptor("core.boolean");
      else actual = valueDescriptor("core.value");

      if (!typesCompatible(input.type, actual.type)) {
        addDiagnostic(context, "trigger.type", `Trigger value has type ${actual.type}, expected ${input.type}`, bindingPath);
      }
      if (input.tableId && actual.tableId && input.tableId !== actual.tableId) {
        addDiagnostic(context, "binding.scope", "Trigger record table does not match the input table", bindingPath);
      }
    }
  }
};

const bindInputs = (context: BindingContext): void => {
  const inputTypes = new Map(gridsWorkflows.manifest.inputs.map((input) => [input.kind, input.valueType]));
  for (const input of context.ir.inputs) {
    const type = inputTypes.get(input.type) ?? "core.value";
    let tableId: string | undefined;
    if ((type === "grids.record" || type === "grids.recordList") && typeof input.config.table === "string") {
      const table = resolveCatalogRef(context, context.catalog.tables, input.config.table, "table", ["inputs", input.name, "table"]);
      tableId = table?.id;
    }
    context.inputs.set(input.name, { ...valueDescriptor(type), ...(tableId ? { tableId } : {}) });
  }
};

const parentAt = (
  root: WorkflowJsonValue,
  path: Array<string | number>,
): { parent: Record<string, WorkflowJsonValue> | WorkflowJsonValue[]; key: string | number } | null => {
  if (path.length === 0) return null;
  let value: WorkflowJsonValue = root;
  for (const part of path.slice(0, -1)) {
    if (!value || typeof value !== "object") return null;
    value = Array.isArray(value) ? value[Number(part)]! : value[String(part)]!;
  }
  if (!value || typeof value !== "object") return null;
  return { parent: value, key: path.at(-1)! };
};

const canonicalizeWorkflowSource = (source: string, edits: CanonicalEdit[]): string => {
  const parsed = parseWorkflowYaml(source);
  if (!parsed.ok) return source;
  const root = parsed.parsed.value;

  for (const edit of edits) {
    if (edit.kind === "key") continue;
    const target = parentAt(root, edit.path);
    if (!target) continue;
    const current = Array.isArray(target.parent) ? target.parent[Number(target.key)] : target.parent[String(target.key)];
    if (edit.kind === "value") {
      if (typeof current === "string") {
        if (Array.isArray(target.parent)) target.parent[Number(target.key)] = edit.value;
        else target.parent[String(target.key)] = edit.value;
      }
    } else if (edit.kind === "reference" && typeof current === "string") {
      const next = current.replace(edit.from, edit.to);
      if (Array.isArray(target.parent)) target.parent[Number(target.key)] = next;
      else target.parent[String(target.key)] = next;
    }
  }

  for (const edit of edits) {
    if (edit.kind !== "key") continue;
    const target = parentAt(root, edit.path);
    if (!target || Array.isArray(target.parent) || typeof target.key !== "string" || !(target.key in target.parent)) continue;
    const current = target.parent[target.key];
    delete target.parent[target.key];
    target.parent[edit.value] = current!;
  }

  return Bun.YAML.stringify(root);
};

export const bindGridsWorkflow = async (ir: WorkflowIr, catalog: WorkflowCatalog, source?: string): Promise<BindGridsWorkflowResult> => {
  const manifest = gridsWorkflows.manifest;
  if (ir.languageId !== manifest.id || ir.languageVersion !== manifest.version) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "binding.language",
          message: `Expected ${manifest.id}@${manifest.version}, received ${ir.languageId}@${ir.languageVersion}`,
          severity: "error",
          path: [],
        },
      ],
    };
  }
  const context: BindingContext = { ir, catalog, inputs: new Map(), bindings: {}, diagnostics: [], canonicalEdits: [] };
  bindInputs(context);
  bindTriggers(context);
  bindSteps(ir.steps, new Map(), context);
  if (context.diagnostics.length > 0) return { ok: false, diagnostics: context.diagnostics };

  const plan = await bindWorkflow(ir, gridsWorkflows, () => ({
    catalog: snapshotWorkflowCatalog(catalog),
    bindings: context.bindings,
  }));
  return { ok: true, plan, ...(source === undefined ? {} : { source: canonicalizeWorkflowSource(source, context.canonicalEdits) }) };
};

/** Compile, bind, and structurally rewrite every Grids resource reference to its public short ID. */
export const compileAndBindGridsWorkflowSource = async (source: string, catalog: WorkflowCatalog): Promise<BindGridsWorkflowResult> => {
  const compiled = await compileWorkflow(source, gridsWorkflows);
  if (!compiled.ok) return compiled;
  const bound = await bindGridsWorkflow(compiled.ir, catalog, source);
  if (!bound.ok || bound.source === undefined || bound.source === source) return bound;
  const canonical = await compileWorkflow(bound.source, gridsWorkflows);
  if (!canonical.ok) return canonical;
  return bindGridsWorkflow(canonical.ir, catalog, bound.source);
};

const workflowCatalogIndexWithMigrationAliases = <T extends WorkflowCatalogEntry>(
  index: WorkflowCatalogIndex<T>,
  aliasesByInternalId: ReadonlyMap<string, readonly string[]>,
): WorkflowCatalogIndex<T> => {
  const refs = new Map(index.refs);
  const ambiguous = new Set(index.ambiguous);
  const entries = new Map([...index.refs.values()].map((entry) => [entry.id, entry]));
  for (const [internalId, aliases] of aliasesByInternalId) {
    const entry = entries.get(internalId);
    if (!entry) continue;
    for (const alias of aliases) {
      const existing = refs.get(alias);
      if (existing && existing.id !== internalId) ambiguous.add(alias);
      else refs.set(alias, entry);
    }
  }
  return { refs, ambiguous };
};

/** One-time migration seam. Legacy aliases are accepted only by the temporary catalog passed to this call. */
export const canonicalizeGridsWorkflowSourceForMigration = async (
  source: string,
  catalog: WorkflowCatalog,
  aliasesByInternalId: ReadonlyMap<string, readonly string[]>,
): Promise<BindGridsWorkflowResult> =>
  compileAndBindGridsWorkflowSource(source, {
    tables: workflowCatalogIndexWithMigrationAliases(catalog.tables, aliasesByInternalId),
    fieldsByTable: new Map(
      [...catalog.fieldsByTable].map(([tableId, fields]) => [
        tableId,
        workflowCatalogIndexWithMigrationAliases(fields, aliasesByInternalId),
      ]),
    ),
    templates: workflowCatalogIndexWithMigrationAliases(catalog.templates, aliasesByInternalId),
    emailTemplates: workflowCatalogIndexWithMigrationAliases(catalog.emailTemplates, aliasesByInternalId),
  });
