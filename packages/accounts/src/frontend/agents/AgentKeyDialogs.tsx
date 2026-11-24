import { coreClient } from "@k2b/cloud/clients/core";
import { Bar, Button, Chip, Choice, Dialog, Facts, Field, Input, Notice, Section } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import type { AgentKey } from "./agent-keys";
import { type AgentMessages, useAgentMessages } from "./messages";

/** A key as the page shows it: dates come formatted from the server, so the first paint and the live page agree. */
export type AgentKeyView = Pick<AgentKey, "id" | "name" | "tokenPrefix" | "access"> & {
  created: string;
  /** When it was last used, relative to the page's time ("vor 2 Stunden"); the exact time stands in the open key. */
  lastUsed: string | null;
  lastUsedExact: string | null;
  expires: string | null;
  expired: boolean;
};

export const accessLabel = (t: AgentMessages, access: AgentKey["access"]) =>
  access === "models" ? t.modelsOnly : access === "legacy" ? t.legacyLimited : t.fullAccess;

const CreatedSchema = z.object({ token: z.string().min(1) });

/** The app owns the final words: a known refusal gets its own sentence, anything else the deed's fallback. */
const errorMessage = (t: AgentMessages, status: number | undefined, refused: string, gone: string, fallback: string) =>
  status === 400 ? refused : status === 403 ? t.noRight : status === 404 ? gone : fallback;

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
        setError(errorMessage(t(), response.status, t().createRefused, t().agentGone, t().createFailed));
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
      // While the token shows, an outside press or a swipe would lose the one copy: only "Fertig", × and Escape close.
      dismissible={token() === null}
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
              <Button variant="primary" icon="key" onClick={() => void create()} disabled={busy() || uncertain() || !props.agent.active}>
                {busy() ? t().creating : t().create}
              </Button>
            </>
          }
        >
          <Button variant="primary" onClick={close}>
            {t().done}
          </Button>
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
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const revoke = async () => {
    if (busy()) return;
    const agreed = await Dialog.confirm({
      title: t().revokeTitle({ name: props.entry.name }),
      description: t().revokeConsequence,
      confirm: t().revoke,
      cancel: t().cancel,
    });
    if (!agreed || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"][":credentialId"]
        .$delete({ param: { id: props.agentId, credentialId: props.entry.id } })
        .catch(() => null);
      if (!response?.ok) {
        setError(errorMessage(t(), response?.status, t().revokeFailed, t().keyNotFound, t().revokeFailed));
        return;
      }
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
            { label: t().lastUsed, value: props.entry.lastUsedExact ?? t().neverUsed, hint: props.entry.lastUsed ?? undefined },
            {
              label: t().expires,
              value: props.entry.expired ? <Chip status="warn">{t().expired}</Chip> : (props.entry.expires ?? t().never),
            },
          ]}
        />
      </Section>
      <Bar
        end={
          // k2b-ui gap: a v2 button has no busy state; the label says it and the button rests disabled
          <Button icon="key-off" onClick={() => void revoke()} disabled={busy()}>
            {busy() ? t().revoking : t().revoke}
          </Button>
        }
      />
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </>
  );
}
