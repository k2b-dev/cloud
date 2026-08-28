import { mutation } from "@k2b/stdlib/solid";
import { Button, IconButton, NoticeCard, prompts, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailProtectedIdentity, MailSecurityPolicy, MailSecurityReport } from "../../security-contracts";
import { readApiError } from "./api-response";
import { mailSettingsMessages } from "./mail-settings-messages";

const refresh = () => window.location.reload();

type PolicyForm = {
  disposition: "deny" | "trust";
  target: "sender_address" | "sender_domain" | "link_domain";
  value: string;
  note?: string;
};

type ProtectedIdentityForm = { name: string; domains: string[]; note?: string };
type AuthenticationForm = { servers?: string[] };
type ResolutionForm = { note?: string };

function MailAdminSecurityToolbar(props: { trustedAuthservIds: string[] | null }) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const createPolicy = mutation.create<boolean, void>({
    mutation: async (_, { abortSignal }) => {
      const values = (await prompts.form({
        title: messages().addSecurityRule,
        icon: "ti ti-shield-plus",
        fields: {
          guidance: {
            type: "info",
            content: () => (
              <NoticeCard tone="info" title={messages().rulesAffectEveryMailbox} detail={messages().securityRuleScopeDescription} />
            ),
          },
          disposition: {
            type: "select",
            label: messages().rule,
            required: true,
            default: "deny",
            options: [
              { id: "deny", label: messages().block },
              { id: "trust", label: messages().trustAuthenticatedSender },
            ],
          },
          target: {
            type: "select",
            label: messages().match,
            required: true,
            default: "sender_domain",
            options: [
              { id: "sender_address", label: messages().senderAddress },
              { id: "sender_domain", label: messages().senderDomain },
              { id: "link_domain", label: messages().linkDomainBlockOnly },
            ],
          },
          value: { type: "text", label: messages().addressOrDomain, required: true },
          note: {
            type: "text",
            multiline: true,
            label: messages().reason,
            description: messages().administratorContext,
          },
        },
        confirmText: messages().addRule,
      })) as PolicyForm | null;
      if (!values || abortSignal.aborted) return false;
      const response = await apiClient.admin.security.policies.$post(
        {
          json: {
            disposition: values.disposition,
            target: values.target,
            value: values.value,
            note: values.note?.trim() || null,
            enabled: true,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedAddSecurityRule));
      return true;
    },
    onSuccess: (changed) => changed && refresh(),
    onError: (error) => prompts.error(error.message),
  });
  const createIdentity = mutation.create<boolean, void>({
    mutation: async (_, { abortSignal }) => {
      const values = (await prompts.form({
        title: messages().protectSenderIdentity,
        icon: "ti ti-user-shield",
        fields: {
          guidance: {
            type: "info",
            content: () => (
              <NoticeCard tone="info" title={messages().visibleNamesCanBeCopied} detail={messages().protectedIdentityDescription} />
            ),
          },
          name: { type: "text", label: messages().visibleSenderName, required: true },
          domains: {
            type: "tags",
            label: messages().allowedSendingDomains,
            description: messages().allowedSendingDomainsDescription,
            required: true,
            maxTags: 20,
          },
          note: { type: "text", multiline: true, label: messages().reason },
        },
        confirmText: messages().protectIdentity,
      })) as ProtectedIdentityForm | null;
      if (!values || abortSignal.aborted) return false;
      const response = await apiClient.admin.security["protected-identities"].$post(
        { json: { name: values.name, allowedDomains: values.domains, note: values.note?.trim() || null, enabled: true } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedProtectIdentity));
      return true;
    },
    onSuccess: (changed) => changed && refresh(),
    onError: (error) => prompts.error(error.message),
  });
  const editAuthentication = mutation.create<boolean, void>({
    mutation: async (_, { abortSignal }) => {
      const values = (await prompts.form({
        title: messages().trustedAuthenticationResults,
        icon: "ti ti-certificate",
        fields: {
          guidance: {
            type: "info",
            content: () => (
              <NoticeCard tone="info" title={messages().authServerNamesNotDomains} detail={messages().trustedAuthDescription} />
            ),
          },
          servers: {
            type: "tags",
            label: messages().authenticationServerNames,
            description: messages().authenticationServerNamesDescription,
            default: props.trustedAuthservIds ?? [],
            maxTags: 20,
          },
        },
        confirmText: messages().save,
      })) as AuthenticationForm | null;
      if (!values || abortSignal.aborted) return false;
      const response = await apiClient.admin.security.settings.$patch(
        { json: { trustedAuthservIds: values.servers ?? [] } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedSaveTrustedAuthentication));
      return true;
    },
    onSuccess: (changed) => changed && refresh(),
    onError: (error) => prompts.error(error.message),
  });
  const busy = () => createPolicy.loading() || createIdentity.loading() || editAuthentication.loading();
  return (
    <div class="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={busy()} onClick={() => createPolicy.mutate()}>
        <i class="ti ti-shield-plus" aria-hidden="true" /> {messages().addRule}
      </Button>
      <Button size="sm" variant="secondary" disabled={busy()} onClick={() => createIdentity.mutate()}>
        <i class="ti ti-user-shield" aria-hidden="true" /> {messages().protectIdentity}
      </Button>
      <Button
        size="sm"
        variant="subtle"
        disabled={busy() || props.trustedAuthservIds === null}
        title={props.trustedAuthservIds === null ? messages().authenticationSettingsLoadFailed : undefined}
        onClick={() => editAuthentication.mutate()}
      >
        <i class="ti ti-certificate" aria-hidden="true" /> {messages().authentication}
      </Button>
    </div>
  );
}

