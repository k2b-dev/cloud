import { Bar, Button, Chip, Field, Notice, Row, Section, Select, useLocale, useToast } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { z } from "zod";
import {
  CODE_POLICY_ROWS,
  type CodePolicyDefinition,
  type CodePolicyRow,
  type CodePolicyRule,
  CodePolicySchema,
  type CodePolicyValue,
  codePolicyContracts,
  codePolicyPreset,
} from "../../../code/policy-contracts";
import { areaFormMessages } from "../_area/messages";
import { CODE_POLICY_ROW_GROUPS } from "./area";
import { CodeAdminRequestError, postCodeAdmin, reloadCodeArea } from "./client";
import { useCodeText } from "./parts";

export type CodePolicyEditorProps = {
  revision: number;
  definition: CodePolicyDefinition;
  /** `null` edits the default; a group UUID edits that group's rules, where a missing rule means "as default". */
  groupId: string | null;
  usage: Partial<Record<CodePolicyRow, number>>;
  pausedHref: string;
};

type Cell = CodePolicyValue | "inherit";
const VALUES: CodePolicyValue[] = ["automatic", "admin", "never"];
const PreviewSchema = codePolicyContracts.preview.data.extend({ owners: z.record(z.string(), z.string().nullable()) });
type Preview = z.infer<typeof PreviewSchema>;
type Status = { kind: "idle" } | { kind: "saved"; paused: number } | { kind: "failed" } | { kind: "unknown" } | { kind: "conflict" };
type Preset = CodePolicyDefinition["preset"];

const keyOf = (rule: Pick<CodePolicyRule, "groupId" | "row">) => `${rule.groupId ?? ""}:${rule.row}`;
const canonical = (definition: CodePolicyDefinition) =>
  JSON.stringify({ preset: definition.preset, rules: [...definition.rules].sort((a, b) => keyOf(a).localeCompare(keyOf(b))) });

/** Read a cell: the default's value, or a group's own value / inherit. */
const cellOf = (definition: CodePolicyDefinition, groupId: string | null, row: CodePolicyRow): Cell =>
  definition.rules.find((rule) => rule.groupId === groupId && rule.row === row)?.value ?? (groupId ? "inherit" : "never");

/** Write a cell and mark the table custom unless it equals a named preset again. */
const withCell = (definition: CodePolicyDefinition, groupId: string | null, row: CodePolicyRow, value: Cell): CodePolicyDefinition => {
  const rules = definition.rules.filter((rule) => !(rule.groupId === groupId && rule.row === row));
  if (value !== "inherit") rules.push({ groupId, row, value });
  const next: CodePolicyDefinition = { preset: "custom", rules };
  for (const preset of ["off", "admin", "open"] as const)
    if (canonical({ ...codePolicyPreset(preset), preset: "custom" }) === canonical(next)) return codePolicyPreset(preset);
  return next;
};

/**
 * The policy on v2: one setting per row with its value beside it (Automatic, Admin approval, Never; a group adds "As
 * default"), the preset above, what the draft changes and pauses before saving, and recovery from a refused, lost or
 * concurrent save. The footer holds the count of changes, Discard and Save.
 */
