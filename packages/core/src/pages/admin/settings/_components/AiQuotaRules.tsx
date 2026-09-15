import {
  Button,
  DataTable,
  NumberInput,
  PanelDialog,
  Placeholder,
  Select,
  Switch,
  dialogCore,
  panelDialogWideOptions,
  prompts,
  useLocale,
} from "@k2b/ui";
import { PrincipalPicker, principalKey } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import { AiQuotaConfigSchema, type AiQuotaConfig, type AiQuotaRule } from "@k2b/cloud/shared";
import { createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { quotaMessages } from "./ai-quota-messages";
const api = coreClient.admin.core["ai-quotas"];
export default function AiQuotaRules(props: { config: AiQuotaConfig; models: { id: string; label: string }[] }) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  const [draft, setDraft] = createSignal(structuredClone(props.config));
  const [saved, setSaved] = createSignal(props.config),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(saved());
  const name = (scope: string) => (scope === "*" ? t().all : (props.models.find((m) => m.id === scope)?.label ?? scope));
  const scopes = () => ["*", ...props.models.map((m) => m.id)].filter((scope) => !draft().rules.some((r) => r.scope === scope));
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
        structuredClone(original ?? { scope, hours: 168, anchor: "1970-01-01T00:00:00.000Z", grants: [] }),
      );
      const [issue, setIssue] = createSignal("");
      const update = (fn: (next: AiQuotaRule) => void) =>
        setRule((previous) => {
          const next = structuredClone(previous);
          fn(next);
          return next;
        });
      return (
        <PanelDialog>
          <PanelDialog.Header title={original ? t().edit : t().add} icon="ti ti-adjustments" close={close} />
          <PanelDialog.Body>
            <div class="flex flex-col gap-4">
              <Show when={issue()}>
                <Placeholder state="error" description={issue()} />
              </Show>
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
              <p class="text-xs text-dimmed">{t().hint}</p>
              <p class="text-xs text-dimmed">{t().grantHint}</p>
              <Index each={rule().grants}>
                {(grant, i) => (
                  <div class="flex flex-wrap items-center gap-3 border-b border-border pb-3">
                    <span class="min-w-32 flex-1 text-sm">
                      {grant().principal.type === "authenticated" ? t().allUsers : grant().displayName || principalKey(grant().principal)}
                    </span>
                    <Switch
                      label={t().unlimited}
                      value={grant().limit === null}
                      onValueChange={(value) =>
                        update((r) => {
                          r.grants[i]!.limit = value ? null : 100000;
                        })
                      }
                    />
                    <Show when={grant().limit !== null}>
                      <NumberInput
                        class="w-36"
                        label={t().tokens}
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
                      onClick={() =>
                        update((r) => {
                          r.grants.splice(i, 1);
                        })
                      }
                    >
                      {t().remove}
                    </Button>
                  </div>
                )}
              </Index>
              <PrincipalPicker
                allowServiceAccounts
                existing={rule().grants.map((g) => g.principal)}
                onSelect={(principal, display) =>
                  principal.type !== "public" &&
                  update((r) => {
                    r.grants.push({ principal, displayName: display.displayName, limit: 100000 });
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
      );
    }, panelDialogWideOptions);
  }
  return (
    <div class="flex min-w-0 flex-col gap-3">
      <Switch
        label={t().enabled}
        description={t().disabledHint}
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
                <span class="text-xs text-dimmed">
                  {row.grants
                    .slice(0, 2)
                    .map(
                      (g) =>
                        `${g.principal.type === "authenticated" ? t().allUsers : g.displayName || principalKey(g.principal)} · ${g.limit === null ? t().unlimited : g.limit.toLocaleString(locale())}`,
                    )
                    .join(", ") || t().emptyGrants}
                  {row.grants.length > 2 ? ` (+${row.grants.length - 2})` : ""}
                </span>
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
