import type {
  WorkflowBoundPlan,
  WorkflowCondition,
  WorkflowDiagnostic,
  WorkflowIr,
  WorkflowIrStep,
  WorkflowJsonValue,
  WorkflowSourceLocation,
} from "@k2b/cloud/workflows";
import { workflowPathKey } from "@k2b/cloud/workflows";
import {
  bindWorkflow,
  isWorkflowReservedReferenceRoot,
  parseWorkflowValueString,
  resolveWorkflowValuePathDescriptor,
  type WorkflowValuePathDescriptor,
} from "@k2b/cloud/workflows/language";
import { normalizeWorkflowSchedule } from "@k2b/cloud/workflows/runtime";
import { responseScheduleDefinitionSchema } from "../contracts";
import { validateResponseScheduleDefinition } from "../response-schedule-validation";
import { mailLiquidTemplateVariables } from "../service/template-rendering";
import {
  buildMailWorkflowCatalog,
  getMailWorkflowCatalogRef,
  type MailWorkflowCatalog,
  type MailWorkflowCatalogEntry,
  type MailWorkflowCatalogIndex,
  snapshotMailWorkflowCatalog,
} from "./catalog";
import { mailWorkflows } from "./module";

const manifest = mailWorkflows.manifest;

export type BindMailWorkflowResult = { ok: true; plan: WorkflowBoundPlan } | { ok: false; diagnostics: WorkflowDiagnostic[] };

type ValueInfo = WorkflowValuePathDescriptor & { providerTarget?: string };

type BindingContext = {
  ir: WorkflowIr;
  catalog: MailWorkflowCatalog;
  inputs: Map<string, ValueInfo>;
  bindings: Record<string, WorkflowJsonValue>;
  diagnostics: WorkflowDiagnostic[];
};

const textValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "core.text" };
const booleanValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "core.boolean" };
const dateTimeValue: WorkflowValuePathDescriptor = { kind: "scalar", type: "core.dateTime" };
const textArrayValue: WorkflowValuePathDescriptor = { kind: "array", type: "core.textArray", items: textValue };
const referenceResult: WorkflowValuePathDescriptor = {
  kind: "object",
  type: "mail.reference",
  properties: {
    value: textValue,
    created: booleanValue,
    conversationId: textValue,
    conversationRevision: { kind: "scalar", type: "core.number" },
  },
};
const draftResult: WorkflowValuePathDescriptor = {
  kind: "object",
  type: "mail.draft",
  properties: {
    id: textValue,
    revision: { kind: "scalar", type: "core.number" },
    senderIdentityId: textValue,
    deliveryClass: textValue,
  },
};
const mailAddress: WorkflowValuePathDescriptor = {
  kind: "object",
  type: "mail.address",
  properties: { role: textValue, name: textValue, email: textValue },
};
const mailAttachment: WorkflowValuePathDescriptor = {
  kind: "object",
  type: "mail.attachment",
  properties: {
    id: textValue,
    filename: textValue,
    contentType: textValue,
    disposition: textValue,
    contentId: textValue,
    sizeBytes: { kind: "scalar", type: "core.number" },
  },
};
const mailValueDescriptors: Record<string, WorkflowValuePathDescriptor> = {
  "mail.message": {
    kind: "object",
    type: "mail.message",
    properties: {
      id: textValue,
      conversationId: textValue,
      subject: textValue,
      sender: { kind: "array", type: "core.array", items: mailAddress },
      fromAddress: textValue,
      fromDomain: textValue,
      recipients: { kind: "array", type: "core.array", items: mailAddress },
      body: textValue,
      bodyText: textValue,
      bodyHtml: textValue,
      attachments: { kind: "array", type: "core.array", items: mailAttachment },
      hasAttachments: booleanValue,
      folderId: textValue,
      flags: { kind: "array", type: "core.array", items: textValue },
      keywords: { kind: "array", type: "core.array", items: textValue },
      direction: textValue,
      internalDate: dateTimeValue,
      receivedAt: dateTimeValue,
    },
  },
  "mail.conversation": {
    kind: "object",
    type: "mail.conversation",
    properties: {
      id: textValue,
      subject: textValue,
      summary: textValue,
      summaryRevision: { kind: "scalar", type: "core.number" },
      assigneeUserId: textValue,
      workStatus: textValue,
      latestMessageAt: dateTimeValue,
    },
  },
  "mail.context": {
    kind: "object",
    type: "mail.context",
    properties: {
      mailboxId: textValue,
      actor: {
        kind: "object",
        type: "workflow.actor",
        properties: {
          userId: textValue,
          groupIds: { kind: "array", type: "core.array", items: textValue },
          serviceAccountId: textValue,
        },
      },
      occurredAt: dateTimeValue,
    },
  },
  "core.textArray": textArrayValue,
  "mail.reference": referenceResult,
  "mail.draft": draftResult,
};

