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
import { announce, Button, LabelChip, ProgressBar, Select, SettingsPage, SettingsSection, Skeleton, TextInput, useLocale } from "@k2b/ui";
import { createSignal, createUniqueId, For, type JSX, Match, Show, Switch } from "solid-js";
import DocumentationLink from "../settings/_components/DocumentationLink";
import { placesAndMapsMessages } from "./messages";

const api = coreClient.admin.core.geo;
/** A map question ("museums in Ulm") costs about 6 reference credits: geocoding, a place search and one map view. */
const CREDITS_PER_MAP_QUESTION = 6;
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
  | { kind: "removing" }
  | { kind: "remove-failed" };
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

/** A flat state row: round tone icon, title, detail and optional actions, on the page surface without a card. */
function StateRow(props: {
  tone: "neutral" | "danger" | "warning";
  icon: string;
  title: JSX.Element;
  detail?: JSX.Element;
  children?: JSX.Element;
  role?: "alert" | "status";
}) {
  const surface = () =>
    props.tone === "danger"
      ? "bg-[var(--k2b-danger-surface)] text-[var(--k2b-danger-text)]"
      : props.tone === "warning"
        ? "bg-[var(--k2b-warning-surface)] text-[var(--k2b-warning-text)]"
        : "bg-[var(--k2b-surface-muted)] text-[var(--k2b-text-muted)]";
  return (
    <div class="flex items-start gap-3" role={props.role}>
      <span class={`grid size-[34px] flex-none place-items-center rounded-full ${surface()}`} aria-hidden="true">
        <i class={`${props.icon} text-[17px]`} />
      </span>
      <div class="min-w-0 flex-1">
        <p class="m-0 font-semibold text-[var(--k2b-text)]">{props.title}</p>
        <Show when={props.detail}>
          <p class="m-0 text-[13.5px] text-[var(--k2b-text-muted)]">{props.detail}</p>
        </Show>
        <Show when={props.children}>
          <div class="mt-2 flex flex-wrap gap-2">{props.children}</div>
        </Show>
      </div>
    </div>
  );
}

function Calm(props: { icon: string; children: JSX.Element }) {
  return (
    <p class="m-0 flex min-h-[22px] items-start gap-2 text-[13.5px] text-[var(--k2b-text-muted)]" role="status">
      <i class={`${props.icon} mt-0.5 flex-none text-base`} aria-hidden="true" />
      <span>{props.children}</span>
    </p>
  );
}

