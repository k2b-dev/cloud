import { coreClient } from "@k2b/cloud/clients/core";
import {
  GEO_PLAN_IDS,
  GEO_USAGE_GROUPS,
  type GeoAdminStatus,
  type GeoAdminUsage,
  type GeoBudgetField,
  type GeoBudgetFieldError,
  GeoBudgetRefusalSchema,
  type GeoPlanId,
  geoKeyProblem,
  validateGeoBudget,
} from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Dialog,
  Facts,
  Failed,
  Field,
  Input,
  Loading,
  type NavProps,
  Notice,
  Row,
  Section,
  Select,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createSignal, type JSX, Match, Show, Switch } from "solid-js";
import { BaseFrame } from "../base/BaseScreen";
import { placesAndMapsMessages } from "./messages";

const api = coreClient.admin.core.geo;
/** A map question ("museums in Ulm") costs about 6 reference credits: geocoding, a place search and one map view. */
const PLAN_NAMES: Record<Exclude<GeoPlanId, "custom">, string> = {
  free: "Free",
  api10: "API 10",
  api25: "API 25",
  api50: "API 50",
  api100: "API 100",
  api250: "API 250",
};

export type PlacesAndMapsInitial = {
  status: GeoAdminStatus | null;
  usage: GeoAdminUsage | null;
  /** The signed-in administrator: only their own change proves that an unanswered write landed. */
  actorId: string;
};
type Load = "ready" | "loading" | "error";
type KeyPhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "failed"; reason: "rejected" | "unverified" | "no-answer"; hadKey: boolean }
  | { kind: "removing" };
type SavePhase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "invalid"; count: number }
  | { kind: "failed" };
type BudgetValues = { plan: GeoPlanId } & Record<GeoBudgetField, string>;

const isStatus = (value: unknown): value is GeoAdminStatus =>
  typeof value === "object" && value !== null && "key" in value && "budget" in value && "plans" in value;
const isUsage = (value: unknown): value is GeoAdminUsage =>
  typeof value === "object" && value !== null && "month" in value && "today" in value && "shares" in value;
const codeOf = (value: unknown): string =>
  typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" ? value.code : "";

/**
 * Places & maps on v2, a section of the Base settings area: the Geoapify key, checked before it applies; the plan and
 * monthly budget, saved as one; and this month's usage. The server reads status and usage with the page; a write that
 * lost its answer is settled by reading the stored state again, never by saving twice.
 */
