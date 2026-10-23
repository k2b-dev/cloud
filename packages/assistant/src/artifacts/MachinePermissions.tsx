import { principalLabel } from "@k2b/cloud/shared";
import { Button, Checkbox, InlineGuidance, NoticeCard, Placeholder, Select, TextInput, useLocale } from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { MachineSecrets } from "./MachineSecrets";
import { machineClient } from "./machine-client";
import { MachineRights } from "./machine-contracts";
import { machineMessages } from "./machine-messages";

type Policy = Awaited<ReturnType<typeof machineClient.list>>[number];
export function MachinePermissions(props: {
  artifactId: string;
  administrative?: boolean;
  revision?: number;
  load?: () => Promise<Policy[]>;
  save?: typeof machineClient.save;
}) {
  const locale = useLocale(),
    t = () => machineMessages.resolve([locale()]).t;
  const [saved, setSaved] = createSignal(false);
  const [policies, { refetch }] = createResource(
    () => [props.artifactId, props.revision] as const,
    () => (props.load ? props.load() : machineClient.list(props.artifactId, props.administrative)),
  );
  return (
    <section class="flex min-w-0 flex-col gap-3 border-t border-default pt-4" aria-label={t().title}>
      <h3 class="font-semibold">{t().title}</h3>
      <p class="text-sm text-secondary">{t().help}</p>
      <Show when={policies.loading}>
        <InlineGuidance loading>{t().loading}</InlineGuidance>
      </Show>
      <Show when={policies.error}>
        <NoticeCard tone="danger" title={t().loadFailed}>
          <Button variant="ghost" onClick={() => void refetch()}>
            {t().refresh}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={!policies.error && policies()?.length === 0}>
        <Placeholder title={t().empty} icon="ti ti-robot" />
      </Show>
      <For each={policies.error ? [] : policies()}>
        {(policy) => (
          <MachineRightsEditor
            policy={policy}
            save={async (rights) => {
              setSaved(false);
              await (props.save ?? machineClient.save)(props.artifactId, policy.entry.id, rights, policy.revision, props.administrative);
              setSaved(true);
              await refetch();
            }}
            refresh={() => refetch()}
          />
        )}
      </For>
      <Show when={saved()}>
        <InlineGuidance>{t().saved}</InlineGuidance>
      </Show>
      <MachineSecrets artifactId={props.artifactId} administrative={props.administrative} />
    </section>
  );
}

export function MachineRightsEditor(props: { policy: Policy; save: (rights: MachineRights) => Promise<void>; refresh: () => unknown }) {
  const locale = useLocale(),
    t = () => machineMessages.resolve([locale()]).t;
  const [rights, setRights] = createSignal(props.policy.rights);
  const [secretNames, setSecretNames] = createSignal(props.policy.rights.secrets.join(", "));
  const [http, setHttp] = createSignal(
    props.policy.rights.http.flatMap((grant) => grant.methods.map((method) => `${grant.origin} ${method}`)).join("\n"),
  );
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(false),
    [saved, setSaved] = createSignal(false);
  const disabled = () => busy() || props.policy.status !== "active";
  const choices = () => [
    { id: "none", label: t().none },
    { id: "read", label: t().read },
    { id: "write", label: t().write },
  ];
  async function save() {
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      const parsed = MachineRights.parse({
        ...rights(),
        secrets: secretNames()
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
        http: http()
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [origin, method, extra] = line.split(/\s+/);
            if (extra) throw new Error("Invalid HTTP grant");
            return { origin, methods: [method] };
          }),
      });
      await props.save(parsed);
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="flex min-w-0 flex-col gap-3 rounded-lg border border-default p-3">
      <strong class="break-words">{principalLabel(props.policy.entry, locale())}</strong>
      <p class="text-sm text-secondary">{t().scope}</p>
      <Show when={props.policy.status !== "active"}>
        <NoticeCard tone="warning" title={t().disabled} />
      </Show>
      <Show when={!props.policy.rights.execute}>
        <InlineGuidance>{t().revoked}</InlineGuidance>
      </Show>
      <Checkbox
        label={t().execute}
        value={rights().execute}
        disabled={disabled()}
        onValueChange={(value) => setRights({ ...rights(), execute: value })}
      />
      <div class="grid grid-cols-1 gap-3 @md:grid-cols-2">
        <For each={["storage", "database"] as const}>
          {(kind) => (
            <Select
              label={t()[kind]}
              value={rights()[kind]}
              options={choices()}
              disabled={disabled()}
              onValueChange={(value) => {
                if (value === "none" || value === "read" || value === "write") setRights({ ...rights(), [kind]: value });
              }}
            />
          )}
        </For>
      </div>
      <TextInput
        label={t().secrets}
        description={t().secretNames}
        value={secretNames()}
        onValueChange={setSecretNames}
        disabled={disabled()}
      />
      <TextInput
        label={t().http}
        description={t().httpHelp}
        multiline
        lines={3}
        value={http()}
        onValueChange={setHttp}
        disabled={disabled()}
      />
      <Checkbox
        label={t().sharing}
        value={rights().sharing}
        disabled={disabled()}
        onValueChange={(value) => setRights({ ...rights(), sharing: value })}
      />
      <Show when={error()}>
        <NoticeCard tone="danger" title={t().failure}>
          <Button variant="ghost" onClick={props.refresh}>
            {t().refresh}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={saved()}>
        <InlineGuidance>{t().saved}</InlineGuidance>
      </Show>
      <div class="flex justify-end">
        <Button loading={busy()} disabled={disabled()} onClick={save}>
          {t().save}
        </Button>
      </div>
    </div>
  );
}
