import { coreClient } from "@k2b/cloud/clients/core";
import { Bar, Button, Chip, Choice, Dialog, Facts, Field, Input, Notice, Section, Text } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import type { AgentKey } from "./agent-keys";
import { type AgentMessages, useAgentMessages } from "./messages";

/** A key as the page shows it: dates come formatted from the server, so the first paint and the live page agree. */
export type AgentKeyView = Pick<AgentKey, "id" | "name" | "tokenPrefix" | "access"> & {
  created: string;
  lastUsed: string | null;
  expires: string | null;
  expired: boolean;
};

export const accessLabel = (t: AgentMessages, access: AgentKey["access"]) =>
  access === "models" ? t.modelsOnly : access === "legacy" ? t.legacyLimited : t.fullAccess;

const ErrorSchema = z.object({ message: z.string() });
const CreatedSchema = z.object({ token: z.string().min(1) });

const errorMessage = async (response: { json: () => Promise<unknown> } | null, fallback: string) => {
  const parsed = ErrorSchema.safeParse(response ? await response.json().catch(() => null) : null);
  return parsed.success ? parsed.data.message : fallback;
};

/**
 * The dialog for a new key: a name and the access, then the key itself, once, with a copy button. The token lives
 * only in this dialog's memory; closing it shows the list with the new key and drops the token.
 */
export function NewKeyDialog(props: {
  agent: { id: string; name: string; active: boolean };
  modelsAvailable: boolean;
  open: boolean;
  /** Close the dialog; `changed` when a key was created or may have been, so the list must be read again. */
  close: (changed: boolean) => void;
}) {
  const t = useAgentMessages();
  const [name, setName] = createSignal("");
  const [access, setAccess] = createSignal<"full" | "models">("full");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // A lost answer may follow a created key: offer no second creation, the list shows what exists.
  const [uncertain, setUncertain] = createSignal(false);
  const [token, setToken] = createSignal<string | null>(null);
  const nameError = () => (tried() && !name().trim() ? t().keyNameRequired : undefined);

  const create = async () => {
    setTried(true);
    if (busy() || uncertain() || !props.agent.active || !name().trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"]
        .$post({ param: { id: props.agent.id }, json: { name: name().trim(), access: access(), expiresAt: null } })
        .catch(() => null);
      if (response && !response.ok && response.status < 500) {
        setError(await errorMessage(response, t().createFailed));
        return;
      }
      const created = CreatedSchema.safeParse(response?.ok ? await response.json().catch(() => null) : null);
      if (!created.success) {
        setUncertain(true);
        setError(t().createUncertain);
        return;
      }
      setToken(created.data.token);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (!busy()) props.close(token() !== null || uncertain());
  };

  return (
    <Dialog
      title={token() ? t().created_ : t().createKeyFor({ name: props.agent.name })}
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      foot={
        <Show
          when={token()}
          fallback={
            <>
              <Button onClick={close} disabled={busy()}>
                {t().cancel}
              </Button>
              {/* k2b-ui gap: a v2 button has no busy state; the label says it and the button rests disabled */}
              <Button icon="key" onClick={() => void create()} disabled={busy() || uncertain() || !props.agent.active}>
                {busy() ? t().creating : t().create}
              </Button>
            </>
          }
        >
          <Button onClick={close}>{t().done}</Button>
        </Show>
      }
    >
      <Show
        when={token()}
        fallback={
          <>
            <Show when={!props.agent.active}>
              <Notice tone="warn" icon="alert-triangle">
                {t().agentDisabledNotice}
              </Notice>
            </Show>
            <Field name="name" label={t().keyName} hint={t().keyNameHint} error={nameError()} required>
              <Input
                value={name()}
                onInput={setName}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.isComposing) void create();
                }}
              />
            </Field>
            <Show when={props.modelsAvailable}>
              <Field name="access" label={t().keyAccess} hint={access() === "models" ? t().modelsOnlyHint : t().fullAccessHint}>
                <Choice
                  name="access"
                  value={access()}
                  onChange={(value) => setAccess(value === "models" ? "models" : "full")}
                  options={[
                    { value: "full", label: t().fullAccess },
                    { value: "models", label: t().modelsOnly },
                  ]}
                />
              </Field>
            </Show>
            <Show when={error()}>
              {(message) => (
                <Notice tone="bad" icon="alert-circle">
                  {message()}
                </Notice>
              )}
            </Show>
          </>
        }
      >
        {(value) => (
          <>
            <Notice tone="warn" icon="key">
              {t().oneTime}
            </Notice>
            <Facts
              items={[
                { label: t().keyName, value: name().trim() },
                { label: t().token, value: value(), copy: value() },
                { label: t().keyAccess, value: accessLabel(t(), access()) },
              ]}
            />
          </>
        )}
      </Show>
    </Dialog>
  );
}

/** One key beside the list: its facts, and "Revoke", which asks once more in a dialog. */
export function OpenKey(props: { agentId: string; entry: AgentKeyView; revoked: () => void }) {
  const t = useAgentMessages();
  const [asking, setAsking] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const revoke = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"][":credentialId"]
        .$delete({ param: { id: props.agentId, credentialId: props.entry.id } })
        .catch(() => null);
      if (!response?.ok) {
        setError(await errorMessage(response, t().revokeFailed));
        return;
      }
      setAsking(false);
      props.revoked();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Section title={t().details}>
        <Facts
          items={[
            { label: t().prefix, value: `${props.entry.tokenPrefix}…` },
            { label: t().keyAccess, value: accessLabel(t(), props.entry.access) },
            { label: t().created, value: props.entry.created },
            { label: t().lastUsed, value: props.entry.lastUsed ?? t().neverUsed },
            {
              label: t().expires,
              value: props.entry.expired ? <Chip status="warn">{t().expired}</Chip> : (props.entry.expires ?? t().never),
            },
          ]}
        />
      </Section>
      <Bar
        end={
          <Button icon="key-off" onClick={() => setAsking(true)}>
            {t().revoke}
          </Button>
        }
      />
      {/* k2b-ui gap: no alert dialog yet (lane C brings it); a Dialog asks, its last button revokes */}
      <Dialog
        title={t().revokeTitle({ name: props.entry.name })}
        open={asking()}
        onOpenChange={(open) => {
          if (!busy()) setAsking(open);
        }}
        foot={
          <>
            <Button onClick={() => setAsking(false)} disabled={busy()}>
              {t().cancel}
            </Button>
            <Button icon="key-off" onClick={() => void revoke()} disabled={busy()}>
              {busy() ? t().revoking : t().revoke}
            </Button>
          </>
        }
      >
        <Text>{t().revokeConsequence}</Text>
        <Show when={error()}>
          {(message) => (
            <Notice tone="bad" icon="alert-circle">
              {message()}
            </Notice>
          )}
        </Show>
      </Dialog>
    </>
  );
}
