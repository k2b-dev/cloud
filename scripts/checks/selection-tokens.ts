import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule, RuleContext } from "./rule";

type Kind = "selection" | "accent-mix" | "accent-raw" | "selected-button";
export type SelectionFinding = Finding & { file: string; line: number; kind: Kind; subject: string };
export type SelectionAllowance = { file: string; subject: string; reason: string };

/** CSS subjects match exactly; TS/TSX subjects match a substring of the trimmed source line. */
export const SELECTION_ALLOWLIST: readonly SelectionAllowance[] = [
  {
    file: "packages/pulse/src/frontend/workspace/base-settings-dialog.tsx",
    subject: 'background: "var(--k2b-selected)",',
    reason:
      "Control: the three retention preset groups select scalar form values, not navigation or objects; each button exposes aria-pressed.",
  },
  {
    file: "packages/core/src/pages/me/AppDevices.island.tsx",
    subject: 'variant={touch() ? "primary" : "secondary"}',
    reason: "Action: copying the pairing link is the link step's main action on touch devices.",
  },
  {
    file: "packages/grids/src/frontend/_components/custom-apps/CustomAppBlockPreview.tsx",
    subject: 'variant={action.kind === "workflow" ? "primary" : "secondary"}',
    reason: "Action preview: the disabled configured workflow action retains its primary emphasis.",
  },
  {
    file: "packages/cloud/src/styles/tokens.css",
    subject: ":root { --ui-pagination-current-surface }",
    reason: "Token owner: Cloud defines the platform pagination role here.",
  },
  {
    file: "packages/cloud/src/styles/tokens.css",
    subject: ".dark { --ui-app-accent-border }",
    reason: "Token owner: Cloud defines the AA-checked app border role here.",
  },
  {
    file: "packages/cloud/src/styles/tokens.css",
    subject: ".dark :is(.cloud-app-canvas, .app-accent-scope) { --ui-app-accent-border }",
    reason: "Token owner: Cloud defines the AA-checked app border role in each app scope.",
  },
  {
    file: "packages/cloud/src/styles/resource-search.css",
    subject: ".cloud-resource-search__tag { background }",
    reason: "Control: the scope chip in the search field is a filter.",
  },
  {
    file: "packages/cloud/src/styles/resource-search.css",
    subject: ".cloud-resource-search__result.is-active { background }",
    reason: "Control: the keyboard-active option of the result listbox; a picked result uses the app fill.",
  },
  {
    file: "packages/cloud/src/styles/resource-search.css",
    subject: ".cloud-resource-search__tag-option:hover, .cloud-resource-search__tag-option.is-active { background }",
    reason: "Control: these are options in the tag picker.",
  },
  {
    file: "packages/cloud/src/styles/utilities-buttons.css",
    subject: "@utility btn-input-active { @apply }",
    reason: "Control: pressed state of an input-like control.",
  },
  {
    file: "packages/cloud/src/styles/utilities-buttons.css",
    subject: "@utility btn-input-primary { @apply }",
    reason: "Control: hover and active press feedback of an input-like button.",
  },
  {
    file: "packages/cloud/src/styles/utilities-buttons.css",
    subject: '.icon-btn[aria-pressed="true"] { @apply }',
    reason: "Control: pressed toggle button.",
  },
  {
    file: "packages/cloud/src/styles/utilities-buttons.css",
    subject: '.icon-btn[aria-pressed="true"]:hover { @apply }',
    reason: "Control: hover feedback of a pressed toggle button.",
  },
  {
    file: "packages/cloud/src/styles/utilities-buttons.css",
    subject: '.checkbox-card[data-state="checked"] { background }',
    reason: "Control: checked checkbox card.",
  },
  {
    file: "packages/cloud/src/styles/utilities-markdown-editor.css",
    subject: '.md-editor-tool[aria-pressed="true"] { @apply }',
    reason: "Control: pressed formatting toolbar button.",
  },
  {
    file: "packages/cloud/src/styles/utilities-markdown-editor.css",
    subject: '.md-editor-tool[aria-pressed="true"]:hover { @apply }',
    reason: "Control: hover feedback of a pressed formatting toolbar button.",
  },
  {
    file: "packages/cloud/src/styles/global.css",
    subject: ".dark .cloud-app-canvas { --cloud-shell-selected }",
    reason: "Shell frame: owned by shell-soft-white-canvas.",
  },
  {
    file: "packages/cloud/src/styles/global.css",
    subject: ".dark .cloud-app-canvas[data-layout-authenticated] > .layout-rail { box-shadow }",
    reason: "Shell frame: owned by shell-soft-white-canvas.",
  },
  {
    file: "packages/cloud/src/styles/utilities-navigation.css",
    subject: "@utility rail-item-active { border }",
    reason: "Shell frame: owned by shell-soft-white-canvas.",
  },
  {
    file: "packages/cloud/src/styles/utilities-navigation.css",
    subject: "@utility rail-item-active { color }",
    reason: "Shell frame: owned by shell-soft-white-canvas.",
  },
  {
    file: "packages/cloud/src/styles/utilities-navigation.css",
    subject: ".rail-item-active:hover { color }",
    reason: "Shell frame: owned by shell-soft-white-canvas.",
  },
  {
    file: "packages/cloud/src/styles/utilities-navigation.css",
    subject: ".dark .rail-item-active { border-color }",
    reason: "Shell frame: owned by shell-soft-white-canvas.",
  },
  {
    file: "packages/cloud/src/styles/utilities-navigation.css",
    subject: ".dark .rail-item-active { color }",
    reason: "Shell frame: owned by shell-soft-white-canvas.",
  },
  {
    file: "packages/cloud/src/styles/utilities-navigation.css",
    subject: ".dark .rail-item-active:hover { color }",
    reason: "Shell frame: owned by shell-soft-white-canvas.",
  },
  {
    file: "packages/core/src/styles/app.css",
    subject: ".k2b-ui .ai-usage-filter--active .k2b-choice-trigger { background }",
    reason: "Control: the trigger of a select that shows its applied filter value; select controls keep the platform fill.",
  },
  {
    file: "packages/core/src/pages/admin/settings/_components/LegalSettingsForm.island.tsx",
    subject: '? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"',
    reason: "Status: custom value-source badge.",
  },
  {
    file: "packages/core/src/pages/admin/settings/_components/CoreSettingsForm.island.tsx",
    subject: '? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"',
    reason: "Status: custom value-source badge.",
  },
  {
    file: "packages/core/src/pages/admin/announcements/page.tsx",
    subject: 'scheduled: { label: t.scheduled, class: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },',
    reason: "Status: scheduled announcement badge.",
  },
  {
    file: "packages/core/src/pages/me/notification-ui.ts",
    subject: 'return { label: t.sending, class: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" };',
    reason: "Status: notification is sending.",
  },
  {
    file: "packages/core/src/pages/me/NotificationPreferences.island.tsx",
    subject: 'class={`tag ${customized() ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"',
    reason: "Status: customized preferences tag.",
  },
  {
    file: "packages/core/src/pages/me/AccountHub.tsx",
    subject: '? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"',
    reason: "Status: admin role tag in the roleClass admin branch.",
  },
  {
    file: "packages/core/src/pages/me/access.page.tsx",
    subject: 'class="tag bg-blue-100 text-blue-700 transition-colors hover:text-primary dark:bg-blue-900/50 dark:text-blue-300"',
    reason: "Status: managed-group tag link.",
  },
  {
    file: "packages/core/src/pages/me/access.page.tsx",
    subject: '<span class="tag bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">',
    reason: "Status: managed-group tag.",
  },
  {
    file: "packages/mail/src/styles/app.css",
    subject: ".mail-compose-action, .mail-compose-action + .k2b-split-button__menu-trigger { --k2b-action-solid }",
    reason: "Primary action: the one filled action in the app color (workspace R5).",
  },
  {
    file: "packages/mail/src/styles/app.css",
    subject: ".mail-compose-action, .mail-compose-action + .k2b-split-button__menu-trigger { --k2b-action-solid-hover }",
    reason: "Primary action: the one filled action in the app color (workspace R5).",
  },
  {
    file: "packages/mail/src/frontend/_components/MailSidebar.tsx",
    subject: 'class={dropFolderId() === folder.id ? "bg-[var(--ui-selected)]" : undefined}',
    reason: "Control: drop target under a dragged message.",
  },
  {
    file: "packages/mail/src/styles/app.css",
    subject: '.k2b-ui .mail-reader-toolbar .mail-reader-details[aria-expanded="true"] { background }',
    reason: "Control: expanded disclosure.",
  },
  {
    file: "packages/grids/src/frontend/_components/fields/FormulaReferenceWindow.island.tsx",
    subject: 'class: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200",',
    reason: "Data: field type color.",
  },
  {
    file: "packages/gateway-ops/src/observability/notifications/page.tsx",
    subject: '? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200"',
    reason: "Data: notification channel color; the chip shows the channel icon and name.",
  },
  {
    file: "packages/oauth/src/frontend/page.tsx",
    subject: '? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"',
    reason: "Data: client type color; the chip names the type (public or confidential).",
  },
  {
    file: "packages/tools/src/frontend/tools/WebhookTester.island.tsx",
    subject: 'if (method === "GET") return "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";',
    reason: "Data: HTTP method color; the chip names the method.",
  },
  {
    file: "packages/spaces/src/frontend/[id]/_components/kanban/KanbanBoard.tsx",
    subject: 'isColumnTargetActive(key) ? "bg-[var(--ui-selected)]" : "hover:bg-[var(--ui-hover)]"',
    reason: "Control: drop target under a dragged card.",
  },
  {
    file: "packages/spaces/src/frontend/[id]/_components/kanban/KanbanBoard.tsx",
    subject: 'isColumnTargetActive(key) ? "bg-[var(--ui-selected)]" : "bg-transparent"',
    reason: "Control: drop target under a dragged card.",
  },
  {
    file: "packages/spaces/src/frontend/[id]/_components/kanban/KanbanBoard.tsx",
    subject: 'active() ? "bg-[var(--ui-selected)]" : ""',
    reason: "Control: drop target under a dragged card.",
  },
];

