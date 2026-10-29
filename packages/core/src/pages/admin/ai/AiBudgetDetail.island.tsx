import { PrincipalPicker, principalLabel } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { Principal } from "@k2b/cloud/contracts";
import { type AiQuotaConfig, AiQuotaConfigSchema, type AiQuotaRule, AiQuotaRuleSchema } from "@k2b/cloud/shared";
import { Button, IconButton, NoticeCard, NumberInput, Select, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import AiBackgroundBudget from "../settings/_components/AiBackgroundBudget";
import { aiAreaHref } from "./area";
import { type AiAdminConflict, asAiConflict, assertAiAdmin, reloadAiArea } from "./client";
import { ConflictNotice } from "./conflict";
import { setAiDetailControls } from "./detail-controls";
import { aiAreaMessages } from "./messages";
import { AiQuotaAdminConfigSchema } from "./read-shapes";

type Rule = AiQuotaRule & { peopleAtLimit?: number };
type Config = Omit<AiQuotaConfig, "rules"> & { rules: Rule[] };
type Model = { id: string; label: string; priced: boolean };

const api = coreClient.admin.core["ai-quotas"];
const brakeDraft = (config: Config) => ({
  unit: config.unit,
  enabled: config.background?.enabled ?? false,
  warnAt: config.background?.warnAt ?? null,
  stopAt: config.background?.stopAt ?? 10,
});
const PERIODS = [24, 168, 720] as const;
const plain = (config: Config): AiQuotaConfig =>
  AiQuotaConfigSchema.parse({ ...config, rules: config.rules.map(({ peopleAtLimit: _, ...rule }) => rule) });

/** The next start of a rule's period after now, from its anchor. */
const nextReset = (rule: Pick<AiQuotaRule, "anchor" | "hours">, now = Date.now()) => {
  const period = rule.hours * 3_600_000;
  const anchor = Date.parse(rule.anchor);
  return new Date(anchor + Math.ceil((now - anchor) / period) * period);
};

/**
 * A6 detail: one budget rule (what it covers, the period, who gets how much, the state now) or the background
 * cost brake. Saving writes the whole budget configuration with its revision, as the rules editor always did.
 */
export default function AiBudgetDetail(props: { config: Config; scope: string | null; brake?: boolean; models: Model[] }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [base, setBase] = createSignal(props.config);
  const original = () => base().rules.find((rule) => rule.scope === props.scope);
  const fresh = (): Rule => ({ scope: "*", hours: 168, anchor: new Date().toISOString().slice(0, 10) + "T00:00:00.000Z", grants: [] });
  const initialRule = structuredClone(original() ?? fresh());
  const [rule, setRule] = createSignal<Rule>(initialRule);
  const [config, setConfig] = createSignal(structuredClone(props.config));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<Config> | null>(null);
  const unit = () => base().unit ?? "EUR";
  const isNew = () => !props.brake && !original();
  const scopeAvailable = () => !isNew() || !base().rules.some((entry) => entry.scope === rule().scope);
  const dirty = () =>
    props.brake ? JSON.stringify(config()) !== JSON.stringify(base()) : isNew() || JSON.stringify(rule()) !== JSON.stringify(original());

  const nextConfig = (current: Config): Config =>
    props.brake
      ? { ...current, background: config().background, unit: config().unit }
      : {
          ...current,
          rules: current.rules.some((entry) => entry.scope === rule().scope)
            ? current.rules.map((entry) => (entry.scope === rule().scope ? rule() : entry))
            : [...current.rules, rule()],
        };

  const save = async (current = base()) => {
    setSaving(true);
    setError("");
    try {
      await assertAiAdmin(await api.$put({ json: plain(nextConfig(current)) }), t().saveFailed);
      toast.success(t().saved);
      reloadAiArea(isNew() ? aiAreaHref({ sec: "budgets" }, { rule: rule().scope }) : undefined);
    } catch (failure) {
      const found = asAiConflict(failure, AiQuotaAdminConfigSchema);
      if (found) setConflict(found);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await assertAiAdmin(
        await api.$put({ json: plain({ ...base(), rules: base().rules.filter((entry) => entry.scope !== props.scope) }) }),
        t().saveFailed,
      );
      reloadAiArea(aiAreaHref({ sec: "budgets" }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().saveFailed);
    } finally {
      setSaving(false);
    }
  };

  createEffect(() =>
    setAiDetailControls({
      save: { dirty: dirty() && !conflict(), disabled: !props.brake && !scopeAvailable(), saving: saving(), run: () => void save() },
    }),
  );
  onCleanup(() => setAiDetailControls(null));

  const usedScopes = () =>
    base()
      .rules.map((entry) => entry.scope)
      .filter((scope) => scope !== props.scope);
  const scopeOptions = () => [
    { value: "*", label: t().allModels, disabled: usedScopes().includes("*") },
    ...props.models
      .filter((model) => model.priced)
      .map((model) => ({ value: model.id, label: model.label, disabled: usedScopes().includes(model.id) })),
  ];
  const periodLabel = (hours: number) =>
    hours === 24 ? t().perDay : hours === 168 ? t().perWeek : hours === 720 ? t().perMonth : t().perHours({ p: hours });
  const updateGrant = (index: number, limit: number | null) =>
    setRule((current) => ({
      ...current,
      grants: current.grants.map((grant, position) => (position === index ? { ...grant, limit } : grant)),
    }));

  return (
    <div class="grid gap-5 px-2 pb-10">
      <Show when={conflict()}>
        {(current) => (
          <Show
            when={!props.brake}
            fallback={
              <ConflictNotice
                conflict={current()}
                fields={[
                  { key: "unit", label: t().accountingUnit },
                  { key: "enabled", label: t().enable },
                  { key: "warnAt", label: t().budgetWarning },
                  { key: "stopAt", label: t().budgetStop },
                ]}
                base={brakeDraft(base())}
                mine={brakeDraft(config())}
                theirs={brakeDraft(current().current)}
                busy={saving()}
                onMerge={(merged) => {
                  const theirs = current().current;
                  setConflict(null);
                  setConfig({
                    ...theirs,
                    unit: merged.unit,
                    background: { enabled: merged.enabled, warnAt: merged.warnAt, stopAt: merged.stopAt },
                  });
                  setBase(theirs);
                  void save(theirs);
                }}
                onDiscard={() => reloadAiArea()}
              />
            }
          >
            <ConflictNotice<AiQuotaRule>
              conflict={current()}
              fields={[
                { key: "scope", label: t().ruleScope },
                { key: "hours", label: t().rulePeriod },
                { key: "anchor", label: t().ruleAnchor },
                {
                  key: "grants",
                  label: t().ruleGrants,
                  format: (value) =>
                    AiQuotaRuleSchema.shape.grants
                      .parse(value)
                      .map(
                        (grant) =>
                          `${principalLabel(grant, locale())}: ${grant.limit === null ? t().unlimited : `${grant.limit} ${unit()}`}`,
                      )
                      .join(", "),
                },
              ]}
              base={original() ?? initialRule}
              mine={rule()}
              theirs={current().current.rules.find((entry) => entry.scope === rule().scope) ?? initialRule}
              busy={saving()}
              onMerge={(merged) => {
                const theirs = current().current;
                setConflict(null);
                setRule(merged);
                setBase(theirs);
                void save(theirs);
              }}
              onDiscard={() => reloadAiArea()}
            />
          </Show>
        )}
      </Show>
      <Show
        when={!props.brake}
        fallback={
          <AiBackgroundBudget
            config={plain(config())}
            change={(next) => setConfig({ ...config(), ...next })}
            disabled={saving()}
            canRelease={!dirty()}
          />
        }
      >
        <fieldset class="grid gap-5" disabled={saving()}>
          <Select
            label={t().ruleScope}
            value={() => rule().scope}
            options={scopeOptions()}
            disabled={!isNew()}
            error={!scopeAvailable() ? t().scopeUsed : undefined}
            onValueChange={(scope) => scope && setRule((current) => ({ ...current, scope }))}
          />
          <Select
            label={t().rulePeriod}
            value={() => String(rule().hours)}
            options={[...new Set([...PERIODS, rule().hours])].map((hours) => ({ value: String(hours), label: periodLabel(hours) }))}
            onValueChange={(value) => value && setRule((current) => ({ ...current, hours: Number(value) }))}
          />
          <div class="grid gap-2">
            <span class="text-sm font-medium">{t().ruleGrants}</span>
            <ul class="grid gap-2">
              <For each={rule().grants}>
                {(grant, index) => (
                  <li class="grid grid-cols-[minmax(0,1fr)_9rem_auto] items-center gap-2">
                    <span class="truncate rounded-lg bg-(--k2b-surface-muted) px-3 py-2 text-sm">{principalLabel(grant, locale())}</span>
                    <NumberInput
                      aria-label={`${t().limitFor} ${principalLabel(grant, locale())}`}
                      value={() => grant.limit}
                      min={0}
                      step={0.01}
                      suffix={unit()}
                      placeholder={t().unlimited}
                      onValueChange={(limit) => updateGrant(index(), limit)}
                    />
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      label={t().delete}
                      onClick={() =>
                        setRule((current) => ({ ...current, grants: current.grants.filter((_, position) => position !== index()) }))
                      }
                    >
                      <i class="ti ti-x" aria-hidden="true" />
                    </IconButton>
                  </li>
                )}
              </For>
            </ul>
            <div class="max-w-md">
              <PrincipalPicker
                existing={rule().grants.map((grant) => grant.principal)}
                allowAuthenticated
                allowServiceAccounts
                placeholder={t().addPrincipal}
                onSelect={(principal: Principal, display) => {
                  // Budgets need an identity; the picker never offers public access here.
                  if (principal.type === "public") return;
                  setRule((current) => ({
                    ...current,
                    grants: [
                      ...current.grants,
                      { principal, displayName: display.displayName, serviceAccountKind: display.serviceAccountKind, limit: 10 },
                    ],
                  }));
                }}
              />
            </div>
          </div>
        </fieldset>
        <Show when={!isNew()}>
          <section class="grid gap-2">
            <h3 class="text-sm font-semibold">{t().usageNow}</h3>
            <div class="grid grid-cols-2 gap-2">
              <div class="rounded-lg bg-(--k2b-surface-muted) px-3 py-2.5">
                <p class="text-lg font-semibold tabular-nums">{original()?.peopleAtLimit ?? 0}</p>
                <p class="text-xs text-(--k2b-text-muted)">
                  {t().people} · {t().exhausted}
                </p>
              </div>
              <div class="rounded-lg bg-(--k2b-surface-muted) px-3 py-2.5">
                <p class="text-lg font-semibold tabular-nums">
                  {new Intl.DateTimeFormat(locale(), { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(nextReset(rule()))}
                </p>
                <p class="text-xs text-(--k2b-text-muted)">{t().nextReset}</p>
              </div>
            </div>
            <Show when={(original()?.peopleAtLimit ?? 0) > 0}>
              <NoticeCard tone="warning" icon="ti ti-gauge" title={t().atLimitNote({ p: original()?.peopleAtLimit ?? 0 })} />
            </Show>
          </section>
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="text-(--k2b-danger-text)"
              disabled={saving()}
              onClick={() => void remove()}
            >
              <i class="ti ti-trash" aria-hidden="true" />
              {t().deleteRule}
            </Button>
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        <NoticeCard tone="danger" title={t().saveFailed} detail={error()} role="alert" />
      </Show>
    </div>
  );
}
