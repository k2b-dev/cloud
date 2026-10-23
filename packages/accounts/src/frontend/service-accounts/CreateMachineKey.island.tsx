import { coreClient } from "@k2b/cloud/clients/core";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, CopyButton, DateTimePicker, NoticeCard, prompts, Select, TextInput } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import { useAccountsMessages } from "../messages";

export function CreateMachineKeyDialog(props: {
  modelsAvailable: boolean;
  close: () => void;
  setDismissHandler?: (handler: () => void) => void;
}) {
  const t = useAccountsMessages();
  const [accountId, setAccountId] = createSignal<string | null>(null);
  const [name, setName] = createSignal("");
  const [access, setAccess] = createSignal<"full" | "models">(props.modelsAvailable ? "models" : "full");
  const [expiresAt, setExpiresAt] = createSignal<string | null>(null);
  const [token, setToken] = createSignal<string | null>(null);
  const [uncertain, setUncertain] = createSignal(false);
  const create = mutation.create({
    mutation: async () => {
      const id = accountId();
      if (!id) throw new Error(t().chooseMachine);
      const expires = expiresAt();
      const expiry = expires ? new Date(expires).toISOString() : null;
      let response: Response;
      try {
        response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"].$post({
          param: { id },
          json: { name: name().trim(), access: access(), expiresAt: expiry },
        });
      } catch {
        setUncertain(true);
        throw new Error(t().machineKeyUncertain);
      }
      if (!response.ok && response.status < 500) {
        const error = z.object({ message: z.string() }).safeParse(await response.json().catch(() => null));
        throw new Error(error.success ? error.data.message : t().machineKeyFailed);
      }
      try {
        if (!response.ok) throw new Error("Unconfirmed creation");
        return z.object({ token: z.string() }).parse(await response.json()).token;
      } catch {
        setUncertain(true);
        throw new Error(t().machineKeyUncertain);
      }
    },
    onSuccess: setToken,
  });
  props.setDismissHandler?.(() => {
    if (!create.loading()) props.close();
  });
  return (
    <Show
      when={token()}
      fallback={
        <form
          class="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!create.loading() && !uncertain() && accountId() && name().trim()) void create.mutate();
          }}
        >
          <Select
            label={t().machineAccount}
            placeholder={t().chooseMachine}
            searchable
            description={t().machineSearchHint}
            value={accountId}
            onValueChange={setAccountId}
            disabled={create.loading() || uncertain()}
            required
            loadOptions={async (search, signal) => {
              const response = await coreClient.admin.identity["service-accounts"].$get(
                {
                  query: { search, status: "active" },
                },
                { init: { signal } },
              );
              if (!response.ok) throw new Error(t().machineAccountsFailed);
              const data = await response.json();
              return data.items.map((account) => ({
                value: account.id,
                label: account.name,
                description: account.kind === "agent" ? t().agentServiceAccount : t().standaloneServiceAccount,
              }));
            }}
          />
          <TextInput
            label={t().name}
            value={name}
            onValueChange={setName}
            maxLength={120}
            required
            disabled={create.loading() || uncertain()}
          />
          <Select
            label={t().keyPurpose}
            value={access}
            onValueChange={(value) => setAccess(value === "models" ? "models" : "full")}
            disabled={create.loading() || uncertain()}
            options={[
              { value: "full", label: t().fullKeyAccess, description: t().fullKeyDescription },
              ...(props.modelsAvailable ? [{ value: "models", label: t().modelsOnlyKey, description: t().machineModelsDescription }] : []),
            ]}
          />
          <Show when={!props.modelsAvailable}>
            <NoticeCard>{t().machineModelsDisabled}</NoticeCard>
          </Show>
          <DateTimePicker
            label={t().expires}
            value={expiresAt}
            onValueChange={setExpiresAt}
            clearable
            disabled={create.loading() || uncertain()}
          />
          <Show when={create.error()}>
            {(error) => (
              <NoticeCard tone="danger" role="alert">
                {error().message}
              </NoticeCard>
            )}
          </Show>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={props.close} disabled={create.loading()}>
              {t().cancel}
            </Button>
            <Button type="submit" loading={create.loading()} disabled={!accountId() || !name().trim() || uncertain()}>
              {t().createMachineKey}
            </Button>
          </div>
        </form>
      }
    >
      {(value) => (
        <div class="flex flex-col gap-4">
          <NoticeCard tone="warning">{t().machineKeyOneTime}</NoticeCard>
          <p class="text-sm text-secondary">{access() === "models" ? t().modelsOnlyKey : t().fullKeyAccess}</p>
          <code class="break-all rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3 text-xs text-primary">{value()}</code>
          <div class="flex flex-wrap justify-end gap-2">
            <CopyButton text={value()} label={t().copyMachineKey} />
            <Button onClick={props.close}>{t().done}</Button>
          </div>
        </div>
      )}
    </Show>
  );
}

export default function CreateMachineKey(props: { modelsAvailable: boolean }) {
  const t = useAccountsMessages();
  const open = async () => {
    await prompts.dialog<void>(
      (close, context) => (
        <CreateMachineKeyDialog
          modelsAvailable={props.modelsAvailable}
          close={() => close()}
          setDismissHandler={context.setDismissHandler}
        />
      ),
      {
        title: t().createMachineKey,
        icon: "ti ti-key",
        size: "medium",
      },
    );
    await refreshCurrentPath();
  };
  return (
    <Button size="sm" onClick={() => void open()}>
      {t().createMachineKey}
    </Button>
  );
}
