import { PrincipalPicker, principalLabel } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { Principal } from "@k2b/cloud/contracts";
import { AiQuotaConfigSchema, type AiQuotaRule, AiQuotaRuleSchema } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import {
  Bar,
  Button,
  Cells,
  Check,
  Field,
  Icon,
  Input,
  Menu,
  type NavProps,
  Notice,
  Pane,
  Path,
  Row,
  Section,
  Select,
  Table,
  Text,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import AiBackgroundBudget from "../settings/_components/AiBackgroundBudget";
import { aiAreaHref } from "./area";
import type { AiBudgetConfig, AiBudgetsData } from "./catalog-data";
import { type AiAdminConflict, asAiConflict, assertAiAdmin, reloadAiArea } from "./client";
import { ConflictNotice } from "./conflict";
import { AI_COLOR, aiAreaLink, aiSectionLabel } from "./frame";
import { aiMoney } from "./ModelDetail";
import { aiAreaMessages } from "./messages";
import type { AiAreaMessages } from "./presentation";
import { AiQuotaAdminConfigSchema } from "./read-shapes";

type Rule = AiBudgetConfig["rules"][number];
type Model = AiBudgetsData["models"][number];

const api = coreClient.admin.core["ai-quotas"];
const PERIODS = [24, 168, 720] as const;
const plain = (config: AiBudgetConfig) =>
  AiQuotaConfigSchema.parse({ ...config, rules: config.rules.map(({ peopleAtLimit: _, ...rule }) => rule) });
const brakeDraft = (config: AiBudgetConfig) => ({
  unit: config.unit,
  enabled: config.background?.enabled ?? false,
  warnAt: config.background?.warnAt ?? null,
  stopAt: config.background?.stopAt ?? 10,
});

/** The next start of a rule's period after now, from its anchor. */
const nextReset = (rule: Pick<AiQuotaRule, "anchor" | "hours">, now = Date.now()) => {
  const period = rule.hours * 3_600_000;
  const anchor = Date.parse(rule.anchor);
  return new Date(anchor + Math.ceil((now - anchor) / period) * period);
};

const period = (t: AiAreaMessages, hours: number) =>
  hours === 24 ? t.perDay : hours === 168 ? t.perWeek : hours === 720 ? t.perMonth : t.perHours({ p: hours });

/**
 * Budgets on v2: what AI cost in the last 30 days leads, then the rules as a table, the background brake and the
 * personalization budget; the open rule or the brake beside them (`rule` in the address; `rule=new` for a new one).
 * "Budgets aktiv" in the head turns every rule on or off at once.
 */
export default function BudgetsScreen(props: { nav: NavProps; data: AiBudgetsData; rule: string | null }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const toast = useToast();
  const config = () => props.data.config;
  const unit = () => config().unit ?? "EUR";
  const money = (value: number | null) => (value === null ? t().unlimited : aiMoney(locale(), value, unit(), 2));
  const scopeName = (scope: string) =>
    scope === "*" ? t().allModels : (props.data.models.find((model) => model.id === scope)?.label ?? scope);
  const grantName = (grant: Rule["grants"][number]) =>
    grant.principal.type === "authenticated" ? t().accessAll : (grant.displayName ?? principalLabel(grant, locale()));
  const background = () => config().background;
  const atLimit = () => config().rules.reduce((sum, rule) => sum + (rule.peopleAtLimit ?? 0), 0);
  const open = () => props.rule;
  const [toggling, setToggling] = createSignal(false);
  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await assertAiAdmin(await api.$put({ json: plain({ ...config(), enabled }) }), t().budgetsToggleFailed);
      reloadAiArea();
    } catch (failure) {
      toast(failure instanceof Error ? failure.message : t().budgetsToggleFailed, { status: "bad" });
      setToggling(false);
    }
  };
  const spend = () => props.data.spend;
  /** Active chat models without prices: budgets never limit them, as the rules editor always said. */
  const unpriced = () => props.data.models.filter((model) => !model.priced).map((model) => model.label);

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={open() ? 520 : undefined}
      head={
        <Bar
          start={
            <Path
              label={aiSectionLabel(locale(), "budgets")}
              items={[aiAreaLink(locale()), { label: aiSectionLabel(locale(), "budgets") }]}
            />
          }
          end={
            <Button variant={open() ? undefined : "primary"} icon="plus" href={aiAreaHref({ sec: "budgets", rule: "new" })}>
              {t().addRule}
            </Button>
          }
        />
      }
      primary={open() ? undefined : { label: t().addRule, icon: "plus", href: aiAreaHref({ sec: "budgets", rule: "new" }) }}
    >
      <Pane.Split>
        <Pane
          label={aiSectionLabel(locale(), "budgets")}
          width={open() ? { min: 420, default: 600 } : undefined}
          scrollKey="admin-ai-budgets"
        >
          {/* k2b-ui gap: Hero figure (#4360); the spending of 30 days leads as the first cell with its real days until the hero band exists */}
          <Cells>
            <Cells.Cell
              icon="coin"
              color={AI_COLOR}
              label={t().spend30}
              value={spend() ? (spend()!.cost === null ? t().noDataShort : money(spend()!.cost)) : t().noDataShort}
              meta={spend() ? t().spendMeta({ p: spend()!.accounts.toLocaleString(locale()) }) : t().loadFailed}
              // slot for #4208/#4223 (DP): Cells trend, the 30 days of spend (spend().days) as a spark with t().spendTrend
              href={aiAreaHref({ sec: "budgets", rule: "people" })}
            />
            <Cells.Cell
              icon="gauge"
              label={t().rules}
              value={String(config().rules.length)}
              meta={
                atLimit() > 0
                  ? t().atLimit({ p: atLimit().toLocaleString(locale()) })
                  : config().enabled
                    ? t().budgetsActive
                    : t().budgetsOff
              }
            />
            <Cells.Cell
              icon="hand-stop"
              label={t().brake}
              value={background()?.enabled ? t().on : t().off}
              meta={
                background()?.enabled
                  ? t().brakeOn({ warn: money(background()!.warnAt), stop: money(background()!.stopAt) })
                  : t().brakeOffSub
              }
              href={aiAreaHref({ sec: "budgets", rule: "brake" })}
            />
          </Cells>
          <Show when={unpriced().length > 0}>
            <Notice tone="note" icon="coin-off">
              {t().unpricedModels({ p: unpriced().length, names: unpriced().slice(0, 5).join(", ") })}
            </Notice>
          </Show>
          <Show when={(spend()?.unknown ?? 0) > 0}>
            <Notice tone="warn">{t().spendUnknown({ p: spend()!.unknown })}</Notice>
          </Show>
          <Section
            icon="gauge"
            title={t().rules}
            count={config().rules.length}
            summary={t().unitLine({ p: unit() })}
            more={{ label: t().peopleUsage, href: aiAreaHref({ sec: "budgets", rule: "people" }), forward: true }}
          >
            {/* every rule on or off at once; it stands with the rules, so the phone keeps it too */}
            {/* slot for #4208/#4223 (DP): this field becomes a Setting row (name left, value at a fixed width) */}
            <Field label={t().budgetsOn} hint={t().budgetsOnHint}>
              <Check
                switch
                label={config().enabled ? t().on : t().off}
                checked={config().enabled}
                disabled={toggling()}
                onChange={(enabled) => void toggle(enabled)}
              />
            </Field>
            <Table
              label={t().rules}
              rows={config().rules}
              rowKey={(rule) => rule.scope}
              current={open() ?? undefined}
              open={(rule) => ({ href: aiAreaHref({ sec: "budgets", rule: rule.scope }) })}
              empty={{
                icon: "gauge",
                text: `${t().noRules}. ${t().noRulesSub}`,
                action: { label: t().addRule, icon: "plus", href: aiAreaHref({ sec: "budgets", rule: "new" }) },
              }}
              phone={(rule) => ({
                // slot for #4208/#4223 (DP): the scope's mark (stack-2 for all, cube for one) in AI_COLOR leads the phone row
                lines: [scopeName(rule.scope), `${grantLine(t(), rule, grantName, money)} · ${period(t(), rule.hours)}`],
                time: (rule.peopleAtLimit ?? 0) > 0 ? t().atLimitShort({ p: rule.peopleAtLimit ?? 0 }) : undefined,
              })}
              columns={[
                {
                  title: t().ruleScope,
                  width: { min: 150, default: 190 },
                  // slot for #4208/#4223 (DP): Column mark, stack-2 for all models or cube for one, in AI_COLOR
                  cell: (rule) => scopeName(rule.scope),
                },
                { title: t().rulePeriod, width: { min: 90, default: 110 }, drop: true, cell: (rule) => period(t(), rule.hours) },
                {
                  title: t().usageNow,
                  width: { min: 110, default: 130 },
                  cell: (rule) =>
                    (rule.peopleAtLimit ?? 0) > 0 ? (
                      <Text tone="warn" weight="medium">
                        <Icon name="point-filled" /> {t().atLimitShort({ p: (rule.peopleAtLimit ?? 0).toLocaleString(locale()) })}
                      </Text>
                    ) : (
                      ""
                    ),
                },
                { title: t().ruleGrants, cell: (rule) => grantLine(t(), rule, grantName, money) },
              ]}
            />
          </Section>
          <Section icon="clock-bolt" title={t().jobs}>
            <Row
              icon="user-cog"
              color={AI_COLOR}
              lines={[
                t().persBudget,
                props.data.personalizationTokens
                  ? t().persTokens({ p: props.data.personalizationTokens.toLocaleString(locale()) })
                  : t().editInJobs,
              ]}
              href={aiAreaHref({ sec: "jobs" })}
            />
          </Section>
        </Pane>
        <Show when={open()} keyed>
          {(rule) => <BudgetDetail config={config()} rule={rule} models={props.data.models} brake={props.data.brake} />}
        </Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}

