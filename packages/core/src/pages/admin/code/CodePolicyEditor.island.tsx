import { Button, ButtonLink, ChoiceList, NoticeCard, prompts, SegmentedControl, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { z } from "zod";
import {
  CODE_POLICY_ROWS,
  type CodePolicyDefinition,
  type CodePolicyRow,
  type CodePolicyRule,
  type CodePolicyValue,
  CodePolicySchema,
  codePolicyContracts,
  codePolicyPreset,
} from "../../../code/policy-contracts";
import { CODE_POLICY_ROW_GROUPS, codePolicyRowCode } from "./area";
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
type Status = { kind: "idle" } | { kind: "saved"; paused: number } | { kind: "failed" } | { kind: "conflict" };

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
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [previewState, setPreviewState] = createSignal<"idle" | "loading" | "failed">("idle");
  const [saving, setSaving] = createSignal(false);
  const [status, setStatus] = createSignal<Status>({ kind: "idle" });

  const dirty = createMemo(() => canonical(draft()) !== canonical(baseline()));
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
        postCodeAdmin("policy/preview", { revision: revision(), definition: draft(), limit: 20 }, PreviewSchema, current.signal)
          .then((result) => {
            if (current.signal.aborted) return;
            setPreview(result);
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
    const paused = preview()?.total ?? 0;
    if (paused > 0) {
      const items = preview()?.items ?? [];
      const owners = preview()?.owners ?? {};
      const confirmed = await prompts.confirm(
        <div class="grid gap-3 text-sm">
          <p>{t().confirmLead}</p>
          <ul class="grid gap-1">
            <For each={items}>
              {(item) => (
                <li class="flex items-center justify-between gap-3">
                  <span class="min-w-0 truncate font-medium">
                    <i class="ti ti-bolt" aria-hidden="true" /> {item.title}
                  </span>
                  <span class="shrink-0 text-(--k2b-text-muted)">{owners[item.codeId] ?? t().ownerUnknown}</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={paused > items.length}>
            <p class="text-(--k2b-text-muted)">{t().confirmMore({ n: paused - items.length })}</p>
          </Show>
          <p>{t().confirmTail}</p>
        </div>,
        { title: t().confirmTitle({ n: paused }), confirmText: t().confirmSave({ n: paused }), cancelText: t().cancel },
      );
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const result = await postCodeAdmin(
        "policy/update",
        { revision: revision(), definition: draft() },
        codePolicyContracts.update.data.extend({ policy: CodePolicySchema }),
      );
      setRevision(result.policy.revision);
      setBaseline(result.policy.definition);
      setDraft(result.policy.definition);
      setStatus({ kind: "saved", paused });
    } catch (error) {
      setStatus(error instanceof CodeAdminRequestError && error.status === 409 ? { kind: "conflict" } : { kind: "failed" });
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
      const groups = new Set<string | null>([null, ...[...before.rules, ...mine.rules].flatMap((rule) => (rule.groupId ? [rule.groupId] : []))]);
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
    { value: "off" as const, label: t().presetOff, description: t().presetOffSub },
    { value: "admin" as const, label: t().presetAdmin, description: t().presetAdminSub },
    { value: "open" as const, label: t().presetOpen, description: t().presetOpenSub },
    { value: "custom" as const, label: t().presetCustom, description: t().presetCustomSub },
  ];

  const options = () => [
    ...(props.groupId ? [{ value: "inherit" as const, label: t().inherit }] : []),
    ...VALUES.map((value) => ({
      value,
      icon: VALUE_ICON[value],
      label: (
        <>
          <span class="hidden md:inline">{t().value({ value })}</span>
          <span class="md:hidden">{t().valueShort({ value })}</span>
        </>
      ),
      disabled: false,
    })),
  ];

  return (
    <div class="flex min-h-full flex-col">
      <div class="grid flex-1 content-start gap-4 px-2 pt-1 pb-6">
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
        <Show when={status().kind === "conflict"}>
          <NoticeCard
            tone="warning"
            icon="ti ti-git-merge"
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
        <Show when={status().kind === "failed"}>
          <NoticeCard
            tone="danger"
            title={t().saveFailedTitle}
            detail={
              <>
                <p>{t().saveFailedSub}</p>
                <div class="mt-2">
                  <Button size="sm" variant="secondary" onClick={() => void save()}>
                    <i class="ti ti-refresh" aria-hidden="true" />
                    {t().retrySave}
                  </Button>
                </div>
              </>
            }
          />
        </Show>

        <Show when={!props.groupId}>
          <ChoiceList
            label={t().presets}
            options={presetOptions()}
            value={draft().preset}
            onValueChange={(preset) => {
              if (preset !== "custom") edit(codePolicyPreset(preset));
            }}
          />
        </Show>

        <div class="grid gap-1" role="table" aria-label={props.groupId ? t().groupDeviates : t().standard}>
          <For each={CODE_POLICY_ROW_GROUPS}>
            {(group) => (
              <div role="rowgroup" class="grid gap-1">
                <div role="row">
                  <span role="columnheader" class="block px-3 pt-3 pb-1 text-xs font-semibold text-(--k2b-text-muted)">
                    {t()[group.key]}
                  </span>
                </div>
                <For each={group.rows}>
                  {(row) => {
                    const changed = () => changedRows().includes(row);
                    const before = () => cellOf(baseline(), props.groupId, row);
                    return (
                      <div
                        role="row"
                        class="grid grid-cols-1 items-center gap-2 rounded-lg px-3 py-2 md:grid-cols-[minmax(0,1fr)_7rem_auto]"
                        classList={{ "bg-(--k2b-warning-surface)": changed() }}
                        data-row={row}
                        data-changed={changed() ? "true" : undefined}
                      >
                        <span role="cell" class="min-w-0">
                          <span class="flex flex-wrap items-baseline gap-x-2">
                            <span class="text-sm font-semibold">{t().rowLabel({ row })}</span>
                            <code class="hidden text-xs text-(--k2b-text-muted) md:inline">{codePolicyRowCode(row)}</code>
                          </span>
                          <span class="block text-xs text-(--k2b-text-muted)">
                            <Show when={changed()}>
                              <b class="font-semibold">
                                {t().before({ value: cellLabel(before()) })}
                              </b>
                              {" · "}
                            </Show>
                            {t().rowExample({ row })}
                          </span>
                        </span>
                        <span role="cell" class="text-xs text-(--k2b-text-muted)">
                          {t().usage({ n: props.usage[row] ?? 0 })}
                        </span>
                        <span role="cell">
                          <SegmentedControl
                            size="sm"
                            ariaLabel={t().valueFor({ label: t().rowLabel({ row }) })}
                            options={options()}
                            value={() => cellOf(draft(), props.groupId, row)}
                            onValueChange={(value) => edit(withCell(draft(), props.groupId, row, value))}
                            disabled={saving()}
                          />
                        </span>
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>

      {/* The bar keeps its height when empty, so the table never moves when a change appears. */}
      <div class="sticky bottom-0 flex min-h-14 flex-wrap items-center gap-2 bg-(--k2b-surface) px-2 py-3" aria-live="polite">
        <Show when={dirty()}>
          <span class="text-sm">{t().changes({ n: changeCount() })}</span>
          <span class="text-sm font-medium" classList={{ "text-(--k2b-warning-text)": (preview()?.total ?? 0) > 0 }}>
            <Show
              when={previewState() === "idle" && preview()}
              fallback={previewState() === "failed" ? t().previewFailed : t().checking}
            >
              {(result) => (
                <>
                  <i class="ti ti-player-pause" aria-hidden="true" /> {t().pauses({ n: result().total })}
                </>
              )}
            </Show>
          </span>
          <span class="flex-1" />
          <Button variant="secondary" disabled={saving()} onClick={() => edit(baseline())}>
            {t().discard}
          </Button>
          <Button loading={saving()} disabled={previewState() !== "idle" || !preview()} onClick={() => void save()}>
            {(preview()?.total ?? 0) > 0 ? t().save : t().saveNow}
          </Button>
        </Show>
      </div>
    </div>
  );
}