export default function CodePolicyEditor(props: CodePolicyEditorProps) {
  const t = useCodeText();
  const locale = useLocale();
  const f = () => areaFormMessages.resolve([locale()]).t;
  const toast = useToast();
  const [revision, setRevision] = createSignal(props.revision);
  const [baseline, setBaseline] = createSignal<CodePolicyDefinition>(props.definition);
  const [draft, setDraft] = createSignal<CodePolicyDefinition>(props.definition);
  // The preview answers exactly one draft at one revision; saving submits only that snapshot.
  const [preview, setPreview] = createSignal<{ key: string; revision: number; definition: CodePolicyDefinition; result: Preview } | null>(
    null,
  );
  const [previewState, setPreviewState] = createSignal<"idle" | "loading" | "failed">("idle");
  const [saving, setSaving] = createSignal(false);
  const [status, setStatus] = createSignal<Status>({ kind: "idle" });

  const dirty = createMemo(() => canonical(draft()) !== canonical(baseline()));
  const draftKey = () => `${revision()}|${canonical(draft())}`;
  const ready = () => {
    const current = preview();
    return current !== null && current.key === draftKey() ? current : null;
  };
  const changedRows = createMemo(() =>
    CODE_POLICY_ROWS.filter((row) => cellOf(draft(), props.groupId, row) !== cellOf(baseline(), props.groupId, row)),
  );

  // Ask the server what the draft would pause; the newest draft wins.
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on([draft, revision], () => {
      controller?.abort();
      clearTimeout(timer);
      if (!dirty()) {
        setPreview(null);
        setPreviewState("idle");
        return;
      }
      setPreviewState("loading");
      timer = setTimeout(() => {
        const current = new AbortController();
        controller = current;
        const snapshot = { key: draftKey(), revision: revision(), definition: draft() };
        postCodeAdmin(
          "policy/preview",
          { revision: snapshot.revision, definition: snapshot.definition, limit: 20 },
          PreviewSchema,
          current.signal,
        )
          .then((result) => {
            if (current.signal.aborted) return;
            setPreview({ ...snapshot, result });
            setPreviewState("idle");
          })
          .catch((error: unknown) => {
            if (current.signal.aborted) return;
            if (error instanceof CodeAdminRequestError && error.status === 409) setStatus({ kind: "conflict" });
            setPreviewState("failed");
          });
      }, 250);
    }),
  );
  onCleanup(() => {
    controller?.abort();
    clearTimeout(timer);
  });

  const edit = (next: CodePolicyDefinition) => {
    setDraft(next);
    if (status().kind === "saved") setStatus({ kind: "idle" });
  };

  const save = async () => {
    const checked = ready();
    if (saving() || !checked) return;
    // The changes name every automation that pauses before saving, so saving needs no second question.
    const paused = checked.result.total;
    setSaving(true);
    try {
      const result = await postCodeAdmin(
        "policy/update",
        { revision: checked.revision, definition: checked.definition },
        codePolicyContracts.update.data.extend({ policy: CodePolicySchema }),
      );
      setRevision(result.policy.revision);
      setBaseline(result.policy.definition);
      setDraft(result.policy.definition);
      setStatus({ kind: "saved", paused });
      toast(t().savedTitle, { status: "ok" });
    } catch (error) {
      // Only a refusal proves nothing changed; a lost answer may follow a committed save.
      setStatus(
        error instanceof CodeAdminRequestError && error.status === 409
          ? { kind: "conflict" }
          : error instanceof CodeAdminRequestError && error.status >= 400 && error.status < 500
            ? { kind: "failed" }
            : { kind: "unknown" },
      );
    } finally {
      setSaving(false);
    }
  };

  /** Keep my changed cells and apply them on top of the policy someone else saved. */
  const rebase = async () => {
    try {
      const current = await postCodeAdmin("policy/read", {}, z.object({ policy: CodePolicySchema }));
      const before = baseline();
      const mine = draft();
      const groups = new Set<string | null>([
        null,
        ...[...before.rules, ...mine.rules].flatMap((rule) => (rule.groupId ? [rule.groupId] : [])),
      ]);
      let next: CodePolicyDefinition = current.policy.definition;
      const preset = mine.preset;
      if (preset !== "custom" && preset !== before.preset) next = codePolicyPreset(preset);
      else
        for (const groupId of groups)
          for (const row of CODE_POLICY_ROWS) {
            const cell = cellOf(mine, groupId, row);
            if (cell !== cellOf(before, groupId, row)) next = withCell(next, groupId, row, cell);
          }
      setRevision(current.policy.revision);
      setBaseline(current.policy.definition);
      setDraft(next);
      setStatus({ kind: "idle" });
    } catch {
      setStatus({ kind: "failed" });
    }
  };

  const cellLabel = (cell: Cell) => (cell === "inherit" ? t().inherit : t().value({ value: cell }));
  const savedPaused = () => {
    const current = status();
    return current.kind === "saved" && current.paused > 0 ? current.paused : null;
  };
  const presetLabel = (preset: Preset) =>
    ({ off: t().presetOff, admin: t().presetAdmin, open: t().presetOpen, custom: t().presetCustom })[preset];
  const presetSub = (preset: Preset) =>
    ({ off: t().presetOffSub, admin: t().presetAdminSub, open: t().presetOpenSub, custom: t().presetCustomSub })[preset];
  /** The values of a row: "As default" first for a group, then the three values. */
  const columns = (): Cell[] => [...(props.groupId ? (["inherit"] as const) : []), ...VALUES];
  const tableGroups = () => CODE_POLICY_ROW_GROUPS.filter((group) => group.key !== "grpAsk");
  const askRows = () => CODE_POLICY_ROW_GROUPS.find((group) => group.key === "grpAsk")?.rows ?? [];
  const pauses = () => ready()?.result.total ?? 0;
  const affected = (): string => {
    if (previewState() === "failed") return t().previewFailed;
    const result = previewState() === "idle" ? ready()?.result : undefined;
    if (!result) return t().checking;
    if (!result.total) return t().pausesNone;
    const names = result.items.map((item) => item.title).join(", ");
    const more = result.total > result.items.length ? ` ${t().confirmMore({ n: result.total - result.items.length })}` : "";
    return `${t().pausesNamed({ n: result.total })} ${names}${more}`;
  };

  return (
    <>
      <Show when={savedPaused()}>
        {(paused) => (
          <Notice tone="warn" icon="player-pause" actions={[{ label: t().showPaused, href: props.pausedHref }]}>
            {t().savedPaused({ n: paused() })}
          </Notice>
        )}
      </Show>
      <Show when={status().kind === "conflict"}>
        <Notice
          tone="warn"
          icon="users"
          title={t().conflictTitle}
          actions={[
            { label: t().showTheirs, onClick: () => reloadCodeArea() },
            { label: t().recheckMine, onClick: () => void rebase() },
          ]}
        >
          {t().conflictSub}
        </Notice>
      </Show>
      <Show when={status().kind === "unknown"}>
        <Notice
          tone="warn"
          title={t().policyUnknownTitle}
          actions={[{ label: t().checkState, icon: "refresh", onClick: () => reloadCodeArea() }]}
        >
          {t().unknownPolicySub}
        </Notice>
      </Show>
      <Show when={status().kind === "failed"}>
        <Notice
          tone="bad"
          title={t().saveFailedTitle}
          actions={[
            { label: t().retrySave, onClick: () => void save(), disabled: !ready() || saving() },
            { label: t().discard, onClick: () => edit(baseline()), disabled: saving() },
          ]}
        >
          {t().saveFailedSub}
        </Notice>
      </Show>
      <Show when={!props.groupId}>
        <Section icon="adjustments" title={t().appliesToAll}>
          {/* slot for #4208/#4223 (DP): this field becomes a Setting row with `was`; until then the unsaved change's old value stands in the hint */}
          <Field
            label={t().presets}
            hint={
              draft().preset !== baseline().preset
                ? `${presetSub(draft().preset)} · ${f().changedWas({ value: presetLabel(baseline().preset) })}`
                : presetSub(draft().preset)
            }
          >
            <Select
              options={(["off", "admin", "open", "custom"] as const).map((preset) => ({
                value: preset,
                label: presetLabel(preset),
                // "Custom" follows from changing a row; it is no preset to choose
                disabled: preset === "custom",
              }))}
              value={draft().preset}
              disabled={saving()}
              onChange={(preset) => {
                if (preset === "off" || preset === "admin" || preset === "open") edit(codePolicyPreset(preset));
              }}
            />
          </Field>
        </Section>
      </Show>
      <For each={tableGroups()}>
        {(group) => (
          <Section title={group.key === "grpRead" ? t().grpReadSection : t()[group.key]}>
            <For each={group.rows}>
              {(row) => {
                const changed = () => changedRows().includes(row);
                const hint = () => `${t().rowExample({ row })} · ${t().automationCount({ n: props.usage[row] ?? 0 })}`;
                return (
                  // slot for #4208/#4223 (DP): this field becomes a Setting row with `was`; until then the unsaved change's old value stands in the hint
                  <Field
                    name={`code-policy-${row}`}
                    label={t().rowLabel({ row })}
                    hint={
                      changed() ? `${hint()} · ${f().changedWas({ value: cellLabel(cellOf(baseline(), props.groupId, row)) })}` : hint()
                    }
                  >
                    <Select
                      options={columns().map((cell) => ({ value: cell, label: cellLabel(cell) }))}
                      value={cellOf(draft(), props.groupId, row)}
                      disabled={saving()}
                      onChange={(value) => {
                        const cell = columns().find((entry) => entry === value);
                        if (cell) edit(withCell(draft(), props.groupId, row, cell));
                      }}
                    />
                  </Field>
                );
              }}
            </For>
          </Section>
        )}
      </For>
      <Show when={!props.groupId}>
        <Section icon="lock" title={t().alwaysHuman} count={askRows().length} summary={t().alwaysHumanSub}>
          <For each={askRows()}>{(row) => <Row icon="lock" lines={[t().rowLabel({ row }), t().rowExample({ row })]} />}</For>
        </Section>
      </Show>
      <Show when={dirty() && status().kind === "idle"}>
        <Notice tone={pauses() > 0 ? "warn" : "note"} icon="list-details" title={t().whatChanges}>
          {[
            ...changedRows().map(
              (row) =>
                `„${t().rowLabel({ row })}“: ${cellLabel(cellOf(baseline(), props.groupId, row))} → ${cellLabel(cellOf(draft(), props.groupId, row))}.`,
            ),
            ...(draft().preset !== baseline().preset
              ? [`${t().presets}: ${presetLabel(baseline().preset)} → ${presetLabel(draft().preset)}.`]
              : []),
            affected(),
          ].join(" ")}
        </Notice>
      </Show>
      {/* the footer of a settings form (look rule f): the count of unsaved changes, Discard and Save */}
      <Bar
        end={
          <>
            <Show when={dirty()}>
              <Chip yours>{t().changes({ n: changedRows().length || 1 })}</Chip>
            </Show>
            <Button disabled={!dirty() || saving()} onClick={() => edit(baseline())}>
              {t().discard}
            </Button>
            <Button variant="primary" busy={saving()} disabled={!dirty() || !ready()} onClick={() => void save()}>
              {pauses() > 0 ? t().saveAndPause({ n: pauses() }) : t().saveNow}
            </Button>
          </>
        }
      />
    </>
  );
}