const actionTypes = new Map(manifest.actions.map((action) => [action.kind, action.outputType]));

const valueDescriptor = (type: string): WorkflowValuePathDescriptor => mailValueDescriptors[type] ?? { kind: "scalar", type };

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

const resolveCatalogRef = <T extends MailWorkflowCatalogEntry>(
  context: BindingContext,
  index: MailWorkflowCatalogIndex<T>,
  reference: string,
  label: string,
  path: Array<string | number>,
): T | null => {
  if (index.ambiguous.has(reference)) {
    addDiagnostic(context, "binding.ambiguous", `Ambiguous ${label} reference "${reference}"`, path);
    return null;
  }
  const entry = getMailWorkflowCatalogRef(index, reference);
  if (!entry) {
    addDiagnostic(context, "binding.unknown", `Unknown or inaccessible ${label} "${reference}"`, path);
    return null;
  }
  bindId(context, path, entry.id);
  return entry;
};

const resolveTypedPath = (
  value: ValueInfo,
  parts: string[],
  reference: string,
  path: Array<string | number>,
  context: BindingContext,
): ValueInfo | null => {
  if (parts.length === 0) return value;
  const resolved = resolveWorkflowValuePathDescriptor(value, parts);
  if (resolved) return resolved;
  addDiagnostic(context, "reference.path", `Reference "${reference}" does not expose path "${parts.join(".")}"`, path);
  return null;
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
  } else if (root === "trigger") {
    const eventName = parts.shift();
    value = triggerValues && eventName ? triggerValues.get(eventName) : undefined;
    if (!value) {
      addDiagnostic(context, "reference.unknown", `Unknown trigger value reference "${reference}"`, path);
      return null;
    }
  } else if (root === "context") {
    value = mailValueDescriptors["mail.context"]!;
  } else {
    value = root ? scope.get(root) : undefined;
    if (!value) {
      addDiagnostic(context, "reference.unknown", `Unknown value reference "${reference}"`, path);
      return null;
    }
  }

  return resolveTypedPath(value, parts, reference, path, context);
};

const expressionReference = (value: string): { kind: "literal"; value: string } | { kind: "expression"; value: string } | null => {
  const parsed = parseWorkflowValueString(value);
  if (parsed.kind === "literal") return { kind: "literal", value };
  if (parsed.kind === "expression" && parsed.expression.kind === "reference") {
    return { kind: "expression", value: parsed.expression.reference };
  }
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
    if (parsed.kind === "invalid") addDiagnostic(context, "reference.invalid", "Invalid workflow value expression", path);
    else if (parsed.kind === "expression" && parsed.expression.kind === "reference") {
      return resolveReference(parsed.expression.reference, path, scope, context) ?? valueDescriptor("core.value");
    } else if (parsed.kind === "expression") return dateTimeValue;
    return textValue;
  }
  if (typeof value === "number") return valueDescriptor("core.number");
  if (typeof value === "boolean") return booleanValue;
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
  const source = expressionReference(value);
  if (!source) {
    addDiagnostic(context, "reference.invalid", `${label} must be a value reference`, path);
    return null;
  }
  const actual = resolveReference(source.value, path, scope, context);
  if (actual && actual.type !== expectedType) {
    addDiagnostic(context, "reference.type", `${label} references ${actual.type}, expected ${expectedType}`, path);
    return null;
  }
  return actual;
};