const BASELINE = "scripts/checks/selection-tokens.baseline";
const messages: Record<Kind, string> = {
  "selected-button":
    "Use ViewTabs, Tabs, SegmentedControl, FilterChip or FilterToggle for a selection; allowlist a real action in scripts/checks/selection-tokens.ts with a reason. selected-button cannot be baselined",
  "accent-raw":
    "Use --ui-app-accent-text (or app-accent-text) for ink, the platform focus (--ui-focus, focus-ui, --k2b-focus-ring) for rings, and --ui-app-accent-border for an app-colored border",
  selection:
    "A selected navigation or object row uses the app fill --ui-app-selected-nav / --ui-app-selected (or the @k2b/ui primitive); an option or control state may keep the platform fill: add it to the allowlist in scripts/checks/selection-tokens.ts with a reason",
  "accent-mix":
    "Use --ui-app-accent-text, --ui-app-selected, --ui-app-selected-nav, --ui-app-accent-border or a shared @k2b/ui primitive instead of mixing the raw --app-accent",
};

/** Keep strings (including inline styles) and blank comments without moving any source positions. */
const blankComments = (source: string, css: boolean): string =>
  source.replace(
    css
      ? /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\//g
      : /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => (token.startsWith("/*") || (!css && token.startsWith("//")) ? token.replace(/[^\r\n]/g, " ") : token),
  );