export default function PlacesAndMaps(props: { initial: PlacesAndMapsInitial; documentationBase?: string }): JSX.Element {
  const locale = useLocale();
  const t = () => placesAndMapsMessages.resolve([locale()]).t;
  const [status, setStatus] = createSignal<GeoAdminStatus | null>(props.initial.status);
  const [statusLoad, setStatusLoad] = createSignal<Load>(props.initial.status ? "ready" : "error");
  const [usage, setUsage] = createSignal<GeoAdminUsage | null>(props.initial.usage);
  const [usageLoad, setUsageLoad] = createSignal<Load>(props.initial.usage ? "ready" : "error");
  const [keyMode, setKeyMode] = createSignal<"view" | "replace" | "remove">("view");
  const [keyPhase, setKeyPhase] = createSignal<KeyPhase>({ kind: "idle" });
  const [keyInput, setKeyInput] = createSignal("");
  const [keyFieldError, setKeyFieldError] = createSignal<string>();
  const [savePhase, setSavePhase] = createSignal<SavePhase>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = createSignal<Partial<Record<GeoBudgetField, GeoBudgetFieldError>>>({});

  const timezone = () => status()?.timezone ?? usage()?.timezone ?? "UTC";
  const number = (value: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Math.round(value));
  const date = (iso: string) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: timezone() }).format(new Date(iso));
  const clock = (at: Date) => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timezone() }).format(at);
  const resetTime = (iso: string) =>
    new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit", timeZone: timezone() }).format(new Date(iso));
  const resetWhen = (iso: string) =>
    t().resetWhen({
      date: new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", timeZone: timezone() }).format(new Date(iso)),
      time: resetTime(iso),
    });
  const monthName = (period: string) =>
    new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" }).format(new Date(`${period}-15T12:00:00Z`));

  // ── Budget form ────────────────────────────────────────────────────────
  const fromStatus = (value: GeoAdminStatus | null): BudgetValues => ({
    plan: value?.budget.plan ?? "free",
    customRps: value ? number(value.budget.customRps) : "",
    customDailyCredits: value ? number(value.budget.customDailyCredits) : "",
    monthlyCredits: value && !value.budget.unreadable.includes("monthlyCredits") ? number(value.budget.monthlyCredits) : "",
    personDailyCredits: value && !value.budget.unreadable.includes("personDailyCredits") ? number(value.budget.personDailyCredits) : "",
  });
  const [values, setValues] = createSignal<BudgetValues>(fromStatus(props.initial.status));
  const setValue = (field: GeoBudgetField, value: string) => setValues((current) => ({ ...current, [field]: value }));
  /** Whole numbers in the reader's format: "90.000" in German, "90,000" in English, or plain digits. */
  const parseWhole = (text: string): number | null => {
    const raw = text.replace(/[\s  ]/g, "");
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
    return t().aboveMonthly({ max: number(error.max) });
  };

  const save = async () => {
    const current = values();
    const input = {
      plan: current.plan,
      customRps: parseWhole(current.customRps),
      customDailyCredits: parseWhole(current.customDailyCredits),
      monthlyCredits: parseWhole(current.monthlyCredits),
      personDailyCredits: parseWhole(current.personDailyCredits),
    };
    const errors = validateGeoBudget(input);
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      setSavePhase({ kind: "invalid", count: Object.keys(errors).length });
      announce(Object.keys(errors).length > 1 ? t().notSavedFields : t().notSavedField, { politeness: "assertive" });
      return;
    }
    setSavePhase({ kind: "saving" });
    try {
      const response = await api.budget.$put({ json: input });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isStatus(body)) return saved(body);
      const refusal = GeoBudgetRefusalSchema.safeParse(body);
      if (response.status === 400 && refusal.success) {
        const server = refusal.data.errors;
        setFieldErrors(server);
        setSavePhase({ kind: "invalid", count: Math.max(1, Object.keys(server).length) });
        return;
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 408) return failSave();
    } catch {
      // A lost answer may hide a commit; read the stored values before saying anything.
    }
    // Only the stored values themselves prove this save: another tab may have written in between.
    const after = await readStatus();
    const stored = after?.budget;
    if (
      stored &&
      // A value this installation cannot read shows its default; it would only look like the submitted one.
      stored.unreadable.length === 0 &&
      stored.plan === input.plan &&
      stored.monthlyCredits === input.monthlyCredits &&
      stored.personDailyCredits === input.personDailyCredits &&
      (input.plan !== "custom" || (stored.customRps === input.customRps && stored.customDailyCredits === input.customDailyCredits))
    )
      return saved(after);
    failSave();
  };
  const saved = (next: GeoAdminStatus) => {
    setStatus(next);
    setValues(fromStatus(next));
    setFieldErrors({});
    const at = new Date();
    setSavePhase({ kind: "saved", at });
    announce(t().savedAt({ time: clock(at) }));
    void loadUsage();
  };
  const failSave = () => {
    setSavePhase({ kind: "failed" });
    announce(t().notSavedNoAnswer, { politeness: "assertive" });
  };

  // ── Key ────────────────────────────────────────────────────────────────
  const readStatus = async (): Promise<GeoAdminStatus | null> => {
    try {
      const response = await api.$get();
      const body: unknown = await response.json().catch(() => null);
      return response.ok && isStatus(body) ? body : null;
    } catch {
      return null;
    }
  };
  let keyField: HTMLInputElement | undefined;
  const focusKey = () => queueMicrotask(() => keyField?.focus());
  const startReplace = () => {
    setKeyInput("");
    setKeyFieldError(undefined);
    setKeyPhase({ kind: "idle" });
    setKeyMode("replace");
    focusKey();
  };
  const backToView = () => {
    setKeyInput("");
    setKeyFieldError(undefined);
    setKeyPhase({ kind: "idle" });
    setKeyMode("view");
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
      focusKey();
      return;
    }
    setKeyFieldError(undefined);
    const hadKey = status()?.key.state === "set";
    setKeyPhase({ kind: "checking" });
    const fail = (reason: "rejected" | "unverified" | "no-answer") => {
      setKeyPhase({ kind: "failed", reason, hadKey });
      announce(reason === "rejected" ? t().rejected : reason === "unverified" ? t().unverified : t().noAnswer, {
        politeness: "assertive",
      });
    };
    try {
      const response = await api.key.$put({ json: { apiKey } });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isStatus(body)) return keySaved(body);
      const code = codeOf(body);
      if (code === "geo_key_rejected") return fail("rejected");
      if (code === "geo_key_unverified") return fail("unverified");
      if (code === "geo_key_missing" || code === "geo_key_malformed") {
        setKeyPhase({ kind: "idle" });
        setKeyFieldError(code === "geo_key_missing" ? t().missingKey : t().malformedKey);
        return;
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
    announce(t().keySaved);
    void loadUsage();
  };
  const removeKey = async () => {
    setKeyPhase({ kind: "removing" });
    try {
      const response = await api.key.$delete();
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isStatus(body)) return keyRemoved(body);
    } catch {
      // Removal is idempotent; read the state to learn whether it happened.
    }
    const after = await readStatus();
    if (after?.key.state === "none") return keyRemoved(after);
    setKeyPhase({ kind: "remove-failed" });
    announce(t().removeFailed, { politeness: "assertive" });
  };
  const keyRemoved = (next: GeoAdminStatus) => {
    setStatus(next);
    backToView();
    announce(t().keyRemoved);
  };

  // ── Loading ────────────────────────────────────────────────────────────
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

  // ── Rendering ──────────────────────────────────────────────────────────
  const keyMeta = () => {
    const key = status()?.key;
    if (!key?.setAt) return t().euEndpoint;
    const since = key.setBy ? t().keySinceBy({ date: date(key.setAt), name: key.setBy.name }) : t().keySince({ date: date(key.setAt) });
    return `${since} · ${t().euEndpoint}`;
  };
  const keyBusy = () => keyPhase().kind === "checking";
  const failed = () => {
    const phase = keyPhase();
    return phase.kind === "failed" ? phase : null;
  };

  const keyForm = (label: string, hint: string, submit: string, cancel: boolean) => {
    const hintId = createUniqueId();
    return (
      <form
        class="mt-2 flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void checkKey();
        }}
      >
        <TextInput
          ref={(element: HTMLInputElement) => {
            keyField = element;
          }}
          label={label}
          password
          icon="ti ti-key"
          activeIcon="ti ti-key"
          autocomplete="off"
          placeholder={t().keyPlaceholder}
          value={keyInput()}
          onValueChange={(next) => {
            setKeyInput(next);
            setKeyFieldError(undefined);
          }}
          disabled={keyBusy()}
          error={keyFieldError()}
          externalErrorId={keyFieldError() ? hintId : undefined}
          aria-describedby={keyFieldError() ? undefined : hintId}
        />
        <p
          id={hintId}
          class="m-0 min-h-[18px] text-[12.5px]"
          classList={{ "text-[var(--k2b-danger-text)]": !!keyFieldError(), "text-[var(--k2b-text-muted)]": !keyFieldError() }}
        >
          {keyFieldError() ?? hint}
        </p>
        <div class="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={keyBusy()} loadingLabel={t().checking}>
            {submit}
          </Button>
          <Show when={cancel}>
            <Button type="button" variant="secondary" disabled={keyBusy()} onClick={backToView}>
              {t().cancel}
            </Button>
          </Show>
        </div>
      </form>
    );
  };

  const keyRow = (withActions: boolean) => (
    <div class="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-2">
      <span
        class="grid size-[34px] flex-none place-items-center rounded-full bg-[var(--k2b-success-surface)] text-[var(--k2b-success-text)]"
        aria-hidden="true"
      >
        <i class="ti ti-key text-[17px]" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="m-0 font-medium text-[var(--k2b-text)]">{t().keySet}</p>
        <p class="m-0 text-[12.5px] text-[var(--k2b-text-muted)]">{keyMeta()}</p>
      </div>
      <Show when={withActions}>
        <div class="flex basis-full flex-wrap gap-2 @lg:basis-auto">
          <Button size="sm" variant="secondary" onClick={startReplace}>
            <i class="ti ti-replace" aria-hidden="true" /> {t().replace}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setKeyMode("remove")}>
            <i class="ti ti-trash" aria-hidden="true" /> {t().remove}
          </Button>
        </div>
      </Show>
    </div>
  );

  const keySection = () => (
    <Switch>
      <Match when={statusLoad() === "loading"}>
        <div class="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-2" aria-busy="true">
          <Skeleton class="size-[34px] flex-none !rounded-full" />
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton class="h-3.5 w-2/5" />
            <Skeleton class="h-3 w-3/5" />
          </div>
          <div class="flex basis-full gap-2 @lg:basis-auto">
            <Skeleton class="h-[30px] w-24" />
            <Skeleton class="h-[30px] w-[104px]" />
          </div>
        </div>
      </Match>
      <Match when={statusLoad() === "error"}>
        <StateRow tone="danger" icon="ti ti-alert-triangle" title={t().loadFailed} detail={t().loadFailedDetail} role="alert">
          <Button size="sm" variant="secondary" onClick={() => void loadAll()}>
            <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
          </Button>
        </StateRow>
      </Match>
      <Match when={failed()}>
        {(phase) => (
          <StateRow
            tone="danger"
            icon="ti ti-alert-triangle"
            role="alert"
            title={phase().reason === "rejected" ? t().rejected : phase().reason === "unverified" ? t().unverified : t().noAnswer}
            detail={
              phase().reason === "rejected"
                ? phase().hadKey
                  ? t().rejectedDetailKeep
                  : t().rejectedDetail
                : phase().reason === "unverified"
                  ? phase().hadKey
                    ? t().unverifiedDetailKeep
                    : t().unverifiedDetail
                  : t().noAnswerDetail
            }
          >
            <Button size="sm" variant="secondary" onClick={() => void checkKey()}>
              <i class="ti ti-refresh" aria-hidden="true" /> {t().checkAgain}
            </Button>
            <Button size="sm" variant="ghost" onClick={editAgain}>
              {t().changeKey}
            </Button>
          </StateRow>
        )}
      </Match>
      <Match when={status()?.key.state === "set" && keyMode() === "remove"}>
        <div class="flex flex-col gap-2" role="group" aria-label={t().removeConfirm}>
          <p class="m-0 text-[17px] leading-[1.6] text-[var(--k2b-text)]">
            {t().removeQuestion} <LabelChip icon="ti ti-key">Geoapify</LabelChip>
            {locale().startsWith("de") ? ` ${t().removeQuestionEnd}` : t().removeQuestionEnd}
          </p>
          <p class="m-0 flex items-start gap-2 text-[13px] text-[var(--k2b-text-muted)]">
            <i class="ti ti-alert-triangle mt-0.5 text-base" aria-hidden="true" />
            <span>{t().removeWhy}</span>
          </p>
          <Show when={keyPhase().kind === "remove-failed"}>
            <p class="m-0 text-[13px] text-[var(--k2b-danger-text)]" role="alert">
              {t().removeFailed}
            </p>
          </Show>
          <div class="grid grid-cols-[1fr_auto] gap-2 @lg:flex">
            <Button
              size="lg"
              variant="danger"
              loading={keyPhase().kind === "removing"}
              loadingLabel={t().removeConfirm}
              onClick={() => void removeKey()}
            >
              <i class="ti ti-trash" aria-hidden="true" /> {t().removeConfirm}
            </Button>
            <Button size="lg" variant="secondary" disabled={keyPhase().kind === "removing"} onClick={backToView}>
              {t().keep}
            </Button>
          </div>
        </div>
      </Match>
      <Match when={status()?.key.state === "set" && keyMode() === "replace"}>
        {keyRow(false)}
        {keyForm(t().newKeyLabel, t().replaceHint, t().checkAndReplace, true)}
      </Match>
      <Match when={status()?.key.state === "set"}>{keyRow(true)}</Match>
      <Match when={status()?.key.state === "unreadable"}>
        <StateRow tone="warning" icon="ti ti-key-off" title={t().unreadableKey} detail={t().unreadableKeyDetail} />
        {keyForm(t().keyLabel, t().keyHint, t().checkAndSave, false)}
      </Match>
      <Match when={true}>
        <div class="flex min-h-[52px] items-center">
          <StateRow tone="neutral" icon="ti ti-key" title={t().noKey} detail={t().noKeyDetail} />
        </div>
        {keyForm(t().keyLabel, t().keyHint, t().checkAndSave, false)}
      </Match>
    </Switch>
  );

  const numberField = (field: GeoBudgetField, label: string, icon: string, hint: () => string) => {
    const hintId = createUniqueId();
    const error = () => errorText(fieldErrors()[field]);
    const unreadable = () => status()?.budget.unreadable.includes(field) ?? false;
    return (
      <div class="flex min-w-0 flex-col gap-1.5">
        <TextInput
          label={label}
          icon={icon}
          activeIcon={icon}
          inputmode="numeric"
          autocomplete="off"
          value={statusLoad() === "ready" ? values()[field] : ""}
          onValueChange={(next) => setValue(field, next)}
          onValueCommit={(next) => {
            const parsed = parseWhole(next);
            if (parsed !== null) setValue(field, number(parsed));
          }}
          disabled={budgetDisabled()}
          error={error()}
          externalErrorId={error() ? hintId : undefined}
          aria-describedby={error() ? undefined : hintId}
          data-geo-field={field}
        />
        <p
          id={hintId}
          class="m-0 min-h-9 text-[12.5px] leading-[18px]"
          classList={{ "text-[var(--k2b-danger-text)]": !!error(), "text-[var(--k2b-text-muted)]": !error() }}
        >
          <Show when={statusLoad() === "ready"} fallback={<Skeleton class="mt-1 h-3 w-3/5" />}>
            {error() ?? (unreadable() ? t().unreadableValue : hint())}
          </Show>
        </p>
      </div>
    );
  };
  const personHint = () => {
    const limit = parseWhole(values().personDailyCredits);
    if (limit === 0) return t().personDailyOff;
    return t().personDailyHint({ count: number(Math.floor((limit ?? 0) / CREDITS_PER_MAP_QUESTION)) });
  };
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
    if (statusLoad() !== "ready") return <Skeleton class="h-3.5 w-[220px]" />;
    if (phase.kind === "saving") return <span class="text-[var(--k2b-text-muted)]">{t().saving}</span>;
    if (phase.kind === "saved")
      return (
        <span class="inline-flex items-center gap-1.5 text-[var(--k2b-success-text)]">
          <i class="ti ti-circle-check" aria-hidden="true" />
          {t().savedAt({ time: clock(phase.at) })}
        </span>
      );
    if (phase.kind === "invalid" || phase.kind === "failed")
      return (
        <span class="inline-flex items-center gap-1.5 text-[var(--k2b-danger-text)]">
          <i class="ti ti-alert-triangle" aria-hidden="true" />
          {phase.kind === "failed" ? t().notSavedNoAnswer : phase.count > 1 ? t().notSavedFields : t().notSavedField}
        </span>
      );
    const budget = status()?.budget;
    if (!budget?.changedAt) return <span class="text-[var(--k2b-text-muted)]">{t().defaults}</span>;
    return (
      <span class="text-[var(--k2b-text-muted)]">
        {budget.changedBy
          ? t().changedAtBy({ date: date(budget.changedAt), name: budget.changedBy.name })
          : t().changedAt({ date: date(budget.changedAt) })}
      </span>
    );
  };

  const meterTone = (percent: number, warnAt: number) => (percent >= 100 ? "danger" : percent > warnAt ? "warning" : "info");
  const usageLine = (label: string, used: number | null, limit: number | null, warnAt: number) => {
    const percent = () => (used !== null && limit ? (used / limit) * 100 : used ? 100 : 0);
    return (
      <div class="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1 text-[13.5px] @lg:grid-cols-[160px_minmax(0,1fr)_110px]">
        <span class="col-start-1 row-start-1 text-[var(--k2b-text-secondary)]">{label}</span>
        <ProgressBar
          class="col-span-2 row-start-2 @lg:col-span-1 @lg:col-start-2 @lg:row-start-1"
          size="sm"
          value={used === null ? 0 : percent()}
          tone={meterTone(percent(), warnAt)}
          label={used === null || limit === null ? label : t().usageLabel({ period: label, used: number(used), limit: number(limit) })}
        />
        <span class="col-start-2 row-start-1 text-right text-[var(--k2b-text-secondary)] tabular-nums @lg:col-start-3">
          <Show when={used !== null && limit !== null} fallback={<Skeleton class="ml-auto h-3.5 w-20" />}>
            {number(used ?? 0)} / {number(limit ?? 0)}
          </Show>
        </span>
      </div>
    );
  };
  const shareLabel = (group: (typeof GEO_USAGE_GROUPS)[number]) =>
    group === "tiles" ? t().tiles : group === "places" ? t().places : group === "route" ? t().route : t().address;
  const shares = (data: GeoAdminUsage | null) => {
    const total = data?.shares.reduce((sum, share) => sum + share.credits, 0) ?? 0;
    return (
      <div class="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 text-[13.5px] @lg:grid-cols-[minmax(0,1fr)_150px]">
        <For each={GEO_USAGE_GROUPS}>
          {(group) => (
            <>
              <span class="text-[var(--k2b-text-secondary)]">{shareLabel(group)}</span>
              <span class="text-right tabular-nums">
                <Show when={data} fallback={<Skeleton class="ml-auto h-3.5 w-9" />}>
                  {new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(
                    total ? (data?.shares.find((share) => share.group === group)?.credits ?? 0) / total : 0,
                  )}
                </Show>
              </span>
            </>
          )}
        </For>
      </div>
    );
  };
  const usageHint = () => <p class="m-0 mt-1 min-h-[18px] text-[12.5px] text-[var(--k2b-text-muted)]">{t().usageHint}</p>;
  const usageSection = () => (
    <Switch>
      <Match when={statusLoad() === "ready" && keyOff()}>
        <Calm icon="ti ti-chart-bar">{t().usageAfterKey}</Calm>
      </Match>
      <Match when={usageLoad() === "error" && statusLoad() !== "loading"}>
        <StateRow tone="danger" icon="ti ti-alert-triangle" title={t().usageFailed} detail={t().usageFailedDetail} role="alert">
          <Button size="sm" variant="secondary" onClick={() => void loadUsage()}>
            <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
          </Button>
        </StateRow>
      </Match>
      <Match when={usageLoad() === "ready" && statusLoad() === "ready" && usage()}>
        {(data) => (
          <div>
            {usageLine(monthName(data().month.period), data().month.used, data().month.limit, 80)}
            {usageLine(t().today, data().today.used, data().today.allowance, 90)}
            <Show when={data().month.used >= data().month.limit}>
              <div class="mt-2">
                <StateRow
                  tone="warning"
                  icon="ti ti-hourglass"
                  role="status"
                  title={t().monthReached({ when: resetWhen(data().month.resetsAt) })}
                  detail={t().monthReachedDetail}
                />
              </div>
            </Show>
            <Show when={data().peopleAtLimit > 0}>
              <div class="mt-2">
                <StateRow
                  tone="warning"
                  icon="ti ti-user"
                  role="status"
                  title={t().peopleAtLimit({ count: number(data().peopleAtLimit) })}
                  detail={t().peopleAtLimitDetail({ when: t().resetTime({ time: resetTime(data().today.resetsAt) }) })}
                />
              </div>
            </Show>
            <Show when={data().month.used > 0} fallback={<Calm icon="ti ti-chart-bar">{t().noUsage}</Calm>}>
              {shares(data())}
            </Show>
            {usageHint()}
          </div>
        )}
      </Match>
      <Match when={true}>
        <div aria-busy="true">
          {usageLine(monthName(usage()?.month.period ?? new Date().toISOString().slice(0, 7)), null, null, 80)}
          {usageLine(t().today, null, null, 90)}
          {shares(null)}
          {usageHint()}
        </div>
      </Match>
    </Switch>
  );

  return (
    <SettingsPage
      title={t().title}
      subtitle={t().lead}
      icon="ti ti-map-2"
      actions={<DocumentationLink base={props.documentationBase} topic="places" />}
    >
      <div class="@container flex max-w-[47.5rem] flex-col" data-places-and-maps="">
        <SettingsSection title={t().key}>{keySection()}</SettingsSection>
        <SettingsSection title={t().planAndBudget} subtitle={t().planAndBudgetLead}>
          <div class="mt-2 grid grid-cols-1 gap-3.5 @lg:grid-cols-2">
            <div class="flex min-w-0 flex-col gap-1.5">
              <Select
                label={t().plan}
                options={planOptions()}
                value={statusLoad() === "ready" ? values().plan : null}
                placeholder=""
                onValueChange={(next) => {
                  const plan = GEO_PLAN_IDS.find((id) => id === next);
                  if (plan) setValues((current) => ({ ...current, plan }));
                }}
                disabled={budgetDisabled()}
              />
              <p class="m-0 hidden min-h-9 @lg:block" aria-hidden="true" />
            </div>
            {numberField("monthlyCredits", t().monthly, "ti ti-coins", () =>
              t().monthlySuggestion({ daily: planDaily() === null ? "–" : number(planDaily() ?? 0) }),
            )}
            <Show when={values().plan === "custom"}>
              {numberField("customRps", t().customRps, "ti ti-gauge", () => t().customRpsHint)}
              {numberField("customDailyCredits", t().customDaily, "ti ti-calendar-stats", () => t().customDailyHint)}
            </Show>
            {numberField("personDailyCredits", t().personDaily, "ti ti-user", personHint)}
          </div>
          <div class="mt-3.5 flex min-h-10 flex-col items-start gap-2 text-[13px] @lg:flex-row @lg:flex-wrap @lg:items-center @lg:gap-3.5">
            <Button
              variant="primary"
              disabled={budgetDisabled()}
              loading={savePhase().kind === "saving"}
              loadingLabel={t().saving}
              onClick={() => void save()}
            >
              {t().save}
            </Button>
            <span class="flex h-5 items-center leading-5 [&_i]:text-[15px] [&_i]:leading-none" aria-live="polite">
              {saveLine()}
            </span>
          </div>
        </SettingsSection>
        <SettingsSection title={t().usage}>{usageSection()}</SettingsSection>
      </div>
    </SettingsPage>
  );
}