/** Who gets how much: the first grant and how many more; the period stands in its own column. */
const grantLine = (
  t: AiAreaMessages,
  rule: Rule,
  name: (grant: Rule["grants"][number]) => string,
  money: (value: number | null) => string,
) =>
  [
    rule.grants[0] ? `${name(rule.grants[0])} · ${money(rule.grants[0].limit)}` : t.noGrants,
    rule.grants.length > 1 ? t.moreGrants({ p: rule.grants.length - 1 }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * A6 detail: one budget rule (what it covers, the period, who gets how much, the state now) or the background brake.
 * "Speichern" in its head writes the whole budget configuration with its revision, as the rules editor always did.
 */
function BudgetDetail(props: { config: AiBudgetConfig; rule: string; models: Model[]; brake: AiBudgetsData["brake"] }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const toast = useToast();
  const brake = () => props.rule === "brake";
  const scope = () => (props.rule === "new" || props.rule === "brake" ? null : props.rule);
  const [base, setBase] = createSignal(props.config);
  const original = () => base().rules.find((rule) => rule.scope === scope());
  const fresh = (): Rule => ({ scope: "*", hours: 168, anchor: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`, grants: [] });
  const initialRule = structuredClone(original() ?? fresh());
  const [rule, setRule] = createSignal<Rule>(initialRule);
  const [config, setConfig] = createSignal(structuredClone(props.config));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<AiBudgetConfig> | null>(null);
  const unit = () => base().unit ?? "EUR";
  const missing = () => !brake() && scope() !== null && !original();
  const isNew = () => !brake() && !original();
  const scopeAvailable = () => !isNew() || !base().rules.some((entry) => entry.scope === rule().scope);
  const dirty = () =>
    brake() ? JSON.stringify(config()) !== JSON.stringify(base()) : isNew() || JSON.stringify(rule()) !== JSON.stringify(original());

  const nextConfig = (current: AiBudgetConfig): AiBudgetConfig =>
    brake()
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
      toast(t().saved, { status: "ok" });
      reloadAiArea(isNew() ? aiAreaHref({ sec: "budgets" }, { rule: rule().scope }) : undefined);
    } catch (failure) {
      const found = asAiConflict(failure, AiQuotaAdminConfigSchema);
      if (found) setConflict(found);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await assertAiAdmin(
        await api.$put({ json: plain({ ...base(), rules: base().rules.filter((entry) => entry.scope !== scope()) }) }),
        t().saveFailed,
      );
      reloadAiArea(aiAreaHref({ sec: "budgets" }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  const usedScopes = () =>
    base()
      .rules.map((entry) => entry.scope)
      .filter((entry) => entry !== scope());
  // a stored rule whose model left the catalog keeps its scope visible (and editable in every other field)
  const scopeOptions = () => [
    ...(rule().scope !== "*" && !props.models.some((model) => model.id === rule().scope)
      ? [{ value: rule().scope, label: rule().scope }]
      : []),
    { value: "*", label: t().allModels, disabled: usedScopes().includes("*") },
    ...props.models
      .filter((model) => model.priced)
      .map((model) => ({ value: model.id, label: model.label, disabled: usedScopes().includes(model.id) })),
  ];
  const updateGrant = (index: number, limit: number | null) =>
    setRule((current) => ({
      ...current,
      grants: current.grants.map((grant, position) => (position === index ? { ...grant, limit } : grant)),
    }));
  const title = () =>
    brake()
      ? t().brake
      : isNew()
        ? t().newRule
        : rule().scope === "*"
          ? t().allModels
          : (props.models.find((model) => model.id === rule().scope)?.label ?? rule().scope);
  const back = { label: aiSectionLabel(locale(), "budgets"), href: aiAreaHref({ sec: "budgets" }) };

  return (
    <Pane
      detail
      label={title()}
      back={back}
      scrollKey="admin-ai-budget"
      head={
        <Bar
          start={
            // slot for #4208/#4223 (DP): the tinted object head (ObjectHead, #4360) with the mark (hand-stop, stack-2 or cube) in AI_COLOR; the name stands in
            <Text type="body">{title()}</Text>
          }
          end={
            <>
              <Show when={!brake() && !isNew()}>
                {/* k2b-ui gap: a destructive question asks with a red button once #4275 lands (danger: true). */}
                <Menu
                  label={t().moreActions}
                  items={[{ label: t().deleteRule, icon: "trash", danger: true, disabled: saving(), onClick: () => void remove() }]}
                />
              </Show>
              <Button
                variant="primary"
                icon="check"
                keep
                busy={saving()}
                disabled={!dirty() || Boolean(conflict()) || (!brake() && !scopeAvailable()) || missing()}
                onClick={() => void save()}
              >
                {t().save}
              </Button>
            </>
          }
        />
      }
    >
      <Show when={conflict()}>
        {(current) => (
          <Show
            when={!brake()}
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
      <Show when={error()}>
        <Notice tone="bad" title={t().saveFailed}>
          {error()}
        </Notice>
      </Show>
      <Show
        when={!brake()}
        fallback={
          <AiBackgroundBudget
            config={plain(config())}
            change={(next) => setConfig({ ...config(), ...next })}
            disabled={saving()}
            canRelease={!dirty()}
            initial={props.brake}
          />
        }
      >
        <Show when={!missing()} fallback={<Notice tone="bad">{t().ruleMissing}</Notice>}>
          <Section icon="settings" title={t().ruleSettings}>
            {/* slot for #4208/#4223 (DP): the fields of this rule and its grants become Setting rows (name left, value at a fixed width) */}
            <Field label={t().ruleScope} error={!scopeAvailable() ? t().scopeUsed : undefined}>
              <Select
                value={rule().scope}
                options={scopeOptions()}
                disabled={!isNew() || saving()}
                onChange={(next) => setRule((current) => ({ ...current, scope: next }))}
              />
            </Field>
            <Field label={t().rulePeriod}>
              <Select
                value={String(rule().hours)}
                disabled={saving()}
                options={[...new Set([...PERIODS, rule().hours])].map((hours) => ({ value: String(hours), label: period(t(), hours) }))}
                onChange={(value) => setRule((current) => ({ ...current, hours: Number(value) }))}
              />
            </Field>
          </Section>
          <Section icon="users" title={t().ruleGrants} count={rule().grants.length}>
            <For each={rule().grants}>
              {(grant, index) => (
                <Field
                  label={principalLabel(grant, locale())}
                  action={{
                    label: t().delete,
                    icon: "x",
                    disabled: saving(),
                    onClick: () =>
                      setRule((current) => ({ ...current, grants: current.grants.filter((_, position) => position !== index()) })),
                  }}
                >
                  <Input
                    type="number"
                    min={0}
                    label={`${t().limitFor} ${principalLabel(grant, locale())}`}
                    value={grant.limit === null ? "" : String(grant.limit)}
                    placeholder={t().unlimited}
                    disabled={saving()}
                    end={<Text type="meta">{unit()}</Text>}
                    onInput={(value) => updateGrant(index(), value.trim() === "" ? null : Number(value))}
                  />
                </Field>
              )}
            </For>
            {/* k2b-ui gap: no person and group picker in v2; the v1 picker stands in */}
            <Field label={t().addPrincipalLabel}>
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
            </Field>
          </Section>
          <Show when={!isNew()}>
            <Section icon="activity" title={t().usageNow}>
              <Cells>
                <Cells.Cell icon="users" label={t().peopleExhausted} value={String(original()?.peopleAtLimit ?? 0)} />
                <Cells.Cell
                  icon="calendar-repeat"
                  label={t().nextReset}
                  value={new Intl.DateTimeFormat(locale(), { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(
                    nextReset(rule()),
                  )}
                />
              </Cells>
              <Show when={(original()?.peopleAtLimit ?? 0) > 0}>
                <Notice
                  tone="warn"
                  icon="gauge"
                  actions={[{ label: t().peopleUsage, href: aiAreaHref({ sec: "budgets", rule: "people" }) }]}
                >
                  {t().atLimitNote({ p: original()?.peopleAtLimit ?? 0 })}
                </Notice>
              </Show>
            </Section>
          </Show>
        </Show>
      </Show>
    </Pane>
  );
}
