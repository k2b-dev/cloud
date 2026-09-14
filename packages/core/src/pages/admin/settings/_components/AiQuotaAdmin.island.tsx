import { query } from "@k2b/stdlib/solid";
import { Button, NumberInput, Select, Switch, TextInput, Placeholder, prompts, useLocale } from "@k2b/ui";
import { PrincipalPicker, principalKey } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { AiQuotaConfig, AiQuotaIdentity, AiQuotaSnapshot } from "@k2b/cloud/shared";
import { createSignal, For, Index, Show } from "solid-js";
import { quotaMessages } from "./ai-quota-messages";
const api = coreClient.admin.core["ai-quotas"];
async function checked<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || response.statusText);
  return body;
}
export default function AiQuotaAdmin(props: { config: AiQuotaConfig; models: { id: string; label: string }[] }) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  const [draft, setDraft] = createSignal(structuredClone(props.config));
  const [saved, setSaved] = createSignal(props.config),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const [tab, setTab] = createSignal("rules"),
    [search, setSearch] = createSignal(""),
    [page, setPage] = createSignal(1);
  const [selected, setSelected] = createSignal<AiQuotaIdentity | null>(null);
  const users = query.create({
    source: () => ({ search: search(), page: page() }),
    load: async (q, { abortSignal }) =>
      checked<{ items: AiQuotaIdentity[]; total: number; page: number; perPage: number }>(
        await api.users.$get({ query: { search: q.search, page: String(q.page) } }, { init: { signal: abortSignal } }),
      ),
  });
  const balance = query.create({
    source: () => selected(),
    load: async (who, { abortSignal }) => {
      if (!who) return null;
      const snapshot = await checked<AiQuotaSnapshot>(
        await api.balance.$get({ query: { type: who.type, id: who.id } }, { init: { signal: abortSignal } }),
      );
      return { ...snapshot, identityKey: `${who.type}:${who.id}` };
    },
  });
  const shownBalance = () => (balance.data()?.identityKey === `${selected()?.type}:${selected()?.id}` ? balance.data() : null);
  const update = (fn: (next: AiQuotaConfig) => void) =>
    setDraft((previous) => {
      const next = structuredClone(previous);
      fn(next);
      return next;
    });
  const name = (scope: string) => (scope === "*" ? t().all : props.models.find((m) => m.id === scope)?.label || scope);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const changed = draft().rules.some((r) => saved().rules.some((old) => old.scope === r.scope && old.hours !== r.hours));
      if (changed && !(await prompts.confirm(t().newPeriod))) return;
      const config = structuredClone(draft());
      for (const r of config.rules)
        if (saved().rules.some((old) => old.scope === r.scope && old.hours !== r.hours)) r.anchor = new Date().toISOString();
      const result = await checked<AiQuotaConfig>(await api.$put({ json: config }));
      setDraft(result);
      setSaved(result);
      await balance.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function reset(scope: string) {
    const who = selected();
    if (!who || !shownBalance() || !(await prompts.confirm(`${who.label} · ${name(scope)}\n\n${t().resetConfirm}`))) return;
    setBusy(true);
    setError("");
    try {
      await checked(await api.reset.$post({ json: { type: who.type, id: who.id, scope, requestId: crypto.randomUUID() } }));
      await balance.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="flex min-w-0 flex-col gap-4 p-4">
      <h2 class="text-xl font-semibold">{t().title}</h2>
      <p class="text-sm text-muted">{t().description}</p>
      <div class="flex gap-2">
        <Button variant={tab() === "rules" ? "primary" : "secondary"} onClick={() => setTab("rules")}>
          {t().rules}
        </Button>
        <Button variant={tab() === "users" ? "primary" : "secondary"} onClick={() => setTab("users")}>
          {t().users}
        </Button>
      </div>
      <Show when={error()}>
        <Placeholder state="error" title={error()} />
      </Show>
      <Show when={tab() === "rules"}>
        <Switch
          label={t().enabled}
          description={t().disabledHint}
          value={draft().enabled}
          disabled={busy()}
          onValueChange={(v) =>
            update((d) => {
              d.enabled = v;
            })
          }
        />
        <p class="text-sm text-muted">{t().hint}</p>
        <Index each={draft().rules}>
          {(rule, i) => (
            <section class="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div class="flex flex-wrap items-end gap-3">
                <div class="min-w-48 flex-1">
                  <Select
                    label={t().scope}
                    value={rule().scope}
                    disabled={busy()}
                    options={[{ value: "*", label: t().all }, ...props.models.map((m) => ({ value: m.id, label: m.label }))].filter(
                      (o) => o.value === rule().scope || !draft().rules.some((r) => r.scope === o.value),
                    )}
                    onValueChange={(v) =>
                      v &&
                      update((d) => {
                        d.rules[i]!.scope = v;
                      })
                    }
                  />
                </div>
                <NumberInput
                  label={t().hours}
                  value={rule().hours}
                  min={1}
                  max={8760}
                  disabled={busy()}
                  onValueChange={(v) =>
                    update((d) => {
                      d.rules[i]!.hours = v ?? 1;
                    })
                  }
                />
                <Button
                  variant="secondary"
                  disabled={busy()}
                  onClick={() =>
                    update((d) => {
                      d.rules.splice(i, 1);
                    })
                  }
                >
                  {t().remove}
                </Button>
              </div>
              <p class="text-xs text-muted">{t().grantHint}</p>
              <Index each={rule().grants}>
                {(grant, j) => (
                  <div class="flex flex-wrap items-center gap-3">
                    <span class="min-w-32 flex-1 text-sm">
                      {grant().displayName || (grant().principal.type === "authenticated" ? t().allUsers : principalKey(grant().principal))}
                    </span>
                    <Switch
                      label={t().unlimited}
                      value={grant().limit === null}
                      disabled={busy()}
                      onValueChange={(v) =>
                        update((d) => {
                          d.rules[i]!.grants[j]!.limit = v ? null : 100000;
                        })
                      }
                    />
                    <Show when={grant().limit !== null}>
                      <NumberInput
                        label={t().tokens}
                        value={grant().limit}
                        min={0}
                        disabled={busy()}
                        onValueChange={(v) =>
                          update((d) => {
                            d.rules[i]!.grants[j]!.limit = v ?? 0;
                          })
                        }
                      />
                    </Show>
                    <Button
                      variant="ghost"
                      disabled={busy()}
                      onClick={() =>
                        update((d) => {
                          d.rules[i]!.grants.splice(j, 1);
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
                disabled={busy()}
                existing={rule().grants.map((g) => g.principal)}
                onSelect={(principal, display) =>
                  principal.type !== "public" &&
                  update((d) => {
                    d.rules[i]!.grants.push({ principal, displayName: display.displayName, limit: 100000 });
                  })
                }
              />
            </section>
          )}
        </Index>
        <Show when={!draft().rules.length}>
          <p class="text-sm text-muted">{t().noRules}</p>
        </Show>
        <div class="flex gap-2">
          <Button
            variant="secondary"
            disabled={busy() || draft().rules.length >= props.models.length + 1}
            onClick={() =>
              update((d) => {
                const scope = ["*", ...props.models.map((m) => m.id)].find((s) => !d.rules.some((r) => r.scope === s));
                if (scope) d.rules.push({ scope, hours: 168, anchor: "1970-01-01T00:00:00.000Z", grants: [] });
              })
            }
          >
            {t().add}
          </Button>
          <Button disabled={busy()} onClick={() => void save()}>
            {t().save}
          </Button>
          <Button
            variant="ghost"
            disabled={busy()}
            onClick={async () => {
              try {
                const c = await checked<AiQuotaConfig>(await api.$get());
                setDraft(c);
                setSaved(c);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            {t().reload}
          </Button>
        </div>
      </Show>
      <Show when={tab() === "users"}>
        <TextInput
          label={t().search}
          value={search()}
          onValueChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
        />
        <Show when={users.error()}>
          <Placeholder state="error" title={t().error} action={<Button onClick={() => users.refresh()}>{t().refresh}</Button>} />
        </Show>
        <div class="grid gap-4 lg:grid-cols-2">
          <div class="flex flex-col gap-2">
            <For each={users.data()?.items}>
              {(user) => (
                <Button variant={selected()?.id === user.id ? "secondary" : "ghost"} onClick={() => setSelected(user)}>
                  {user.label}
                  {user.type === "service_account" ? " · Service Account" : ""}
                </Button>
              )}
            </For>
            <Show when={!users.loading() && !users.data()?.items.length}>
              <p>{t().none}</p>
            </Show>
            <div class="flex gap-2">
              <Button disabled={page() <= 1} onClick={() => setPage((p) => p - 1)}>
                {t().previous}
              </Button>
              <span>{users.data()?.page || 1}</span>
              <Button disabled={page() * 25 >= (users.data()?.total || 0)} onClick={() => setPage((p) => p + 1)}>
                {t().next}
              </Button>
            </div>
          </div>
          <div class="flex flex-col gap-3">
            <Show when={selected()} fallback={<p>{t().select}</p>}>
              <h3 class="font-semibold">{selected()?.label}</h3>
              <Show when={shownBalance()?.usage.length}>
                <p class="text-sm text-muted">{t().recorded}</p>
              </Show>
              <For each={shownBalance()?.usage}>
                {(u) => (
                  <p class="text-sm text-muted">
                    {name(u.model)} · {t().input}: {u.input.toLocaleString(locale())} · {t().output}: {u.output.toLocaleString(locale())}
                  </p>
                )}
              </For>
              <Show when={balance.loading()}>
                <Placeholder state="loading" title={t().details} />
              </Show>
              <Show when={balance.error()}>
                <Placeholder state="error" title={t().error} action={<Button onClick={() => balance.refresh()}>{t().refresh}</Button>} />
              </Show>
              <For each={shownBalance()?.balances}>
                {(b) => (
                  <section class="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <h4 class="font-semibold">{name(b.scope)}</h4>
                    <p>
                      {t().used}: {b.used.toLocaleString(locale())} / {b.limit === null ? t().unlimited : b.limit.toLocaleString(locale())}
                    </p>
                    <p class="text-xs text-muted">
                      {t().input}: {b.input} · {t().output}: {b.output}
                    </p>
                    <p class="text-xs text-muted">
                      {t().source}: {b.sources.join(", ") || t().missing}
                    </p>
                    <Show when={b.bypassed}>
                      <p>{t().bypassed}</p>
                    </Show>
                    <Show when={b.unknown}>
                      <p>
                        {t().unknown}: {b.unknown}
                      </p>
                    </Show>
                    <p class="text-xs">
                      {t().until}: {new Date(b.resetsAt).toLocaleString(locale())}
                    </p>
                    <Button variant="secondary" disabled={busy()} onClick={() => void reset(b.scope)}>
                      {t().reset}
                    </Button>
                  </section>
                )}
              </For>
              <Show when={shownBalance() && !shownBalance()?.balances.length}>
                <p>{t().noRules}</p>
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