function MailAdminReportActions(props: { report: MailSecurityReport }) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const resolve = mutation.create<boolean, MailSecurityReport["status"]>({
    mutation: async (status, { abortSignal }) => {
      const values = (await prompts.form({
        title:
          status === "confirmed"
            ? messages().confirmPhishingReport
            : status === "dismissed"
              ? messages().dismissPhishingReport
              : messages().reviewReport,
        icon: status === "confirmed" ? "ti ti-shield-check" : "ti ti-shield-search",
        fields: { note: { type: "text", multiline: true, label: messages().internalNote, default: props.report.resolutionNote ?? "" } },
        confirmText: status === "confirmed" ? messages().confirm : status === "dismissed" ? messages().dismiss : messages().startReview,
      })) as ResolutionForm | null;
      if (!values || abortSignal.aborted) return false;
      const response = await apiClient.admin.security.reports[":reportId"].$patch(
        {
          param: { reportId: props.report.id },
          json: { status: status as "in_review" | "confirmed" | "dismissed", resolutionNote: values.note?.trim() || null },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedUpdateReport));
      return true;
    },
    onSuccess: (changed) => changed && refresh(),
    onError: (error) => prompts.error(error.message),
  });
  const blockSender = mutation.create<boolean, void>({
    mutation: async (_, { abortSignal }) => {
      if (!props.report.senderAddress) return false;
      const confirmed = await prompts.confirm(messages().blockReportedSenderDescription, {
        title: messages().blockSenderQuestion({ address: props.report.senderAddress }),
        confirmText: messages().blockSender,
        variant: "danger",
      });
      if (!confirmed || abortSignal.aborted) return false;
      const response = await apiClient.admin.security.policies.$post(
        {
          json: {
            disposition: "deny",
            target: "sender_address",
            value: props.report.senderAddress,
            note: messages().phishingReportNote({ id: props.report.id }),
            enabled: true,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedBlockReportedSender));
      return true;
    },
    onSuccess: (changed) => changed && refresh(),
    onError: (error) => prompts.error(error.message),
  });
  const busy = () => resolve.loading() || blockSender.loading();
  return (
    <div class="flex justify-end gap-1">
      {props.report.status === "new" ? (
        <IconButton size="sm" label={messages().startReview} disabled={busy()} onClick={() => resolve.mutate("in_review")}>
          <i class="ti ti-shield-search" aria-hidden="true" />
        </IconButton>
      ) : null}
      {props.report.senderAddress ? (
        <IconButton size="sm" label={messages().blockReportedSender} disabled={busy()} onClick={() => blockSender.mutate()}>
          <i class="ti ti-user-x" aria-hidden="true" />
        </IconButton>
      ) : null}
      <IconButton size="sm" label={messages().confirmPhishing} disabled={busy()} onClick={() => resolve.mutate("confirmed")}>
        <i class="ti ti-shield-check" aria-hidden="true" />
      </IconButton>
      <IconButton size="sm" label={messages().dismissReport} disabled={busy()} onClick={() => resolve.mutate("dismissed")}>
        <i class="ti ti-shield-off" aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function MailAdminPolicyActions(props: { policy: MailSecurityPolicy }) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const update = mutation.create<boolean, "toggle" | "delete">({
    mutation: async (operation, { abortSignal }) => {
      if (operation === "delete") {
        const confirmed = await prompts.confirm(messages().deleteRuleDescription, {
          title: messages().deleteRuleQuestion({ value: props.policy.value }),
          confirmText: messages().deleteRule,
          variant: "danger",
        });
        if (!confirmed) return false;
        const response = await apiClient.admin.security.policies[":policyId"].$delete(
          { param: { policyId: props.policy.id } },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, messages().failedDeleteRule));
      } else {
        const response = await apiClient.admin.security.policies[":policyId"].$patch(
          { param: { policyId: props.policy.id }, json: { enabled: !props.policy.enabled } },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, messages().failedUpdateRule));
      }
      return true;
    },
    onSuccess: (changed) => changed && refresh(),
    onError: (error) => prompts.error(error.message),
  });
  return (
    <div class="flex justify-end gap-1">
      <IconButton
        size="sm"
        label={props.policy.enabled ? messages().disableRule : messages().enableRule}
        onClick={() => update.mutate("toggle")}
      >
        <i class={`ti ${props.policy.enabled ? "ti-player-pause" : "ti-player-play"}`} aria-hidden="true" />
      </IconButton>
      <IconButton size="sm" label={messages().deleteRule} onClick={() => update.mutate("delete")}>
        <i class="ti ti-trash" aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function MailAdminProtectedIdentityActions(props: { identity: MailProtectedIdentity }) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const remove = mutation.create<boolean, void>({
    mutation: async (_, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().stopProtectingDescription, {
        title: messages().stopProtectingQuestion({ name: props.identity.name }),
        confirmText: messages().remove,
        variant: "danger",
      });
      if (!confirmed) return false;
      const response = await apiClient.admin.security["protected-identities"][":identityId"].$delete(
        { param: { identityId: props.identity.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedRemoveProtectedIdentity));
      return true;
    },
    onSuccess: (changed) => changed && refresh(),
    onError: (error) => prompts.error(error.message),
  });
  return (
    <IconButton size="sm" label={messages().removeProtectedIdentity} onClick={() => remove.mutate()}>
      <i class="ti ti-trash" aria-hidden="true" />
    </IconButton>
  );
}

type MailAdminSecurityActionsProps =
  | { kind: "toolbar"; trustedAuthservIds: string[] | null }
  | { kind: "report"; report: MailSecurityReport }
  | { kind: "policy"; policy: MailSecurityPolicy }
  | { kind: "protected-identity"; identity: MailProtectedIdentity };

export default function MailAdminSecurityActions(props: MailAdminSecurityActionsProps) {
  if (props.kind === "toolbar") {
    return <MailAdminSecurityToolbar trustedAuthservIds={props.trustedAuthservIds} />;
  }
  if (props.kind === "report") {
    return <MailAdminReportActions report={props.report} />;
  }
  if (props.kind === "policy") {
    return <MailAdminPolicyActions policy={props.policy} />;
  }
  return <MailAdminProtectedIdentityActions identity={props.identity} />;
}
