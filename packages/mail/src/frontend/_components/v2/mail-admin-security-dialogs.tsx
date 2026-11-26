import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Field, Input, Notice, Select, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { MailSecurityReport } from "../../../security-contracts";
import { readApiError } from "../api-response";
import { mailSettingsMessages } from "../mail-settings-messages";

// The four forms of Cloud administration › Mail › Security on v2: a rule, a protected identity, the trusted
// authentication servers, and the note of a report's decision. Each sends what the v1 form sent; the server validates,
// and its reason stays in the dialog, so nothing typed is lost. `close(true)` after a save shows the page again.

/** The most entries a list field takes, as the v1 form allowed. */
const MAX_ENTRIES = 20;

/** Entries of a comma separated field, trimmed, without empty ones. */
const entries = (text: string) =>
  text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

type DialogProps = { open: boolean; close: (saved: boolean) => void };

/** A dialog that sends its form once: busy while it runs, the server's reason as a band, closed only after a save. */
const FormDialog = (props: {
  title: string;
  open: boolean;
  close: (saved: boolean) => void;
  confirm: string;
  busy: boolean;
  refusal: string | undefined;
  refusalTitle: string;
  submit: () => void;
  children: JSX.Element;
}) => {
  const t = createMemo(() => mailSettingsMessages.resolve([useLocale()()]).t);
  return (
    <Dialog
      title={props.title}
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.close(false);
      }}
      foot={
        <>
          <Button onClick={() => props.close(false)} disabled={props.busy}>
            {t().cancel}
          </Button>
          <Button variant="primary" busy={props.busy} onClick={() => props.submit()}>
            {props.confirm}
          </Button>
        </>
      }
    >
      {props.children}
      <Show when={props.refusal}>
        {(text) => (
          <Notice tone="bad" title={props.refusalTitle}>
            {text()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
};

/** Sends one form: the server's reason ends in `refusal`; a save closes the dialog. */
const useSend = (send: (signal: AbortSignal) => Promise<void>, close: (saved: boolean) => void) => {
  const [refusal, setRefusal] = createSignal<string>();
  const run = mutation.create<void, void>({
    mutation: (_, { abortSignal }) => {
      setRefusal(undefined);
      return send(abortSignal);
    },
    onSuccess: () => close(true),
    onError: (error) => setRefusal(error.message),
  });
  return { refusal, busy: run.loading, send: () => void run.mutate() };
};

/** Adds a rule for every mailbox: block or trust an address, a domain, or (block only) a link domain. */
export function MailSecurityRuleDialog(props: DialogProps) {
  const locale = useLocale();
  const t = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [disposition, setDisposition] = createSignal<"deny" | "trust">("deny");
  const [target, setTarget] = createSignal<"sender_address" | "sender_domain" | "link_domain">("sender_domain");
  const [value, setValue] = createSignal("");
  const [note, setNote] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const missing = () => tried() && !value().trim();
  const form = useSend(async (signal) => {
    const response = await apiClient.admin.security.policies.$post(
      { json: { disposition: disposition(), target: target(), value: value(), note: note().trim() || null, enabled: true } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, t().failedAddSecurityRule));
  }, props.close);
  return (
    <FormDialog
      title={t().addSecurityRule}
      open={props.open}
      close={props.close}
      confirm={t().addRule}
      busy={form.busy()}
      refusal={form.refusal()}
      refusalTitle={t().failedAddSecurityRule}
      submit={() => {
        setTried(true);
        if (value().trim()) form.send();
      }}
    >
      <Notice tone="note" icon="info-circle" title={t().rulesAffectEveryMailbox}>
        {t().securityRuleScopeDescription}
      </Notice>
      <Field label={t().rule} required>
        <Select
          value={disposition()}
          onChange={(next) => setDisposition(next === "trust" ? "trust" : "deny")}
          options={[
            { value: "deny", label: t().block },
            { value: "trust", label: t().trustAuthenticatedSender },
          ]}
        />
      </Field>
      <Field label={t().match} required>
        <Select
          value={target()}
          onChange={(next) => setTarget(next === "sender_address" || next === "link_domain" ? next : "sender_domain")}
          options={[
            { value: "sender_address", label: t().senderAddress },
            { value: "sender_domain", label: t().senderDomain },
            { value: "link_domain", label: t().linkDomainBlockOnly },
          ]}
        />
      </Field>
      <Field label={t().addressOrDomain} required error={missing() ? t().fieldRequired : undefined}>
        <Input value={value()} onInput={setValue} spellcheck={false} autocapitalize="off" />
      </Field>
      <Field label={t().reason} hint={t().administratorContext}>
        <Input multiline value={note()} onInput={setNote} />
      </Field>
    </FormDialog>
  );
}

/** Protects a visible sender name: mail with that exact name from another domain gets a warning. */
export function MailProtectedIdentityDialog(props: DialogProps) {
  const locale = useLocale();
  const t = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [name, setName] = createSignal("");
  const [domains, setDomains] = createSignal("");
  const [note, setNote] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const domainError = () => {
    const list = entries(domains());
    if (tried() && list.length === 0) return t().fieldRequired;
    if (list.length > MAX_ENTRIES) return t().atMostEntries({ max: MAX_ENTRIES });
    return undefined;
  };
  const form = useSend(async (signal) => {
    const response = await apiClient.admin.security["protected-identities"].$post(
      { json: { name: name(), allowedDomains: entries(domains()), note: note().trim() || null, enabled: true } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, t().failedProtectIdentity));
  }, props.close);
  return (
    <FormDialog
      title={t().protectSenderIdentity}
      open={props.open}
      close={props.close}
      confirm={t().protectIdentity}
      busy={form.busy()}
      refusal={form.refusal()}
      refusalTitle={t().failedProtectIdentity}
      submit={() => {
        setTried(true);
        const list = entries(domains());
        if (name().trim() && list.length > 0 && list.length <= MAX_ENTRIES) form.send();
      }}
    >
      <Notice tone="note" icon="info-circle" title={t().visibleNamesCanBeCopied}>
        {t().protectedIdentityDescription}
      </Notice>
      <Field label={t().visibleSenderName} required error={tried() && !name().trim() ? t().fieldRequired : undefined}>
        <Input value={name()} onInput={setName} />
      </Field>
      <Field
        label={t().allowedSendingDomains}
        required
        hint={`${t().allowedSendingDomainsDescription} ${t().commaSeparated}`}
        error={domainError()}
      >
        {/* TagsInput is on main, not yet on this base; until then the domains are one comma separated field */}
        <Input value={domains()} onInput={setDomains} spellcheck={false} autocapitalize="off" />
      </Field>
      <Field label={t().reason}>
        <Input multiline value={note()} onInput={setNote} />
      </Field>
    </FormDialog>
  );
}

/** The names of the authentication servers whose results Mail trusts (not domains). */
export function MailTrustedAuthenticationDialog(props: DialogProps & { servers: readonly string[] }) {
  const locale = useLocale();
  const t = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  // the form starts from the saved names each time it opens (the screen makes it while it is open)
  const [servers, setServers] = createSignal(props.servers.join(", "));
  const error = () => (entries(servers()).length > MAX_ENTRIES ? t().atMostEntries({ max: MAX_ENTRIES }) : undefined);
  const form = useSend(async (signal) => {
    const response = await apiClient.admin.security.settings.$patch(
      { json: { trustedAuthservIds: entries(servers()) } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, t().failedSaveTrustedAuthentication));
  }, props.close);
  return (
    <FormDialog
      title={t().trustedAuthenticationResults}
      open={props.open}
      close={props.close}
      confirm={t().save}
      busy={form.busy()}
      refusal={form.refusal()}
      refusalTitle={t().failedSaveTrustedAuthentication}
      submit={() => {
        if (!error()) form.send();
      }}
    >
      <Notice tone="note" icon="info-circle" title={t().authServerNamesNotDomains}>
        {t().trustedAuthDescription}
      </Notice>
      <Field
        label={t().authenticationServerNames}
        hint={`${t().authenticationServerNamesDescription} ${t().commaSeparated}`}
        error={error()}
      >
        <Input value={servers()} onInput={setServers} spellcheck={false} autocapitalize="off" />
      </Field>
    </FormDialog>
  );
}

export type ReportDecision = "in_review" | "confirmed" | "dismissed";

/** The decision on a report with an internal note: start the review, confirm it as phishing, or dismiss it. */
export function MailReportDecisionDialog(props: DialogProps & { report: MailSecurityReport; decision: ReportDecision }) {
  const locale = useLocale();
  const t = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [note, setNote] = createSignal(props.report.resolutionNote ?? "");
  const form = useSend(async (signal) => {
    const response = await apiClient.admin.security.reports[":reportId"].$patch(
      { param: { reportId: props.report.id }, json: { status: props.decision, resolutionNote: note().trim() || null } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, t().failedUpdateReport));
  }, props.close);
  const words = () =>
    props.decision === "confirmed"
      ? { title: t().confirmPhishingReport, confirm: t().confirm }
      : props.decision === "dismissed"
        ? { title: t().dismissPhishingReport, confirm: t().dismiss }
        : { title: t().reviewReport, confirm: t().startReview };
  return (
    <FormDialog
      title={words().title}
      open={props.open}
      close={props.close}
      confirm={words().confirm}
      busy={form.busy()}
      refusal={form.refusal()}
      refusalTitle={t().failedUpdateReport}
      submit={form.send}
    >
      <Show when={props.report.senderAddress}>{(address) => <Text>{address()}</Text>}</Show>
      <Field label={t().internalNote}>
        <Input multiline value={note()} onInput={setNote} />
      </Field>
    </FormDialog>
  );
}