const bindCatalogValue = <T extends MailWorkflowCatalogEntry>(
  value: WorkflowJsonValue | undefined,
  index: MailWorkflowCatalogIndex<T>,
  label: string,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
  nullable = false,
): void => {
  if (value === null && nullable) return;
  if (typeof value !== "string") {
    addDiagnostic(context, "binding.type", `${label} must be a name, ID, or expression${nullable ? ", or null" : ""}`, path);
    return;
  }
  const source = expressionReference(value);
  if (!source) {
    addDiagnostic(context, "reference.invalid", `Invalid ${label} expression`, path);
  } else if (source.kind === "literal") {
    resolveCatalogRef(context, index, source.value, label, path);
  } else if (resolveReference(source.value, path, scope, context)) {
    addDiagnostic(context, "binding.dynamic", `${label} must be a literal accessible name or ID`, path);
  }
};

const bindMessage = (
  value: WorkflowJsonValue | undefined,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
): void => {
  if (typeof value !== "string") return;
  if (value.includes("${{")) {
    addDiagnostic(context, "MAIL_TEMPLATE_LEGACY_SYNTAX", 'Use Liquid "{{ value }}" syntax in Mail text fields', path);
    return;
  }
  const variables = mailLiquidTemplateVariables(value);
  if (!variables.ok) {
    addDiagnostic(context, "MAIL_TEMPLATE_INVALID", variables.error.message, path);
    return;
  }
  variables.data.forEach((reference, index) => resolveReference(reference, [...path, "expression", index], scope, context));
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

const bindCondition = (
  condition: WorkflowCondition,
  path: Array<string | number>,
  scope: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
): void => {
  if (condition.operator === "all" || condition.operator === "any") {
    condition.conditions.forEach((child, index) => bindCondition(child, [...path, condition.operator, index], scope, context));
  } else if (condition.operator === "not") {
    bindCondition(condition.condition, [...path, "not"], scope, context);
  } else if (condition.operator === "exists") {
    resolveReference(condition.reference, [...path, "exists"], scope, context);
  } else {
    const operands = condition.operands.map((operand, index) => {
      const operandPath = [...path, condition.operator, index];
      const value = bindValue(operand, operandPath, scope, context);
      return { path: operandPath, value };
    });
    if (condition.operator === "includes") {
      const left = operands[0]!;
      const right = operands[1]!;
      if (left.value.kind !== "array" && left.value.type !== "core.value") {
        addDiagnostic(context, "condition.type", `includes operand 1 resolves to ${left.value.type}, expected an array`, left.path);
      } else if (
        left.value.kind === "array" &&
        left.value.items.type !== "core.value" &&
        right.value.type !== "core.value" &&
        left.value.items.type !== right.value.type
      ) {
        addDiagnostic(
          context,
          "condition.type",
          `includes operand 2 resolves to ${right.value.type}, expected ${left.value.items.type}`,
          right.path,
        );
      }
      return;
    }
    operands.forEach(({ path: operandPath, value }, index) => {
      if (
        (condition.operator === "textEquals" ||
          condition.operator === "contains" ||
          condition.operator === "startsWith" ||
          condition.operator === "endsWith") &&
        value.type !== "core.text" &&
        value.type !== "core.value"
      ) {
        addDiagnostic(
          context,
          "condition.type",
          `${condition.operator} operand ${index + 1} resolves to ${value.type}, expected core.text`,
          operandPath,
        );
      }
    });
  }
};

const bindAction = (
  step: Extract<WorkflowIrStep, { kind: "action" }>,
  scope: Map<string, ValueInfo>,
  providerTargets: Set<string>,
  context: BindingContext,
): void => {
  const path = [...step.sourcePath, step.action];
  const config = step.config;
  const outputType = actionTypes.get(step.action);
  const output = outputType ? valueDescriptor(outputType) : undefined;
  const bindProviderTarget = (field = "message"): ValueInfo | null => {
    const message = expectReference(config[field], "mail.message", field, [...path, field], scope, context);
    if (message?.providerTarget) {
      if (providerTargets.has(message.providerTarget)) {
        addDiagnostic(context, "action.sequence", "Multiple provider mutations of the same message are not supported", path);
      }
      providerTargets.add(message.providerTarget);
    }
    return message;
  };
  if (step.action === "addKeyword" || step.action === "removeKeyword") {
    bindProviderTarget();
    if (config.keyword !== undefined) bindValue(config.keyword, [...path, "keyword"], scope, context);
  } else if (step.action === "moveMessage" || step.action === "copyMessage") {
    bindProviderTarget();
    bindCatalogValue(config.folder, context.catalog.folders, "folder", [...path, "folder"], scope, context);
  } else if (step.action === "archiveMessage" || step.action === "trashMessage" || step.action === "junkMessage") {
    bindProviderTarget();
    const role = step.action === "archiveMessage" ? "archive" : step.action === "trashMessage" ? "trash" : "junk";
    const matches = [...new Map([...context.catalog.folders.refs.values()].map((folder) => [folder.id, folder])).values()].filter(
      (folder) => folder.role === role,
    );
    if (matches.length !== 1) {
      addDiagnostic(context, "binding.role", `Mailbox must expose exactly one accessible ${role} folder`, path);
    } else {
      bindId(context, [...path, "folder"], matches[0]!.id);
    }
  } else if (step.action === "addFlag" || step.action === "removeFlag") {
    bindProviderTarget();
  } else if (step.action === "assignConversation") {
    expectReference(config.conversation, "mail.conversation", "conversation", [...path, "conversation"], scope, context);
    bindCatalogValue(config.user, context.catalog.assignableUsers, "assignable user", [...path, "user"], scope, context, true);
  } else if (step.action === "setConversationStatus") {
    expectReference(config.conversation, "mail.conversation", "conversation", [...path, "conversation"], scope, context);
  } else if (step.action === "ensureConversationReference") {
    expectReference(config.conversation, "mail.conversation", "conversation", [...path, "conversation"], scope, context);
  } else if (step.action === "addLocalTag" || step.action === "removeLocalTag") {
    expectReference(config.conversation, "mail.conversation", "conversation", [...path, "conversation"], scope, context);
    bindCatalogValue(config.tag, context.catalog.localTags, "local tag", [...path, "tag"], scope, context);
  } else if (step.action === "addComment") {
    expectReference(config.conversation, "mail.conversation", "conversation", [...path, "conversation"], scope, context);
    bindMessage(config.body, [...path, "body"], scope, context);
  } else if (step.action === "createDraft") {
    bindCatalogValue(config.sender, context.catalog.senderIdentities, "sender identity", [...path, "sender"], scope, context);
    if (config.to !== undefined) bindValue(config.to, [...path, "to"], scope, context);
    if (config.cc !== undefined) bindValue(config.cc, [...path, "cc"], scope, context);
    if (config.bcc !== undefined) bindValue(config.bcc, [...path, "bcc"], scope, context);
    bindMessage(config.subject, [...path, "subject"], scope, context);
    bindMessage(config.body, [...path, "body"], scope, context);
  } else if (step.action === "createReplyDraft") {
    expectReference(config.message, "mail.message", "message", [...path, "message"], scope, context);
    expectReference(config.conversation, "mail.conversation", "conversation", [...path, "conversation"], scope, context);
    bindCatalogValue(config.sender, context.catalog.senderIdentities, "sender identity", [...path, "sender"], scope, context);
    bindMessage(config.body, [...path, "body"], scope, context);
  } else if (step.action === "scheduleDraftSend") {
    expectReference(config.draft, "mail.draft", "draft", [...path, "draft"], scope, context);
    if (config.scheduledAt !== undefined) bindValue(config.scheduledAt, [...path, "scheduledAt"], scope, context);
  } else if (step.action === "notifyUser") {
    bindCatalogValue(config.user, context.catalog.notificationUsers, "notification user", [...path, "user"], scope, context);
    bindMessage(config.title, [...path, "title"], scope, context);
    bindMessage(config.body, [...path, "body"], scope, context);
  } else if (step.action === "automaticReply") {
    if (context.ir.triggers.some((trigger) => trigger.kind !== "messageReceived")) {
      addDiagnostic(context, "automaticReply.trigger", "automaticReply requires every workflow trigger to be messageReceived", path);
    }
    expectReference(config.message, "mail.message", "message", [...path, "message"], scope, context);
    expectReference(config.conversation, "mail.conversation", "conversation", [...path, "conversation"], scope, context);
    bindCatalogValue(config.sender, context.catalog.senderIdentities, "sender identity", [...path, "sender"], scope, context);
    bindMessage(config.subject, [...path, "subject"], scope, context);
    bindMessage(config.body, [...path, "body"], scope, context);
    if (config.schedule !== undefined) {
      const schedulePath = [...path, "schedule"];
      const parsed = responseScheduleDefinitionSchema.safeParse(config.schedule);
      if (!parsed.success) {
        addDiagnostic(context, "automaticReply.schedule", parsed.error.issues[0]?.message ?? "Invalid response schedule", schedulePath);
      } else {
        for (const message of validateResponseScheduleDefinition(parsed.data)) {
          addDiagnostic(context, "automaticReply.schedule", message, schedulePath);
        }
      }
    }
  } else if (step.action === "aiGenerateText" || step.action === "aiClassify" || step.action === "aiClassifyMany") {
    if (config.prompt !== undefined) bindValue(config.prompt, [...path, "prompt"], scope, context);
    if (config.input !== undefined) bindValue(config.input, [...path, "input"], scope, context);
  } else if (step.action === "setVariable") {
    const value = bindValue(config.value!, [...path, "value"], scope, context);
    defineValue(config.name, value, [...path, "name"], scope, context);
  } else if (step.action === "succeed" || step.action === "fail") {
    bindMessage(config.message, [...path, "message"], scope, context);
  }

  if (step.action !== "setVariable" && output) defineValue(config.saveAs, output, [...path, "saveAs"], scope, context);
};

const bindSteps = (steps: WorkflowIrStep[], scope: Map<string, ValueInfo>, providerTargets: Set<string>, context: BindingContext): void => {
  for (const step of steps) {
    if (step.kind === "action") bindAction(step, scope, providerTargets, context);
    else if (step.kind === "if") {
      bindCondition(step.condition, [...step.sourcePath, "if"], scope, context);
      const thenTargets = new Set(providerTargets);
      const elseTargets = new Set(providerTargets);
      bindSteps(step.then, new Map(scope), thenTargets, context);
      bindSteps(step.else, new Map(scope), elseTargets, context);
      for (const target of [...thenTargets, ...elseTargets]) providerTargets.add(target);
    } else if (step.kind === "switch") {
      bindValue(step.value, [...step.sourcePath, "switch"], scope, context);
      const branchTargets: Set<string>[] = [];
      step.cases.forEach((item, index) => {
        bindValue(item.when, [...step.sourcePath, "cases", index, "when"], scope, context);
        const caseTargets = new Set(providerTargets);
        bindSteps(item.steps, new Map(scope), caseTargets, context);
        branchTargets.push(caseTargets);
      });
      const defaultTargets = new Set(providerTargets);
      bindSteps(step.default, new Map(scope), defaultTargets, context);
      for (const target of [...defaultTargets, ...branchTargets.flatMap((targets) => [...targets])]) providerTargets.add(target);
    } else {
      addDiagnostic(context, "step.unsupported", "forEach is not supported by the Mail workflow vocabulary", [
        ...step.sourcePath,
        "forEach",
      ]);
    }
  }
};

const bindInputs = (context: BindingContext): void => {
  const inputTypes = new Map(manifest.inputs.map((input) => [input.kind, input.valueType]));
  for (const input of context.ir.inputs) {
    const descriptor = valueDescriptor(inputTypes.get(input.type) ?? "core.value");
    context.inputs.set(input.name, {
      ...descriptor,
      ...(descriptor.type === "mail.message" ? { providerTarget: "mail.target.message" } : {}),
    });
  }
};

const typesCompatible = (expected: string, actual: string): boolean =>
  expected === actual || expected === "core.value" || (expected === "core.dateTime" && actual === "core.text");

const resolveTriggerBindingType = (
  value: WorkflowJsonValue,
  bindingPath: Array<string | number>,
  eventValues: ReadonlyMap<string, ValueInfo>,
  context: BindingContext,
): ValueInfo | null => {
  if (typeof value !== "string") return valueDescriptor("core.value");
  const parsed = parseWorkflowValueString(value);
  if (parsed.kind === "invalid") {
    addDiagnostic(context, "reference.invalid", "Invalid trigger binding expression", bindingPath);
    return null;
  }
  if (parsed.kind !== "expression") return textValue;
  if (parsed.expression.kind !== "reference") return dateTimeValue;
  return resolveReference(parsed.expression.reference, bindingPath, new Map(), context, eventValues);
};

const bindTrigger = (
  trigger: WorkflowIr["triggers"][number],
  descriptor: (typeof manifest.triggers)[number],
  context: BindingContext,
): void => {
  const path = ["triggers", trigger.kind] as Array<string | number>;
  if (trigger.kind === "schedule") {
    try {
      normalizeWorkflowSchedule({
        cron: String(trigger.config.cron ?? ""),
        timezone: typeof trigger.config.timezone === "string" ? trigger.config.timezone : "UTC",
      });
    } catch (error) {
      addDiagnostic(context, "trigger.schedule", error instanceof Error ? error.message : "Invalid workflow schedule", [...path, "cron"]);
    }
  }
  const eventValues = new Map(Object.entries(descriptor.eventValues).map(([name, type]) => [name, valueDescriptor(type)]));
  for (const input of context.ir.inputs) {
    if (input.config.required === true && trigger.with[input.name] === undefined) {
      addDiagnostic(context, "trigger.required", `Trigger must bind required input "${input.name}"`, [...path, "with", input.name]);
    }
  }
  for (const [inputName, value] of Object.entries(trigger.with)) {
    const input = context.inputs.get(inputName);
    if (!input) continue;
    const bindingPath = [...path, "with", inputName];
    const actual = resolveTriggerBindingType(value, bindingPath, eventValues, context);
    if (actual && !typesCompatible(input.type, actual.type)) {
      addDiagnostic(context, "trigger.type", `Trigger value has type ${actual.type}, expected ${input.type}`, bindingPath);
    }
  }
};

const bindTriggers = (context: BindingContext): void => {
  const descriptors = new Map(manifest.triggers.map((trigger) => [trigger.kind, trigger]));
  for (const trigger of context.ir.triggers) {
    const descriptor = descriptors.get(trigger.kind);
    if (descriptor) bindTrigger(trigger, descriptor, context);
  }
};

export const bindMailWorkflow = async (ir: WorkflowIr, catalog: MailWorkflowCatalog): Promise<BindMailWorkflowResult> => {
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
  const context: BindingContext = { ir, catalog, inputs: new Map(), bindings: {}, diagnostics: [] };
  bindInputs(context);
  bindTriggers(context);
  bindSteps(ir.steps, new Map(), new Set(), context);
  if (context.diagnostics.length > 0) return { ok: false, diagnostics: context.diagnostics };

  const plan = await bindWorkflow(ir, mailWorkflows, () => ({
    catalog: snapshotMailWorkflowCatalog(catalog),
    bindings: context.bindings,
  }));
  return { ok: true, plan };
};

const emptyCatalog = buildMailWorkflowCatalog({
  folders: [],
  assignableUsers: [],
  senderIdentities: [],
  localTags: [],
  notificationUsers: [],
});

export const validateMailWorkflowTemplateReferences = async (ir: WorkflowIr): Promise<WorkflowDiagnostic[]> => {
  const bound = await bindMailWorkflow(ir, emptyCatalog);
  if (bound.ok) return [];
  return bound.diagnostics.filter((diagnostic) => diagnostic.path.includes("expression"));
};