export default function PlacesAndMaps(props: { nav: NavProps; documentationHref?: string; initial: PlacesAndMapsInitial }): JSX.Element {
  const locale = useLocale();
  const t = () => placesAndMapsMessages.resolve([locale()]).t;
  const toast = useToast();
  const [status, setStatus] = createSignal<GeoAdminStatus | null>(props.initial.status);
  const [statusLoad, setStatusLoad] = createSignal<Load>(props.initial.status ? "ready" : "error");
  const [usage, setUsage] = createSignal<GeoAdminUsage | null>(props.initial.usage);
  const [usageLoad, setUsageLoad] = createSignal<Load>(props.initial.usage ? "ready" : "error");
  const [replacing, setReplacing] = createSignal(false);
  const [keyPhase, setKeyPhase] = createSignal<KeyPhase>({ kind: "idle" });
  const [keyInput, setKeyInput] = createSignal("");
  const [keyFieldError, setKeyFieldError] = createSignal<string>();
  const [savePhase, setSavePhase] = createSignal<SavePhase>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = createSignal<Partial<Record<GeoBudgetField, GeoBudgetFieldError>>>({});

  const timezone = () => status()?.timezone ?? usage()?.timezone ?? "UTC";
  const number = (value: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Math.round(value));
  const date = (iso: string) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: timezone() }).format(new Date(iso));
  const clock = (at: Date) => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timezone() }).format(at);
  const resetWhen = (iso: string) =>
    t().resetWhen({
      date: new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", timeZone: timezone() }).format(new Date(iso)),
      time: new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit", timeZone: timezone() }).format(new Date(iso)),
    });
  const monthName = (period: string) =>
    new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" }).format(new Date(`${period}-15T12:00:00Z`));

  // ── Budget form ────────────────────────────────────────────────────────
  const fromStatus = (value: GeoAdminStatus | null): BudgetValues => ({
    plan: value?.budget.plan ?? "free",
    customRps: value ? number(value.budget.customRps) : "",
    customDailyCredits: value ? number(value.budget.customDailyCredits) : "",
    monthlyCredits: value && !value.budget.unreadable.includes("monthlyCredits") ? number(value.budget.monthlyCredits) : "",
  });
  const [values, setValues] = createSignal<BudgetValues>(fromStatus(props.initial.status));
  const setValue = (field: GeoBudgetField, value: string) => setValues((current) => ({ ...current, [field]: value }));
  /** Whole numbers in the reader's format: "90.000" in German, "90,000" in English, or plain digits. */
  const parseWhole = (text: string): number | null => {
    const raw = text.replace(/[\s  ]/g, "");
    if (/^\d+$/.test(raw)) return Number(raw);
    const group = new Intl.NumberFormat(locale()).formatToParts(10000).find((part) => part.type === "group")?.value ?? ",";
    const escaped = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\d{1,3}(${escaped}\\d{3})+$`).test(raw) ? Number(raw.split(group).join("")) : null;
  };
  const planDaily = () => {
    const plan = values().plan;
    if (plan !== "custom") return status()?.plans[plan].dailyCredits ?? null;
    return parseWhole(values().customDailyCredits);
  };
  const keyOff = () => status()?.key.state !== "set";
  const budgetDisabled = () => statusLoad() !== "ready" || keyOff() || savePhase().kind === "saving";

  const errorText = (error: GeoBudgetFieldError | undefined): string | undefined => {
    if (!error) return undefined;
    if (error.code === "not_whole_number") return t().notWholeNumber;
    if (error.code === "too_small") return t().tooSmall({ min: number(error.min) });
    if (error.code === "too_large") return t().tooLarge({ max: number(error.max) });
  };

  const readStatus = async (): Promise<GeoAdminStatus | null> => {
    try {
      const response = await api.$get();
      const body: unknown = await response.json().catch(() => null);
      return response.ok && isStatus(body) ? body : null;
    } catch {
      return null;
    }
  };
  const save = async () => {
    const current = values();
    const input = {
      plan: current.plan,
      customRps: parseWhole(current.customRps),
      customDailyCredits: parseWhole(current.customDailyCredits),
      monthlyCredits: parseWhole(current.monthlyCredits),
    };
    const errors = validateGeoBudget(input);
    setFieldErrors(errors);
    if (Object.keys(errors).length) return void setSavePhase({ kind: "invalid", count: Object.keys(errors).length });
    setSavePhase({ kind: "saving" });
    try {
      const response = await api.budget.$put({ json: input });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isStatus(body)) return saved(body);
      const refusal = GeoBudgetRefusalSchema.safeParse(body);
      if (response.status === 400 && refusal.success) {
        setFieldErrors(refusal.data.errors);
        return void setSavePhase({ kind: "invalid", count: Math.max(1, Object.keys(refusal.data.errors).length) });
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 408) return void setSavePhase({ kind: "failed" });
    } catch {
      // A lost answer may hide a commit; read the stored values before saying anything.
    }
    // Only the stored values themselves prove this save: another tab may have written in between.
    const after = await readStatus();
    const stored = after?.budget;
    if (
      after &&
      stored &&
      // A value this installation cannot read shows its default; it would only look like the submitted one.
      stored.unreadable.length === 0 &&
      stored.plan === input.plan &&
      stored.monthlyCredits === input.monthlyCredits &&
      (input.plan !== "custom" || (stored.customRps === input.customRps && stored.customDailyCredits === input.customDailyCredits))
    )
      return saved(after);
    setSavePhase({ kind: "failed" });
  };
  const saved = (next: GeoAdminStatus) => {
    setStatus(next);
    setValues(fromStatus(next));
    setFieldErrors({});
    setSavePhase({ kind: "saved", at: new Date() });
    void loadUsage();
  };

  // ── Key ────────────────────────────────────────────────────────────────
  let keyField: HTMLInputElement | HTMLTextAreaElement | undefined;
  const focusKey = () => queueMicrotask(() => keyField?.focus());
  const resetKeyForm = () => {
    setKeyInput("");
    setKeyFieldError(undefined);
    setKeyPhase({ kind: "idle" });
  };
  const startReplace = () => {
    resetKeyForm();
    setReplacing(true);
    focusKey();
  };
  const backToView = () => {
    resetKeyForm();
    setReplacing(false);
  };
  const editAgain = () => {
    setKeyPhase({ kind: "idle" });
    focusKey();
  };
  const checkKey = async () => {
    const apiKey = keyInput().trim();
    const problem = geoKeyProblem(apiKey);
    if (problem) {
      setKeyFieldError(problem === "geo_key_missing" ? t().missingKey : t().malformedKey);
      return focusKey();
    }
    setKeyFieldError(undefined);
    const hadKey = status()?.key.state === "set";
    setKeyPhase({ kind: "checking" });
    const fail = (reason: "rejected" | "unverified" | "no-answer") => setKeyPhase({ kind: "failed", reason, hadKey });
    try {
      const response = await api.key.$put({ json: { apiKey } });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isStatus(body)) return keySaved(body);
      const code = codeOf(body);
      if (code === "geo_key_rejected") return fail("rejected");
      if (code === "geo_key_unverified") return fail("unverified");
      if (code === "geo_key_missing" || code === "geo_key_malformed") {
        setKeyPhase({ kind: "idle" });
        return void setKeyFieldError(code === "geo_key_missing" ? t().missingKey : t().malformedKey);
      }
    } catch {
      // Reconcile below: the key may have been stored before the answer was lost.
    }
    // A stored key cannot be compared with the typed one, so a lost answer stays open; checking again is idempotent.
    const after = await readStatus();
    if (after) setStatus(after);
    fail("no-answer");
  };
  const keySaved = (next: GeoAdminStatus) => {
    setStatus(next);
    backToView();
    toast(t().keySaved, { status: "ok" });
    void loadUsage();
  };
  const removeKey = async () => {
    if (!(await Dialog.confirm({ title: t().removeQuestionFull, description: t().removeWhy, confirm: t().removeConfirm }))) return;
    setKeyPhase({ kind: "removing" });
    let next: GeoAdminStatus | null = null;
    try {
      const response = await api.key.$delete();
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isStatus(body)) next = body;
    } catch {
      // Removal is idempotent; read the state to learn whether it happened.
    }
    if (!next) {
      const after = await readStatus();
      if (after?.key.state === "none") next = after;
    }
    setKeyPhase({ kind: "idle" });
    if (!next) return void toast(t().removeFailed, { status: "bad" });
    setStatus(next);
    backToView();
    toast(t().keyRemoved, { status: "ok" });
  };

  // ── Loading again after a failure ──────────────────────────────────────
  const loadUsage = async () => {
    setUsageLoad("loading");
    try {
      const response = await api.usage.$get();
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isUsage(body)) throw new Error("usage");
      setUsage(body);
      setUsageLoad("ready");
    } catch {
      setUsageLoad("error");
    }
  };
  const loadAll = async () => {
    setStatusLoad("loading");
    void loadUsage();
    const next = await readStatus();
    if (!next) return void setStatusLoad("error");
    setStatus(next);
    setValues(fromStatus(next));
    setStatusLoad("ready");
  };

  // ── Parts ──────────────────────────────────────────────────────────────
  const keyMeta = () => {
    const key = status()?.key;
    if (!key?.setAt) return t().euEndpoint;
    const since = key.setBy ? t().keySinceBy({ date: date(key.setAt), name: key.setBy.name }) : t().keySince({ date: date(key.setAt) });
    return `${since} · ${t().euEndpoint}`;
  };
  const failure = () => {
    const phase = keyPhase();
    return phase.kind === "failed" ? phase : undefined;
  };
  const failureDetail = (phase: Extract<KeyPhase, { kind: "failed" }>) =>
    phase.reason === "rejected"
      ? phase.hadKey
        ? t().rejectedDetailKeep
        : t().rejectedDetail
      : phase.reason === "unverified"
        ? phase.hadKey
          ? t().unverifiedDetailKeep
          : t().unverifiedDetail
        : t().noAnswerDetail;

  const keyForm = (label: string, hint: string, submit: string, cancel: boolean) => (
    <>
      <Field name="geo-key" label={label} hint={hint} error={keyFieldError()}>
        <Input
          type="password"
          icon="key"
          placeholder={t().keyPlaceholder}
          value={keyInput()}
          disabled={keyPhase().kind === "checking"}
          ref={(element) => {
            keyField = element;
          }}
          onInput={(next) => {
            setKeyInput(next);
            setKeyFieldError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void checkKey();
          }}
        />
      </Field>
      <Bar
        end={
          <>
            <Show when={cancel}>
              <Button disabled={keyPhase().kind === "checking"} onClick={backToView}>
                {t().cancel}
              </Button>
            </Show>
            <Button busy={keyPhase().kind === "checking"} onClick={() => void checkKey()}>
              {submit}
            </Button>
          </>
        }
      />
    </>
  );

  const keySection = () => (
    <Section
      icon="key"
      title={t().key}
      actions={
        status()?.key.state === "set" && !replacing()
          ? [
              { label: t().replace, icon: "replace", onClick: startReplace },
              { label: t().remove, icon: "trash", onClick: () => void removeKey(), disabled: keyPhase().kind === "removing" },
            ]
          : undefined
      }
    >
      <Show when={failure()}>
        {(phase) => (
          <Notice
            tone="bad"
            title={phase().reason === "rejected" ? t().rejected : phase().reason === "unverified" ? t().unverified : t().noAnswer}
            actions={[
              { label: t().checkAgain, icon: "refresh", onClick: () => void checkKey() },
              { label: t().changeKey, onClick: editAgain },
            ]}
          >
            {failureDetail(phase())}
          </Notice>
        )}
      </Show>
      <Switch>
        <Match when={statusLoad() === "loading"}>
          <Loading />
        </Match>
        <Match when={statusLoad() === "error"}>
          <Failed text={t().loadFailed} onRetry={() => void loadAll()} />
        </Match>
        <Match when={status()?.key.state === "set"}>
          <Row lines={[t().keySet, keyMeta()]} icon="key" />
          <Show when={replacing()}>{keyForm(t().newKeyLabel, t().replaceHint, t().checkAndReplace, true)}</Show>
        </Match>
        <Match when={status()?.key.state === "unreadable"}>
          <Notice tone="warn" icon="key-off" title={t().unreadableKey}>
            {t().unreadableKeyDetail}
          </Notice>
          {keyForm(t().keyLabel, t().keyHint, t().checkAndSave, false)}
        </Match>
        <Match when={true}>
          <Row lines={[t().noKey, t().noKeyDetail]} icon="key" />
          {keyForm(t().keyLabel, t().keyHint, t().checkAndSave, false)}
        </Match>
      </Switch>
    </Section>
  );

  const numberField = (field: GeoBudgetField, label: string, hint: () => string) => (
    <Field
      name={field}
      label={label}
      error={errorText(fieldErrors()[field])}
      hint={status()?.budget.unreadable.includes(field) ? t().unreadableValue : hint()}
    >
      <Input value={values()[field]} disabled={budgetDisabled()} onInput={(next) => setValue(field, next)} />
    </Field>
  );
  const planOptions = () =>
    GEO_PLAN_IDS.map((plan) => {
      if (plan === "custom") return { value: plan, label: t().customPlan };
      const facts = status()?.plans[plan];
      return {
        value: plan,
        label: facts
          ? t().planOption({ name: PLAN_NAMES[plan], daily: number(facts.dailyCredits), rps: number(facts.rps) })
          : PLAN_NAMES[plan],
      };
    });
  const saveLine = () => {
    const phase = savePhase();
    if (phase.kind === "saving") return t().saving;
    if (phase.kind === "saved") return t().savedAt({ time: clock(phase.at) });
    if (phase.kind === "failed") return t().notSavedNoAnswer;
    if (phase.kind === "invalid") return phase.count > 1 ? t().notSavedFields : t().notSavedField;
    const budget = status()?.budget;
    if (!budget?.changedAt) return t().defaults;
    return budget.changedBy
      ? t().changedAtBy({ date: date(budget.changedAt), name: budget.changedBy.name })
      : t().changedAt({ date: date(budget.changedAt) });
  };
  const budgetSection = () => (
    <Section icon="coins" title={t().planAndBudget} summary={t().planAndBudgetLead}>
      <Field.Row>
        <Field name="plan" label={t().plan}>
          {/* k2b-ui gap: Select takes no `disabled`; while the budget is locked a choice is ignored. */}
          <Select
            options={planOptions()}
            value={values().plan}
            onChange={(next) => {
              const plan = GEO_PLAN_IDS.find((id) => id === next);
              if (plan && !budgetDisabled()) setValues((current) => ({ ...current, plan }));
            }}
          />
        </Field>
        {numberField("monthlyCredits", t().monthly, () =>
          t().monthlySuggestion({ daily: planDaily() === null ? "–" : number(planDaily() ?? 0) }),
        )}
      </Field.Row>
      <Show when={values().plan === "custom"}>
        <Field.Row>
          {numberField("customRps", t().customRps, () => t().customRpsHint)}
          {numberField("customDailyCredits", t().customDaily, () => t().customDailyHint)}
        </Field.Row>
      </Show>
      <Bar
        start={
          <Text type="meta" muted tone={savePhase().kind === "failed" || savePhase().kind === "invalid" ? "bad" : undefined}>
            {saveLine()}
          </Text>
        }
        end={
          <Button variant="primary" busy={savePhase().kind === "saving"} disabled={budgetDisabled()} onClick={() => void save()}>
            {t().save}
          </Button>
        }
      />
    </Section>
  );

  const share = (data: GeoAdminUsage, group: (typeof GEO_USAGE_GROUPS)[number]) => {
    const total = data.shares.reduce((sum, item) => sum + item.credits, 0);
    return new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(
      total ? (data.shares.find((item) => item.group === group)?.credits ?? 0) / total : 0,
    );
  };
  const shareLabel = (group: (typeof GEO_USAGE_GROUPS)[number]) =>
    group === "tiles" ? t().tiles : group === "places" ? t().places : group === "route" ? t().route : t().address;
  const usageSection = () => (
    <Section icon="chart-bar" title={t().usage} summary={t().usageHint}>
      <Switch>
        <Match when={statusLoad() === "ready" && keyOff()}>
          <Text muted>{t().usageAfterKey}</Text>
        </Match>
        <Match when={usageLoad() === "loading" || statusLoad() === "loading"}>
          <Loading />
        </Match>
        <Match when={usageLoad() === "error" || !usage()}>
          <Failed text={t().usageFailed} onRetry={() => void loadUsage()} />
        </Match>
        <Match when={usage()}>
          {(data) => (
            <>
              <Show when={data().month.used >= data().month.limit}>
                <Notice tone="warn" icon="hourglass" title={t().monthReached({ when: resetWhen(data().month.resetsAt) })}>
                  {t().monthReachedDetail}
                </Notice>
              </Show>
              <Show when={data().routeCostOverruns > 0}>
                <Notice tone="warn" title={t().routeCostOverruns({ count: number(data().routeCostOverruns) })}>
                  {t().routeCostOverrunsDetail}
                </Notice>
              </Show>
              <Facts
                items={[
                  {
                    label: monthName(data().month.period),
                    value: t().usageValue({ used: number(data().month.used), limit: number(data().month.limit) }),
                  },
                  { label: t().today, value: t().usageValue({ used: number(data().today.used), limit: number(data().today.allowance) }) },
                  ...(data().month.used > 0
                    ? GEO_USAGE_GROUPS.map((group) => ({ label: shareLabel(group), value: share(data(), group) }))
                    : []),
                ]}
              />
              <Show when={data().month.used === 0}>
                <Text muted>{t().noUsage}</Text>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </Section>
  );

  return (
    <BaseFrame nav={props.nav} section="places" documentationHref={props.documentationHref}>
      {keySection()}
      {budgetSection()}
      {usageSection()}
    </BaseFrame>
  );
}