type Declaration = { start: number; end: number; subject: string };
/**
 * Join enclosing style and @utility preludes with a space; omit conditional wrappers
 * such as @media/@supports. Keep comma lists intact. Example:
 * @utility btn-input-active &:hover { background }
 */
const cssDeclarations = (source: string): Declaration[] => {
  const declarations: Declaration[] = [];
  const stack: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  const declaration = (end: number) => {
    const text = source.slice(start, end).trim();
    const property = /^@apply\b/.test(text) ? "@apply" : /^([\w-]+)\s*:/.exec(text)?.[1];
    const selector = stack.filter((prelude) => !prelude.startsWith("@") || prelude.startsWith("@utility ")).join(" ");
    if (selector && property) declarations.push({ start, end, subject: `${selector} { ${property} }` });
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (depth !== 0) continue;
    if (char === "{") {
      stack.push(source.slice(start, i).trim().replace(/\s+/g, " "));
      start = i + 1;
    } else if (char === ";" || char === "}") {
      declaration(i);
      if (char === "}") stack.pop();
      start = i + 1;
    }
  }
  return declarations;
};

export const checkSelectionSource = (file: string, original: string): SelectionFinding[] => {
  const css = file.endsWith(".css");
  const source = blankComments(original, css);
  const declarations = css ? cssDeclarations(source) : [];
  const findings: SelectionFinding[] = [];
  const report = (index: number, kind: Kind) => {
    const line = source.slice(0, index).split("\n").length;
    const subject = css
      ? declarations.find(({ start, end }) => start <= index && index < end)?.subject
      : original.split("\n")[line - 1]!.trim();
    if (subject) findings.push({ file, line, kind, subject, message: `${kind}: ${subject}: ${messages[kind]}` });
  };
  for (const match of source.matchAll(
    /\bvar\(\s*--(?:ui|k2b)-selected\s*(?=[,)])|(?<![\w-])!?bg-blue-(?:50|100)(?:\/(?:\d+(?:\.\d+)?|\[[^\]\r\n]+\]))?(?![\w/-])/g,
  )) {
    report(match.index, "selection");
  }
  if (file.endsWith(".tsx")) {
    for (const match of source.matchAll(
      /(?<![\w-])variant\s*=\s*\{[^{}]*?\?\s*(["'])primary\1\s*:\s*(["'])(?:subtle|secondary|ghost)\2\s*\}/g,
    ))
      report(match.index, "selected-button");
  }
  const mixes: { start: number; end: number }[] = [];
  for (const match of source.matchAll(/\bcolor-mix\s*\(/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    let quote = "";
    for (; end < source.length && depth > 0; end++) {
      const char = source[end]!;
      if (char === "\\") {
        end++;
        continue;
      }
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "(") depth++;
      if (char === ")") depth--;
    }
    mixes.push({ start: match.index, end });
    if (depth === 0 && /\bvar\(\s*--app-accent\s*(?=[,)])/.test(source.slice(match.index, end))) report(match.index, "accent-mix");
  }
  if (file !== "packages/cloud/src/styles/tokens.css") {
    for (const declaration of declarations) {
      const text = source.slice(declaration.start, declaration.end);
      if (!/^\s*(?:color|outline|outline-color|border-color)\s*:/.test(text)) continue;
      for (const match of text.matchAll(/\bvar\(\s*--app-accent\s*(?=[,)])/g)) {
        const index = declaration.start + match.index;
        if (!mixes.some(({ start, end }) => start <= index && index < end)) report(index, "accent-raw");
      }
    }
    // Tailwind ink, ring and border utilities, in markup and in CSS `@apply`.
    for (const match of source.matchAll(
      /(?<![\w-])!?(?:text|outline|ring|border(?:-[xytrblse])?)-(?:\[var\(\s*--app-accent\s*(?=[,)])[^\]\r\n]*\]|\(--app-accent\))(?:\/(?:[\w.%-]+|\[[^\]\r\n]+\]))?!?(?![\w/-])/g,
    )) {
      report(match.index, "accent-raw");
    }
  }
  return findings.sort((a, b) => a.line - b.line);
};

export const collectSelectionFindings = (workspaceRoot: string): SelectionFinding[] =>
  packageIds(workspaceRoot)
    .filter((id) => id !== "ui")
    .flatMap((id) => listFiles(join(workspaceRoot, "packages", id, "src"), /\.(?:css|ts|tsx)$/))
    .filter(
      (file) =>
        !isTestFile(file) && !/(?:^|[./-])(?:browser-(?:harness|suite|fixture)|fixtures?)(?:[./-]|$)/.test(relative(workspaceRoot, file)),
    )
    .sort()
    .flatMap((file) => checkSelectionSource(relative(workspaceRoot, file), readFileSync(file, "utf8")));

export const applySelectionAllowlist = (findings: SelectionFinding[], allowances: readonly SelectionAllowance[]) => {
  const used = new Set<SelectionAllowance>();
  const remaining = findings.filter((finding) => {
    const matches = allowances.filter(
      (entry) =>
        entry.file === finding.file &&
        (finding.file.endsWith(".css") ? finding.subject === entry.subject : finding.subject.includes(entry.subject)),
    );
    for (const entry of matches) used.add(entry);
    return matches.length === 0;
  });
  const stale: Finding[] = allowances
    .filter((entry) => !used.has(entry))
    .map((entry) => ({
      file: "scripts/checks/selection-tokens.ts",
      message: `Stale selection-tokens allowlist entry: ${entry.file} | ${entry.subject} (${entry.reason}); remove or update it.`,
    }));
  return { remaining, stale };
};

const BASELINE_HEADER = [
  "# Known selection-tokens findings: <file> | <selection|accent-mix|accent-raw> | <count>.",
  "# Migrations lower counts and remove entries; the rule never raises counts or adds lines.",
  "# `bun scripts/check.ts selection-tokens --fix` lowers counts whose findings are gone.",
];
const countKey = (finding: Pick<SelectionFinding, "file" | "kind">) => `${finding.file} | ${finding.kind}`;
export const formatSelectionBaseline = (counts: ReadonlyMap<string, number>): string => {
  for (const key of counts.keys()) {
    if (key.endsWith(" | selected-button"))
      throw new Error("selected-button cannot be baselined; use a selection primitive or allowlist a real action with a reason.");
  }
  return `${[...BASELINE_HEADER, ...[...counts].map(([key, count]) => `${key} | ${count}`).sort()].join("\n")}\n`;
};

const readBaseline = (path: string): Map<string, number> => {
  const counts = new Map<string, number>();
  if (!existsSync(path)) return counts;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const match = /^(.+) \| (selection|accent-mix|accent-raw|selected-button) \| ([1-9]\d*)$/.exec(line);
    if (!match) throw new Error(`Invalid selection-tokens baseline entry: ${line}`);
    if (match[2] === "selected-button")
      throw new Error("selected-button cannot be baselined; use a selection primitive or allowlist a real action with a reason.");
    const key = `${match[1]} | ${match[2]}`;
    if (counts.has(key)) throw new Error(`Duplicate selection-tokens baseline entry: ${key}`);
    counts.set(key, Number(match[3]));
  }
  return counts;
};

