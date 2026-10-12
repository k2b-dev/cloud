import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { createIncomingAutomationSchema, type MailAutomationConditions, type MailAutomationStep } from "../../contracts";
import type { IncomingAutomation } from "../../service/incoming-automations";
import type { MailWorkflowCatalogSnapshot } from "../../workflows/catalog";
import { initialMailAutomationAction } from "./mail-automation-actions";

const mailboxId = "Box001";
const now = "2026-08-21T21:00:00.000Z";
const catalog: MailWorkflowCatalogSnapshot = { folders: [], assignableUsers: [] };

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(20);
};

describe("Mail automation builder interactions", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  afterEach(async () => {
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    await settle();
  });

  test("keeps the AI instructions editor mounted while typing", async () => {
    const dom = createDomTestHarness();
    const automation: IncomingAutomation = {
      id: "Auto01",
      mailboxId,
      workflowId: "00000000-0000-4000-8000-000000000001",
      workflowVersionId: "00000000-0000-4000-8000-000000000002",
      name: "Draft replies",
      enabled: false,
      scope: { mode: "all" },
      steps: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          kind: "ai_generate_text",
          instructions: "Write a reply.",
          maxOutputChars: 4_000,
        },
      ],
      latestBackfillOperationId: null,
      workflowSource: "steps: []",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { dialogCore } = await import("@k2b/ui");
    const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
    const result = openIncomingAutomationEditor({ mailboxId, catalog, automation, onSaved: () => {} });
    try {
      await settle();
      const instructions = dom.document.querySelector("textarea");
      expect(instructions).not.toBeNull();
      instructions!.focus();
      instructions!.value = "Write a concise reply.";
      instructions!.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();

      expect(dom.document.activeElement).toBe(instructions);
      expect(dom.document.querySelector("textarea")).toBe(instructions);
      expect(instructions!.value).toBe("Write a concise reply.");
      const maximum = dom.document.querySelector<HTMLInputElement>('input[role="spinbutton"]');
      let fieldStack = instructions!.parentElement;
      while (fieldStack && maximum && !fieldStack.contains(maximum)) fieldStack = fieldStack.parentElement;
      expect(maximum).not.toBeNull();
      expect(fieldStack?.className).toContain("flex flex-col gap-2");
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  test("styles Add condition as an input and reorders the same condition rows repeatedly", async () => {
    const dom = createDomTestHarness();
    const [conditions, setConditions] = createSignal<MailAutomationConditions>({
      mode: "all",
      items: [
        { field: "subject", operator: "contains", value: "Alpha" },
        { field: "subject", operator: "contains", value: "Beta" },
      ],
    });
    const { MailAutomationConditionsEditor } = await import("./MailAutomationFields");
    const { render } = await import("solid-js/web");
    const dispose = render(
      () =>
        createComponent(MailAutomationConditionsEditor, {
          get conditions() {
            return conditions();
          },
          onChange: setConditions,
        }),
      dom.document.body,
    );
    try {
      await settle();
      const add = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.includes("Add condition"));
      expect(add?.dataset.variant).toBe("input");

      const values = () => Array.from(dom.document.querySelectorAll<HTMLInputElement>('input[type="text"]')).map((input) => input.value);
      const moveFirstDown = () => dom.document.querySelector<HTMLButtonElement>('button[aria-label="Move condition 1 down"]')!.click();
      expect(dom.document.querySelector('[role="group"][aria-label="Condition 1"]')).not.toBeNull();
      expect(dom.document.querySelector('[role="group"][aria-label="Condition 2"]')).not.toBeNull();
      expect(values()).toEqual(["Alpha", "Beta"]);
      moveFirstDown();
      await settle();
      expect(values()).toEqual(["Beta", "Alpha"]);
      moveFirstDown();
      await settle();
      expect(values()).toEqual(["Alpha", "Beta"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("offers exclusion operators for sender and text conditions", async () => {
    const dom = createDomTestHarness();
    const [conditions, setConditions] = createSignal<MailAutomationConditions>({
      mode: "all",
      items: [
        { field: "sender_domain", operator: "is_not", value: "example.com" },
        { field: "subject", operator: "not_contains", value: "Invoice" },
      ],
    });
    const { MailAutomationConditionsEditor, mailAutomationConditionLabel } = await import("./MailAutomationFields");
    const { render } = await import("solid-js/web");
    const dispose = render(
      () =>
        createComponent(MailAutomationConditionsEditor, {
          get conditions() {
            return conditions();
          },
          onChange: setConditions,
        }),
      dom.document.body,
    );
    try {
      await settle();
      const groups = Array.from(dom.document.querySelectorAll('[role="group"][aria-label^="Condition"]'));
      expect(groups[0]?.textContent).toContain("is not");
      expect(groups[1]?.textContent).toContain("does not contain");
      expect(mailAutomationConditionLabel(conditions().items[0]!)).toBe("Not from *@example.com");
      expect(mailAutomationConditionLabel(conditions().items[0]!, "de")).toBe("Nicht von *@example.com");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("keeps classifier consumers valid while choices change and protects used choices", async () => {
    const dom = createDomTestHarness();
    const automation: IncomingAutomation = {
      id: "Auto02",
      mailboxId,
      workflowId: "00000000-0000-4000-8000-000000000010",
      workflowVersionId: "00000000-0000-4000-8000-000000000011",
      name: "Route mail",
      enabled: false,
      scope: { mode: "all" },
      steps: [
        {
          id: "00000000-0000-4000-8000-000000000012",
          kind: "ai_classify",
          instructions: "Classify this message.",
          choices: [
            { name: "Important", description: "Needs attention" },
            { name: "Routine", description: "Routine mail" },
            { name: "Ignore", description: "No action needed" },
          ],
        },
        {
          id: "00000000-0000-4000-8000-000000000013",
          kind: "if",
          condition: { sourceStepId: "00000000-0000-4000-8000-000000000012", operator: "equals", value: "Important" },
          then: [],
          else: [],
        },
      ],
      latestBackfillOperationId: null,
      workflowSource: "steps: []",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { dialogCore } = await import("@k2b/ui");
    const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
    const result = openIncomingAutomationEditor({ mailboxId, catalog, automation, onSaved: () => {} });
    try {
      await settle();
      const choiceLabel = Array.from(dom.document.querySelectorAll("label")).find((label) => label.textContent?.includes("Choice 1"));
      const choiceInput = choiceLabel?.htmlFor ? dom.document.getElementById(choiceLabel.htmlFor) : null;
      expect(choiceInput).toBeInstanceOf(dom.window.HTMLInputElement);
      (choiceInput as HTMLInputElement).value = "Urgent";
      choiceInput!.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();

      const save = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Save changes"),
      );
      expect(save?.disabled).toBe(false);
      const addCondition = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Add condition"),
      );
      expect(addCondition?.dataset.variant).toBe("input");

      dom.document.querySelector<HTMLButtonElement>('button[aria-label^="Remove choice 1"]')!.click();
      await settle();
      expect(dom.document.body.textContent).toContain("Change or remove the conditions that use this choice");
      expect((choiceInput as HTMLInputElement).value).toBe("Urgent");
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  test("prevents removing an output producer while later steps use it", async () => {
    const dom = createDomTestHarness();
    const automation: IncomingAutomation = {
      id: "Auto05",
      mailboxId,
      workflowId: "00000000-0000-4000-8000-000000000070",
      workflowVersionId: "00000000-0000-4000-8000-000000000071",
      name: "Protected output",
      enabled: false,
      scope: { mode: "all" },
      steps: [
        {
          id: "00000000-0000-4000-8000-000000000072",
          kind: "ai_generate_text",
          instructions: "Write a summary.",
          maxOutputChars: 4_000,
        },
        {
          id: "00000000-0000-4000-8000-000000000073",
          kind: "set_summary",
          body: { kind: "step_output", sourceStepId: "00000000-0000-4000-8000-000000000072" },
        },
      ],
      latestBackfillOperationId: null,
      workflowSource: "steps: []",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { dialogCore } = await import("@k2b/ui");
    const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
    const result = openIncomingAutomationEditor({ mailboxId, catalog, automation, onSaved: () => {} });
    try {
      await settle();
      dom.document.querySelector<HTMLButtonElement>('button[aria-label^="Remove AI generate text step 1"]')!.click();
      await settle();
      expect(dom.document.body.textContent).toContain("Change or remove the later steps that use this output");
      expect(dom.document.querySelector('button[aria-label^="Remove AI generate text step 1"]')).not.toBeNull();
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  test("disables insertion shortcuts at the top-level limit and explains invalid legacy limits", async () => {
    const dom = createDomTestHarness();
    const steps: IncomingAutomation["steps"] = [
      {
        id: "00000000-0000-4000-8000-000000000020",
        kind: "ai_generate_text",
        instructions: "Write text.",
        maxOutputChars: 4_000,
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 21).padStart(12, "0")}`,
        kind: "add_comment" as const,
        body: { kind: "custom" as const, value: `Comment ${index + 1}` },
      })),
    ];
    const automation: IncomingAutomation = {
      id: "Auto03",
      mailboxId,
      workflowId: "00000000-0000-4000-8000-000000000050",
      workflowVersionId: "00000000-0000-4000-8000-000000000051",
      name: "Full flow",
      enabled: false,
      scope: { mode: "all" },
      steps,
      latestBackfillOperationId: null,
      workflowSource: "steps: []",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { dialogCore } = await import("@k2b/ui");
    const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
    const result = openIncomingAutomationEditor({ mailboxId, catalog, automation, onSaved: () => {} });
    try {
      await settle();
      const useOutput = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Use output"),
      );
      expect(useOutput?.disabled).toBe(true);
      expect(dom.document.body.textContent).toContain("Use at most 20 top-level steps.");
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  test("keeps non-AI additions available after the AI-call limit is reached", async () => {
    const dom = createDomTestHarness();
    const automation: IncomingAutomation = {
      id: "Auto06",
      mailboxId,
      workflowId: "00000000-0000-4000-8000-000000000080",
      workflowVersionId: "00000000-0000-4000-8000-000000000081",
      name: "AI limit",
      enabled: false,
      scope: { mode: "all" },
      steps: Array.from({ length: 10 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 82).padStart(12, "0")}`,
        kind: "ai_generate_text" as const,
        instructions: `Generate text ${index + 1}.`,
        maxOutputChars: 4_000,
      })),
      latestBackfillOperationId: null,
      workflowSource: "steps: []",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { dialogCore } = await import("@k2b/ui");
    const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
    const result = openIncomingAutomationEditor({ mailboxId, catalog, automation, onSaved: () => {} });
    try {
      await settle();
      const addStep = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Add step"),
      );
      expect(addStep).not.toBeUndefined();
      addStep!.click();
      await settle();
      const menu = dom.document.querySelector('[role="menu"]');
      expect(menu?.textContent).toContain("Add internal comment");
      expect(menu?.textContent).not.toContain("AI generate text");
      expect(menu?.textContent).not.toContain("AI classify");
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  test("puts Mark as read in front of an existing move", async () => {
    const dom = createDomTestHarness();
    const folders: MailWorkflowCatalogSnapshot = {
      folders: [
        { id: "Fold01", name: "Inbox", role: "inbox" },
        { id: "Fold02", name: "Newsletters" },
      ],
      assignableUsers: [],
    };
    const automation: IncomingAutomation = {
      id: "Auto09",
      mailboxId,
      workflowId: "00000000-0000-4000-8000-000000000120",
      workflowVersionId: "00000000-0000-4000-8000-000000000121",
      name: "File newsletters",
      enabled: false,
      scope: { mode: "all" },
      steps: [{ id: "00000000-0000-4000-8000-000000000122", kind: "mail_action", action: { kind: "move_to_folder", folderId: "Fold02" } }],
      latestBackfillOperationId: null,
      workflowSource: "steps: []",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { dialogCore } = await import("@k2b/ui");
    const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
    const result = openIncomingAutomationEditor({ mailboxId, catalog: folders, automation, onSaved: () => {} });
    try {
      await settle();
      const stepKinds = () =>
        Array.from(dom.document.querySelectorAll("strong + span"))
          .map((element) => element.textContent)
          .filter((text) => text === "Mark as read" || text === "Move to folder");
      expect(stepKinds()).toEqual(["Move to folder"]);
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("Add step"))!
        .click();
      await settle();
      const menu = dom.document.querySelector('[role="menu"]');
      expect(menu?.textContent).not.toContain("Move to folder");
      Array.from(menu!.querySelectorAll<HTMLElement>("button, [role='menuitem']"))
        .find((item) => item.textContent?.includes("Mark as read"))!
        .click();
      await settle();
      expect(stepKinds()).toEqual(["Mark as read", "Move to folder"]);
      // Moving Mark as read below the move would change the message after it left its folder.
      const firstStepDown = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button[aria-label]")).find((button) =>
        /^Move .* down$/.test(button.getAttribute("aria-label") ?? ""),
      );
      expect(firstStepDown?.disabled).toBe(true);
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  for (const branch of ["then", "else"] as const) {
    test(`protects nested ${branch} replacements and additions from later parent provider actions`, async () => {
      const dom = createDomTestHarness();
      const classifierId = crypto.randomUUID();
      const nestedCatalog: MailWorkflowCatalogSnapshot = {
        folders: [{ id: "Fold01", name: "Archive" }],
        assignableUsers: [{ id: "00000000-0000-4000-8000-000000000150", name: "Alice" }],
        localTags: [{ id: "Tag001", name: "Important" }],
      };
      const assignment: MailAutomationStep = {
        id: crypto.randomUUID(),
        kind: "mail_action",
        action: { kind: "assign_user", userId: "00000000-0000-4000-8000-000000000150" },
      };
      const condition = { sourceStepId: classifierId, operator: "equals" as const, value: "Important" };
      const inner: Extract<MailAutomationStep, { kind: "if" }> = {
        id: crypto.randomUUID(),
        kind: "if",
        condition,
        then: [],
        else: [],
        [branch]: [assignment],
      };
      const outer: Extract<MailAutomationStep, { kind: "if" }> = {
        id: crypto.randomUUID(),
        kind: "if",
        condition,
        then: [],
        else: [],
        [branch]: [inner],
      };
      const automation: IncomingAutomation = {
        id: "Auto10",
        mailboxId,
        workflowId: crypto.randomUUID(),
        workflowVersionId: crypto.randomUUID(),
        name: "Nested read",
        enabled: false,
        scope: { mode: "all" },
        steps: [
          {
            id: classifierId,
            kind: "ai_classify",
            instructions: "Classify mail.",
            choices: [
              { name: "Important", description: "Needs attention" },
              { name: "Routine", description: "Routine mail" },
            ],
          },
          outer,
          { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } },
        ],
        latestBackfillOperationId: null,
        workflowSource: "steps: []",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const { dialogCore } = await import("@k2b/ui");
      const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
      const result = openIncomingAutomationEditor({ mailboxId, catalog: nestedCatalog, automation, onSaved: () => {} });
      try {
        await settle();
        dom.document.querySelector<HTMLButtonElement>('button[aria-label^="Expand If step 2"]')!.click();
        await settle();
        // The first step of each branch starts expanded, including the inner if and assignment.
        const label = Array.from(dom.document.querySelectorAll("label")).find((element) => element.textContent === "Mail action");
        const select = dom.document.getElementById(label!.htmlFor)!;
        select.click();
        await settle();
        const labels = Array.from(dom.document.querySelectorAll(`[id="${select.getAttribute("aria-controls")}"] [role="option"]`)).map(
          (option) => option.textContent?.trim(),
        );
        expect(labels).toEqual(["Add tag", "Assign user", "Set status"]);
        for (const kind of ["add_local_tag", "assign_user", "set_status"] as const) {
          const replacement = { ...assignment, action: initialMailAutomationAction(kind, nestedCatalog) };
          const steps = [automation.steps[0], { ...outer, [branch]: [{ ...inner, [branch]: [replacement] }] }, automation.steps[2]];
          const parsed = createIncomingAutomationSchema.safeParse({ name: automation.name, scope: automation.scope, steps });
          expect(parsed.error?.issues).toBeUndefined();
        }
        select.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        const addButtons = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).filter(
          (button) => button.textContent?.trim() === "Add step",
        );
        // All branch menus inherit the trailing mark_read; the last button belongs to the top level.
        expect(addButtons).toHaveLength(5);
        const paths: Array<Array<"then" | "else">> =
          branch === "then"
            ? [["then", "then"], ["then", "else"], ["then"], ["else"]]
            : [["then"], ["else", "then"], ["else", "else"], ["else"]];
        for (const [index, add] of addButtons.slice(0, -1).entries()) {
          add.click();
          await settle();
          const menu = dom.document.getElementById(add.getAttribute("aria-controls")!)!;
          expect(menu).not.toBeNull();
          expect(menu.textContent).not.toContain("Move to folder");
          expect(menu.textContent).not.toContain("Move to Junk");
          expect(menu.textContent).not.toContain("Move to Trash");
          const offered = Array.from(menu.querySelectorAll('[role="menuitem"]'))
            .map((item) => item.textContent?.trim() ?? "")
            .filter((text) => text.startsWith("Mail action · "));
          expect(offered.length).toBeGreaterThan(0);
          for (const label of offered) {
            const kind =
              label === "Mail action · Add tag"
                ? "add_local_tag"
                : label === "Mail action · Assign user"
                  ? "assign_user"
                  : label === "Mail action · Set status"
                    ? "set_status"
                    : null;
            if (!kind) throw new Error(`Unexpected nested mail action: ${label}`);
            const steps = structuredClone(automation.steps);
            let destination = steps;
            for (const direction of paths[index]!) {
              const conditionStep = destination.find((step) => step.kind === "if");
              if (!conditionStep || conditionStep.kind !== "if") throw new Error("Missing nested fixture branch");
              destination = conditionStep[direction];
            }
            destination.push({ id: crypto.randomUUID(), kind: "mail_action", action: initialMailAutomationAction(kind, nestedCatalog) });
            const parsed = createIncomingAutomationSchema.safeParse({ name: automation.name, scope: automation.scope, steps });
            expect(parsed.error?.issues).toBeUndefined();
          }
          menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          await settle();
        }
      } finally {
        dialogCore.close();
        await result;
        dom.cleanup();
      }
    });
  }

  for (const preset of ["AI classify", "AI classify many"] as const) {
    test(`keeps the nested ${preset} fallback before a later parent move`, async () => {
      const dom = createDomTestHarness();
      const classifierId = crypto.randomUUID();
      const userId = "00000000-0000-4000-8000-000000000160";
      // Status, assignment and Mark as read are used, there is no free tag, and a move follows the branch:
      // the only fallback left would be a second placement on the same path.
      const fallbackCatalog: MailWorkflowCatalogSnapshot = {
        folders: [{ id: "Fold01", name: "Archive" }],
        assignableUsers: [{ id: userId, name: "Alice" }],
        localTags: [],
      };
      const automation: IncomingAutomation = {
        id: "Auto11",
        mailboxId,
        workflowId: crypto.randomUUID(),
        workflowVersionId: crypto.randomUUID(),
        name: "Nested classifier",
        enabled: false,
        scope: { mode: "all" },
        steps: [
          { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "set_status", status: "done" } },
          { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "assign_user", userId } },
          { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } },
          {
            id: classifierId,
            kind: "ai_classify",
            instructions: "Classify mail.",
            choices: [
              { name: "Important", description: "Needs attention" },
              { name: "Routine", description: "Routine mail" },
            ],
          },
          {
            id: crypto.randomUUID(),
            kind: "if",
            condition: { sourceStepId: classifierId, operator: "equals", value: "Important" },
            then: [{ id: crypto.randomUUID(), kind: "add_comment", body: { kind: "custom", value: "Check this." } }],
            else: [],
          },
          { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "move_to_folder", folderId: "Fold01" } },
        ],
        latestBackfillOperationId: null,
        workflowSource: "steps: []",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const { dialogCore } = await import("@k2b/ui");
      const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
      const result = openIncomingAutomationEditor({ mailboxId, catalog: fallbackCatalog, automation, onSaved: () => {} });
      try {
        await settle();
        dom.document.querySelector<HTMLButtonElement>('button[aria-label^="Expand If step 5"]')!.click();
        await settle();
        const add = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent?.trim() === "Add step",
        )!;
        add.click();
        await settle();
        const menu = dom.document.getElementById(add.getAttribute("aria-controls")!)!;
        Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
          .find((item) => item.textContent?.trim() === preset)!
          .click();
        await settle();
        const moves = Array.from(dom.document.querySelectorAll("strong + span")).filter(
          (element) => element.textContent === "Move to folder",
        );
        expect(moves).toHaveLength(1);
        // The editor validates with createIncomingAutomationSchema and only then enables saving.
        expect(dom.document.body.textContent).not.toContain("Put Mark as read and keyword changes before moving the message");
        const save = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
          button.textContent?.includes("Save changes"),
        );
        expect(save?.disabled).toBe(false);
      } finally {
        dialogCore.close();
        await result;
        dom.cleanup();
      }
    });
  }

  test("blocks additions in branches after the global step limit is reached", async () => {
    const dom = createDomTestHarness();
    const comments = (start: number, length: number): IncomingAutomation["steps"] =>
      Array.from({ length }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(start + index).padStart(12, "0")}`,
        kind: "add_comment" as const,
        body: { kind: "custom" as const, value: `Comment ${start + index}` },
      }));
    const classifierId = "00000000-0000-4000-8000-000000000100";
    const automation: IncomingAutomation = {
      id: "Auto07",
      mailboxId,
      workflowId: "00000000-0000-4000-8000-000000000101",
      workflowVersionId: "00000000-0000-4000-8000-000000000102",
      name: "Global limit",
      enabled: false,
      scope: { mode: "all" },
      steps: [
        {
          id: classifierId,
          kind: "ai_classify",
          instructions: "Classify this message.",
          choices: [
            { name: "Important", description: "Needs attention" },
            { name: "Routine", description: "Routine mail" },
          ],
        },
        {
          id: "00000000-0000-4000-8000-000000000103",
          kind: "if",
          condition: { sourceStepId: classifierId, operator: "equals", value: "Important" },
          then: comments(104, 10),
          else: comments(114, 10),
        },
        ...comments(124, 18),
      ],
      latestBackfillOperationId: null,
      workflowSource: "steps: []",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { dialogCore } = await import("@k2b/ui");
    const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
    const result = openIncomingAutomationEditor({ mailboxId, catalog, automation, onSaved: () => {} });
    try {
      await settle();
      dom.document.querySelector<HTMLButtonElement>('button[aria-label^="Expand If step 2"]')!.click();
      await settle();
      const addSteps = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).filter((button) =>
        button.textContent?.includes("Add step"),
      );
      expect(addSteps).toHaveLength(0);
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  test("keeps Spaces references read-only and offers the existing pickers for changes", async () => {
    const dom = createDomTestHarness();
    const automation: IncomingAutomation = {
      id: "Auto04",
      mailboxId,
      workflowId: "00000000-0000-4000-8000-000000000060",
      workflowVersionId: "00000000-0000-4000-8000-000000000061",
      name: "Spaces flow",
      enabled: false,
      scope: { mode: "all" },
      steps: [
        { id: "00000000-0000-4000-8000-000000000062", kind: "link_space_item", itemId: "Item01" },
        {
          id: "00000000-0000-4000-8000-000000000063",
          kind: "ai_extract_event",
          instructions: "Extract event data.",
          timeZone: "Europe/Berlin",
        },
        {
          id: "00000000-0000-4000-8000-000000000064",
          kind: "create_space_event",
          spaceId: "Space1",
          columnId: "Col001",
          event: { kind: "step_output", sourceStepId: "00000000-0000-4000-8000-000000000063" },
        },
      ],
      latestBackfillOperationId: null,
      workflowSource: "steps: []",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { dialogCore } = await import("@k2b/ui");
    const { openIncomingAutomationEditor } = await import("./MailIncomingAutomationSettings");
    const result = openIncomingAutomationEditor({ mailboxId, catalog, automation, onSaved: () => {} });
    try {
      await settle();
      dom.document.querySelector<HTMLButtonElement>('button[aria-label^="Expand Create Spaces event step 3"]')!.click();
      await settle();
      const readOnlyValues = Array.from(dom.document.querySelectorAll<HTMLInputElement>("input[readonly]")).map((input) => input.value);
      expect(readOnlyValues).toEqual(expect.arrayContaining(["Item01", "Space1", "Col001"]));
      expect(dom.document.body.textContent).toContain("Change item");
      expect(dom.document.body.textContent).toContain("Change destination");
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });
});
