import { hasBillableAiPricing } from "@k2b/cloud/shared";
import AiBackgroundBudget from "./AiBackgroundBudget";
import {
  Button,
  DataTable,
  NumberInput,
  NoticeCard,
  LocaleProvider,
  PanelDialog,
  Placeholder,
  Select,
  Switch,
  dialogCore,
  panelDialogOptions,
  prompts,
  useLocale,
} from "@k2b/ui";
import { PrincipalPicker, principalKey } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import { AiQuotaConfigSchema, type AiQuotaConfig, type AiQuotaRule } from "@k2b/cloud/shared";
import { createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import AiQuotaIdentity from "./AiQuotaIdentity";
import { quotaMessages } from "./ai-quota-messages";
const api = coreClient.admin.core["ai-quotas"];
export default function AiQuotaRules(props: {
  config: AiQuotaConfig;
  models: {
    id: string;
    label: string;
    enabled: boolean;
    capabilities: string[];
    pricing?: { inputPerMillion: number; outputPerMillion: number };
  }[];
}) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  const [draft, setDraft] = createSignal(structuredClone(props.config));
  const [saved, setSaved] = createSignal(props.config),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(saved());
  const name = (scope: string) => (scope === "*" ? t().all : (props.models.find((m) => m.id === scope)?.label ?? scope));
  const chatModels = () => props.models.filter((m) => m.enabled && !m.capabilities.includes("transcription"));
  const unpriced = () => chatModels().filter((m) => !m.pricing);
  const scopes = () =>
    [
      "*",
      ...chatModels()
        .filter((m) => hasBillableAiPricing(m.pricing))
        .map((m) => m.id),
    ].filter((scope) => !draft().rules.some((r) => r.scope === scope));
  onMount(() => {
    let leaving = false;
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty() && !leaving) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const click = (event: MouseEvent) => {
      if (
        !dirty() ||
        !(event.target instanceof Element) ||
        !event.target.closest("a[href]") ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.button !== 0
      )
        return;
      if (!window.confirm(t().discard)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else {
        leaving = true;
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    onCleanup(() => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    });
  });
  async function save() {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      const config = structuredClone(draft());
      const changed = config.rules.filter((r) => saved().rules.some((old) => old.scope === r.scope && old.hours !== r.hours));
      if (changed.length && !(await prompts.confirm(t().newPeriod))) return;
      for (const rule of changed) rule.anchor = new Date().toISOString();
      const response = await api.$put({ json: AiQuotaConfigSchema.parse(config) });
      const body = await response.json();
      if (!response.ok) throw new Error("message" in body ? body.message : t().error);
      const result = AiQuotaConfigSchema.parse(body);
      setDraft(result);
      setSaved(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(index?: number) {
    const original = index === undefined ? undefined : draft().rules[index];
    const scope = original?.scope ?? scopes()[0];
    if (!scope) return;
    void dialogCore.open<void>((close) => {
      const [rule, setRule] = createSignal<AiQuotaRule>(
        structuredClone(original ?? { scope, hours: 24, anchor: "1970-01-01T00:00:00.000Z", grants: [] }),
      );
      const [issue, setIssue] = createSignal("");
      const update = (fn: (next: AiQuotaRule) => void) =>
        setRule((previous) => {
          const next = structuredClone(previous);
          fn(next);
          return next;
        });
      return (
        <LocaleProvider locale={locale()}>
          <PanelDialog>
            <PanelDialog.Header title={original ? t().edit : t().add} icon="ti ti-adjustments" close={close} />
            <PanelDialog.Body>
              <div class="flex flex-col gap-4">
                <Show when={issue()}>
                  <Placeholder state="error" description={issue()} />
                </Show>
                <NoticeCard tone="info" title={t().tokenTitle} detail={t().tokenHint} />
                <div class="grid gap-4 sm:grid-cols-2">
                  <Select
                    label={t().scope}
                    value={rule().scope}
                    options={[...new Set([rule().scope, ...scopes()])].map((value) => ({ value, label: name(value) }))}
                    onValueChange={(value) =>
                      value &&
                      update((r) => {
                        r.scope = value;
                      })
                    }
                  />
                  <NumberInput
                    showSteppers={false}
                    label={t().hours}
                    value={rule().hours}
                    min={1}
                    max={8760}
                    onValueChange={(value) =>
                      update((r) => {
                        r.hours = value ?? 1;
                      })
                    }
                  />
                </div>
                <p class="text-xs text-dimmed">{t().grantMax}</p>
                <p class="text-xs text-dimmed">{t().grantHint}</p>
                <Index each={rule().grants}>
                  {(grant, i) => (
                    <div class="ai-quota-grant">
                      <AiQuotaIdentity type={grant().principal.type} label={grant().displayName || principalKey(grant().principal)} />
                      <div class="flex flex-wrap items-center gap-2">
                        <Select
                          class="w-32"
                          aria-label={t().limit}
                          value={grant().limit === null ? "unlimited" : "cost"}
                          options={[
                            { value: "cost", label: t().cost },
                            { value: "unlimited", label: t().unlimited },
                          ]}
                          onValueChange={(value) =>
                            update((r) => {
                              r.grants[i]!.limit = value === "unlimited" ? null : 10;
                            })
                          }
                        />
                        <Show when={grant().limit !== null}>
                          <NumberInput
                            showSteppers={false}
                            class="w-36"
                            step={0.000001}
                            aria-label={`${t().cost} (${draft().unit ?? "EUR"})`}
                            min={0}
                            value={grant().limit}
                            onValueChange={(value) =>
                              update((r) => {
                                r.grants[i]!.limit = value ?? 0;
                              })
                            }
                          />
                        </Show>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`${t().remove}: ${grant().principal.type === "authenticated" ? t().allUsers : grant().displayName || principalKey(grant().principal)}`}
                          onClick={() =>
                            update((r) => {
                              r.grants.splice(i, 1);
                            })
                          }
                        >
                          <i class="ti ti-x" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  )}
                </Index>
                <PrincipalPicker
                  allowServiceAccounts
                  existing={rule().grants.map((g) => g.principal)}
                  onSelect={(principal, display) =>
                    principal.type !== "public" &&
                    update((r) => {
                      r.grants.push({ principal, displayName: display.displayName, limit: 10 });
                    })
                  }
                />
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Button variant="ghost" onClick={() => close()}>
                {t().cancel}
              </Button>
              <Button
                onClick={() => {
                  const next = structuredClone(draft());
                  if (index === undefined) next.rules.push(rule());
                  else next.rules[index] = rule();
                  const result = AiQuotaConfigSchema.safeParse(next);
                  if (!result.success) {
                    setIssue(result.error.issues.map((i) => i.message).join("; "));
                    return;
                  }
                  setDraft(result.data);
                  close();
                }}
              >
                {t().apply}
              </Button>
            </PanelDialog.Footer>
          </PanelDialog>
        </LocaleProvider>
      );
    }, panelDialogOptions);
  }
  return (
    <div class="flex min-w-0 flex-col gap-3">
      <Show when={unpriced().length > 0}>
        <NoticeCard tone="warning" title={locale().startsWith("de") ? "Modelle ohne Kostenlimits" : "Models without cost limits"}>
          <p>
            {locale().startsWith("de")
              ? "Für diese Modelle sind keine Kosten konfiguriert. Sie bleiben unbegrenzt nutzbar und werden von Kostenlimits nicht erfasst."
              : "These models have no configured prices. They remain unlimited and are not covered by cost limits."}
          </p>
          <ul>
            <For each={unpriced()}>{(model) => <li>{model.label}</li>}</For>
          </ul>
        </NoticeCard>
      </Show>
      <AiBackgroundBudget config={draft()} change={setDraft} disabled={busy()} canRelease={!dirty()} />
      <Switch
        label={t().enabled}
        description={draft().enabled ? t().hint : t().disabledHint}
        value={draft().enabled}
        disabled={busy()}
        onValueChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
      />
      <Show when={error()}>
        <Placeholder state="error" description={error()} />
      </Show>
      <DataTable.Panel>
        <DataTable.Header title={t().rules}>
          <Button size="sm" variant="secondary" disabled={busy() || !scopes().length} onClick={() => edit()}>
            {t().add}
          </Button>
        </DataTable.Header>
        <DataTable
          rows={draft().rules}
          getRowId={(r) => r.scope}
          density="compact"
          surface="plain"
          columns={[
            { id: "scope", header: t().scope },
            { id: "hours", header: t().hours, align: "right" },
            { id: "grants", header: t().assignments },
            { id: "actions", header: "" },
          ]}
          empty={<Placeholder variant="compact" description={t().noRules} />}
          renderCell={({ row, col }) => {
            if (col.id === "scope") return <span class="font-medium">{name(row.scope)}</span>;
            if (col.id === "hours") return row.hours;
            if (col.id === "grants")
              return (
                <div class="flex flex-col gap-2 py-1">
                  <For each={row.grants.slice(0, 2)} fallback={<span class="text-xs text-dimmed">{t().emptyGrants}</span>}>
                    {(g) => (
                      <div class="flex items-center justify-between gap-4">
                        <AiQuotaIdentity type={g.principal.type} label={g.displayName || principalKey(g.principal)} />
                        <span class="text-xs tabular-nums text-dimmed">
                          {g.limit === null
                            ? t().unlimited
                            : `${g.limit.toLocaleString(locale(), { maximumSignificantDigits: 6 })} ${draft().unit ?? "EUR"}`}
                        </span>
                      </div>
                    )}
                  </For>
                  <Show when={row.grants.length > 2}>
                    <span class="text-xs text-dimmed">+{row.grants.length - 2}</span>
                  </Show>
                </div>
              );
            return (
              <div class="flex justify-end gap-1">
                <Button size="sm" variant="ghost" disabled={busy()} onClick={() => edit(draft().rules.indexOf(row))}>
                  {t().edit}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy()}
                  onClick={async () => {
                    if (await prompts.confirm(t().removed))
                      setDraft((d) => ({ ...d, rules: d.rules.filter((r) => r.scope !== row.scope) }));
                  }}
                >
                  {t().remove}
                </Button>
              </div>
            );
          }}
        />
      </DataTable.Panel>
      <div class="flex items-center gap-2">
        <Button disabled={busy() || !dirty()} onClick={() => void save()}>
          {t().save}
        </Button>
        <Button
          variant="ghost"
          disabled={busy()}
          onClick={async () => {
            if (dirty() && !(await prompts.confirm(t().discard))) return;
            try {
              const r = await api.$get();
              if (!r.ok) throw new Error(t().error);
              const c = await r.json();
              setDraft(c);
              setSaved(c);
              setError("");
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          {t().reload}
        </Button>
        <span role="status" class="text-xs text-dimmed">
          {dirty() ? t().dirty : t().saved}
        </span>
      </div>
    </div>
  );
}