export const runSelectionTokens = async (
  { workspaceRoot, fix }: RuleContext,
  allowances: readonly SelectionAllowance[] = SELECTION_ALLOWLIST,
): Promise<Finding[]> => {
  const baselinePath = join(workspaceRoot, BASELINE);
  const baseline = readBaseline(baselinePath);
  const { remaining, stale } = applySelectionAllowlist(collectSelectionFindings(workspaceRoot), allowances);
  const byKey = new Map<string, SelectionFinding[]>();
  for (const finding of remaining) {
    const key = countKey(finding);
    const entries = byKey.get(key) ?? [];
    entries.push(finding);
    byKey.set(key, entries);
  }
  const failures: Finding[] = stale.map((finding) => ({ ...finding, file: join(workspaceRoot, finding.file!) }));
  for (const [key, findings] of byKey) {
    if (findings.length > (baseline.get(key) ?? 0))
      failures.push(...findings.map((finding) => ({ ...finding, file: join(workspaceRoot, finding.file) })));
  }
  let lowered = false;
  for (const [key, count] of baseline) {
    const actual = byKey.get(key)?.length ?? 0;
    if (actual >= count) continue;
    if (fix) {
      if (actual === 0) baseline.delete(key);
      else baseline.set(key, actual);
      lowered = true;
    } else {
      failures.push({
        file: baselinePath,
        message: `${key} has ${actual} finding(s), below its baseline of ${count}; lower/remove the entry (bun scripts/check.ts selection-tokens --fix).`,
      });
    }
  }
  if (lowered) writeFileSync(baselinePath, formatSelectionBaseline(baseline));
  return failures;
};

export const rule: Rule = {
  name: "selection-tokens",
  description: "App selections use selection primitives and tokens; ink, borders and focus use semantic colors",
  run: runSelectionTokens,
};
