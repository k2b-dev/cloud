import { Button, ButtonLink, ChoiceTiles, NoticeCard, Section, StatusBadge, useLocale } from "@k2b/ui";
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
import { CODE_POLICY_ROW_GROUPS } from "./area";
import { CodeAdminRequestError, postCodeAdmin, reloadCodeArea } from "./client";
import { codeAdminMessages } from "./messages";

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
const VALUE_ICON: Record<CodePolicyValue, string> = { automatic: "ti ti-circle-check", admin: "ti ti-user-shield", never: "ti ti-ban" };
const PreviewSchema = codePolicyContracts.preview.data.extend({ owners: z.record(z.string(), z.string().nullable()) });
type Preview = z.infer<typeof PreviewSchema>;
type Status = { kind: "idle" } | { kind: "saved"; paused: number } | { kind: "failed" } | { kind: "unknown" } | { kind: "conflict" };

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
 * The policy table: presets, rows × Automatic / Admin approval / Never, the consequence of a change before saving,
 * a confirmation that names the paused Code, and recovery from a failed or concurrent save.
 */
export default function CodePolicyEditor(props: CodePolicyEditorProps) {
  const locale = useLocale();
  const t = () => codeAdminMessages.resolve([locale()]).t;
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
  const changeCount = createMemo(() => {
    const before = new Map(baseline().rules.map((rule) => [keyOf(rule), rule.value]));
    const after = new Map(draft().rules.map((rule) => [keyOf(rule), rule.value]));
    return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).length;
  });

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
    // The bar names every automation that pauses before saving, so saving needs no second question.
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
    return current.kind === "saved" ? current.paused : null;
  };

  const presetOptions = () => [
    { value: "off" as const, icon: "ti ti-power", label: t().presetOff, status: t().presetOffSub },
    { value: "admin" as const, icon: "ti ti-user-check", label: t().presetAdmin, status: t().presetAdminSub },
    { value: "open" as const, icon: "ti ti-lock-open", label: t().presetOpen, status: t().presetOpenSub },
    { value: "custom" as const, icon: "ti ti-adjustments", label: t().presetCustom, status: t().presetCustomSub },
  ];
  /** Columns of the table: "As default" first for a group, then the three values. */
  const columns = (): Cell[] => [...(props.groupId ? (["inherit"] as const) : []), ...VALUES];
  const tableGroups = () => CODE_POLICY_ROW_GROUPS.filter((group) => group.key !== "grpAsk");
  const askRows = () => CODE_POLICY_ROW_GROUPS.find((group) => group.key === "grpAsk")?.rows ?? [];

  /** One radio group per row: one tab stop, arrow keys move between the values, as native radios do. */
  const keyDown = (event: KeyboardEvent, row: CodePolicyRow) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const step = keys[event.key];
    const list = columns();
    const at = list.indexOf(cellOf(draft(), props.groupId, row));
    const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : step === undefined ? -1 : (at + step + list.length) % list.length;
    if (next < 0) return;
    event.preventDefault();
    const value = list[next]!;
    edit(withCell(draft(), props.groupId, row, value));
    const group = (event.currentTarget as HTMLElement).closest('[role="radiogroup"]');
    queueMicrotask(() => group?.querySelector<HTMLElement>(`[data-value="${value}"]`)?.focus());
  };

  /** What the draft changes, one sentence per row, the old value struck through. */
  const changeLines = () =>
    changedRows().map((row) => ({
      row,
      label: t().rowLabel({ row }),
      before: cellLabel(cellOf(baseline(), props.groupId, row)),
      after: cellLabel(cellOf(draft(), props.groupId, row)),
    }));

  return (
    <div class="core-code-policy">
      <Show when={savedPaused() !== null}>
        <NoticeCard
          tone="success"
          title={t().savedTitle}
          detail={
            <>
              <p>{savedPaused() ? t().savedPaused({ n: savedPaused() ?? 0 }) : t().savedNone}</p>
              <Show when={savedPaused()}>
                <div class="mt-2">
                  <ButtonLink size="sm" variant="secondary" href={props.pausedHref}>
                    {t().showPaused}
                  </ButtonLink>
                </div>
              </Show>
            </>
          }
        />
      </Show>

      <Show when={!props.groupId}>
        <ChoiceTiles
          label={t().presets}
          layout="row"
          options={presetOptions().map((option) => ({
            value: option.value,
            label: option.label,
            status: option.status,
            visual: <i class={`${option.icon} core-code-policy__tile-icon`} aria-hidden="true" />,
          }))}
          value={() => draft().preset}
          onValueChange={(preset) => {
            if (preset !== "custom") edit(codePolicyPreset(preset));
          }}
          disabled={saving()}
        />
      </Show>

      <Section frame="line" title={props.groupId ? t().groupDeviates : t().policyTable} class="core-code-policy__frame">
        <table class="core-code-policy__table">
          <thead>
            <tr>
              <th scope="col">{t().policyTable}</th>
              <For each={columns()}>{(cell) => <th scope="col">{cellLabel(cell)}</th>}</For>
            </tr>
          </thead>
          <For each={tableGroups()}>
            {(group) => (
              <tbody>
                <tr class="core-code-policy__group">
                  <th scope="rowgroup" colSpan={columns().length + 1}>
                    {t()[group.key]}
                  </th>
                </tr>
                <For each={group.rows}>
                  {(row) => {
                    const changed = () => changedRows().includes(row);
                    return (
                      <tr role="radiogroup" aria-label={t().rowLabel({ row })} data-row={row} data-changed={changed() ? "true" : undefined}>
                        <th scope="row">
                          <span class="core-code-policy__row">
                            {t().rowLabel({ row })}
                            <Show when={changed()}>
                              <StatusBadge tone="warning" variant="text" icon={null} label={t().changedMark} />
                            </Show>
                          </span>
                          <span class="core-code-policy__sub">
                            {t().rowExample({ row })} · {t().automationCount({ n: props.usage[row] ?? 0 })}
                          </span>
                        </th>
                        <For each={columns()}>
                          {(cell) => {
                            const on = () => cellOf(draft(), props.groupId, row) === cell;
                            return (
                              <td data-label={cellLabel(cell)}>
                                <span
                                  role="radio"
                                  class="core-code-policy__radio"
                                  data-value={cell}
                                  aria-checked={on() ? "true" : "false"}
                                  aria-label={cellLabel(cell)}
                                  aria-disabled={saving() ? "true" : undefined}
                                  tabIndex={on() ? 0 : -1}
                                  onClick={() => {
                                    if (!saving()) edit(withCell(draft(), props.groupId, row, cell));
                                  }}
                                  onKeyDown={(event) => {
                                    if (saving()) return;
                                    if (event.key === " " || event.key === "Enter") {
                                      event.preventDefault();
                                      edit(withCell(draft(), props.groupId, row, cell));
                                    } else keyDown(event, row);
                                  }}
                                />
                              </td>
                            );
                          }}
                        </For>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            )}
          </For>
        </table>
      </Section>

      <Show when={!props.groupId}>
        <Section frame="line" title={t().alwaysHuman} count={askRows().length} description={t().alwaysHumanSub}>
          <p class="core-code-policy__locked">
            <For each={askRows()}>
              {(row) => <StatusBadge tone="neutral" variant="chip" icon="ti ti-lock" label={t().rowLabel({ row })} />}
            </For>
          </p>
        </Section>
      </Show>

      {/* The bar keeps its height when empty, so the table never moves when a change appears. */}
      <div class="core-code-policy__bar" aria-live="polite">
        <Show when={status().kind === "conflict"}>
          <NoticeCard
            tone="warning"
            icon="ti ti-users"
            title={t().conflictTitle}
            detail={
              <>
                <p>{t().conflictSub}</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => reloadCodeArea()}>
                    {t().showTheirs}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void rebase()}>
                    {t().recheckMine}
                  </Button>
                </div>
              </>
            }
          />
        </Show>
        <Show when={status().kind === "unknown"}>
          <NoticeCard
            tone="warning"
            icon="ti ti-alert-triangle"
            title={t().policyUnknownTitle}
            detail={
              <>
                <p>{t().unknownPolicySub}</p>
                <div class="mt-2">
                  <Button size="sm" variant="secondary" onClick={() => reloadCodeArea()}>
                    <i class="ti ti-refresh" aria-hidden="true" />
                    {t().checkState}
                  </Button>
                </div>
              </>
            }
          />
        </Show>
        <Show when={status().kind === "failed"}>
          <NoticeCard
            tone="danger"
            icon="ti ti-alert-circle"
            title={t().saveFailedTitle}
            detail={
              <>
                <p>{t().saveFailedSub}</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" disabled={!ready() || saving()} onClick={() => void save()}>
                    {t().retrySave}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={saving()} onClick={() => edit(baseline())}>
                    {t().discard}
                  </Button>
                </div>
              </>
            }
          />
        </Show>
        <Show when={dirty() && status().kind === "idle"}>
          <div class="core-code-policy__changes">
            <p class="core-code-policy__changes-title">{t().whatChanges}</p>
            <For each={changeLines()}>
              {(line) => (
                <p class="core-code-policy__change">
                  „{line.label}“: <s>{line.before}</s> <i class="ti ti-arrow-right" aria-hidden="true" /> <strong>{line.after}</strong>
                </p>
              )}
            </For>
            <p class="core-code-policy__affected" data-tone={(ready()?.result.total ?? 0) > 0 ? "warning" : undefined}>
              <Show
                when={previewState() === "idle" && ready()?.result}
                fallback={previewState() === "failed" ? t().previewFailed : t().checking}
              >
                {(result) => (
                  <Show when={result().total} fallback={t().pausesNone}>
                    <i class="ti ti-player-pause" aria-hidden="true" /> {t().pausesNamed({ n: result().total })}{" "}
                    <strong>{result().items.map((item) => item.title).join(", ")}</strong>
                    <Show when={result().total > result().items.length}>
                      {" "}
                      {t().confirmMore({ n: result().total - result().items.length })}
                    </Show>
                  </Show>
                )}
              </Show>
            </p>
          </div>
          <span class="core-code-policy__buttons">
            <Button variant="secondary" disabled={saving()} onClick={() => edit(baseline())}>
              {t().discard}
            </Button>
            <Button loading={saving()} disabled={!ready()} onClick={() => void save()}>
              {(ready()?.result.total ?? 0) > 0 ? t().saveAndPause({ n: ready()?.result.total ?? 0 }) : t().saveNow}
            </Button>
          </span>
        </Show>
      </div>
    </div>
  );
}
