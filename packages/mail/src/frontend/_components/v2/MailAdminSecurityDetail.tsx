import type { DateContext } from "@k2b/stdlib";
import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Facts, Mark, Menu, type MenuEntry, Pane, Prose, Section, type Status, Text } from "@k2b/ui/v2";
import { createMemo, type JSX, Show } from "solid-js";
import type { MailProtectedIdentity, MailSecurityPolicy, MailSecurityReport } from "../../../security-contracts";
import { mailPageMessages } from "../../pages-messages";
import { mailSettingsMessages } from "../mail-settings-messages";

const SECURITY_COLOR = "#b45309";

/** What a row of Security opens beside its list: the whole of what the one-line row cuts. */
export type SecurityOpen =
  | {
      kind: "report";
      report: MailSecurityReport;
      state: { label: string; status?: Status };
      findings: readonly { title: string; explanation: string }[];
    }
  | { kind: "rule"; policy: MailSecurityPolicy; rule: string; target: string }
  | { kind: "identity"; identity: MailProtectedIdentity };

type Props = {
  open: SecurityOpen;
  /** The address of the list without the open entry: the way back on the phone and the close ×. */
  closeHref: string;
  deeds: readonly MenuEntry[];
  dateConfig: DateContext;
};

/**
 * The open report, rule or protected identity beside the list (list-detail recipe): its mark and name in the head
 * with its deeds, then every value whole, wrapped and copyable, which the row of one line cuts (B rule 4).
 */
export default function MailAdminSecurityDetail(props: Props) {
  const locale = useLocale();
  const t = createMemo(() => mailPageMessages.resolve([locale()]).t);
  const words = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const when = (iso: string) => dates.formatDateTime(iso, props.dateConfig);
  const name = () => {
    const open = props.open;
    if (open.kind === "report") return open.report.senderAddress ?? t().unknownSender;
    if (open.kind === "rule") return open.policy.value;
    return open.identity.name;
  };
  const icon = () =>
    props.open.kind === "report"
      ? "flag"
      : props.open.kind === "rule"
        ? props.open.policy.disposition === "deny"
          ? "ban"
          : "circle-check"
        : "user-shield";
  // each kind narrowed once, so its part below reads it typed
  const asReport = () => (props.open.kind === "report" ? props.open : undefined);
  const asRule = () => (props.open.kind === "rule" ? props.open : undefined);
  const asIdentity = () => (props.open.kind === "identity" ? props.open : undefined);
  /** Text as Markdown would read it: written as code, so no sign in it formats anything. */
  const code = (value: string) => `\`${value.replaceAll("`", "'")}\``;
  const stateChip = (state: { label: string; status?: Status }) =>
    state.status ? <Chip status={state.status}>{state.label}</Chip> : <Chip>{state.label}</Chip>;
  const note = (text: string | null, empty: string): JSX.Element => (text ? <Prose>{text}</Prose> : <Text muted>{empty}</Text>);

  return (
    <Pane
      detail
      label={name()}
      back={{ label: t().phishingProtection, href: props.closeHref }}
      scrollKey="mail-admin-security-detail"
      head={
        <Bar
          start={
            <>
              <Mark icon={icon()} color={SECURITY_COLOR} />
              <Text type="lead">{name()}</Text>
            </>
          }
          end={
            <>
              <Menu label={words().moreActionsFor({ name: name() })} items={props.deeds} />
              <Button variant="ghost" icon="x" label={t().close} href={props.closeHref} />
            </>
          }
        />
      }
    >
      <Show when={asReport()}>
        {(open) => {
          const report = () => open().report;
          const findings = () => open().findings;
          const domain = () => open().report.senderDomain;
          return (
            <>
              <Section icon="flag" title={t().reportSection}>
                <Facts
                  items={[
                    { label: t().status, value: stateChip(open().state) },
                    {
                      label: t().sender,
                      value: report().senderAddress ?? t().unknownSender,
                      mono: true,
                      copy: report().senderAddress ?? undefined,
                    },
                    ...(domain() ? [{ label: t().senderDomainLabel, value: domain() ?? "", mono: true, copy: domain() ?? undefined }] : []),
                    { label: t().reports, value: new Intl.NumberFormat(locale()).format(report().reportCount) },
                    { label: t().receivedAt, value: when(report().createdAt) },
                    { label: t().updatedColumn, value: when(report().updatedAt) },
                    { label: t().messageIdLabel, value: report().messageId, mono: true, copy: report().messageId },
                    { label: t().mailboxIdLabel, value: report().mailboxId, mono: true, copy: report().mailboxId },
                  ]}
                />
              </Section>
              <Section icon="list-search" title={t().evidence} count={findings().length || undefined}>
                <Show when={findings().length > 0} fallback={<Text muted>{t().reportedByUser}</Text>}>
                  <Prose
                    markdown={findings()
                      .map((finding) => `- **${finding.title.replaceAll("*", "")}**: ${finding.explanation.replaceAll("*", "")}`)
                      .join("\n")}
                  />
                </Show>
              </Section>
              <Section icon="note" title={words().internalNote}>
                {note(report().resolutionNote, t().noNote)}
              </Section>
            </>
          );
        }}
      </Show>
      <Show when={asRule()}>
        {(open) => {
          const rule = () => open();
          return (
            <>
              <Section icon="shield" title={t().ruleSection}>
                <Facts
                  items={[
                    { label: t().rule, value: <Chip>{rule().rule}</Chip> },
                    { label: t().match, value: rule().target },
                    { label: t().value, value: rule().policy.value, mono: true, copy: rule().policy.value },
                    { label: t().state, value: rule().policy.enabled ? t().healthActive : t().paused },
                    { label: t().createdAt, value: when(rule().policy.createdAt) },
                    { label: t().updatedColumn, value: when(rule().policy.updatedAt) },
                  ]}
                />
              </Section>
              <Section icon="note" title={words().reason}>
                {note(rule().policy.note, t().noNote)}
              </Section>
            </>
          );
        }}
      </Show>
      <Show when={asIdentity()}>
        {(open) => {
          const identity = () => open().identity;
          return (
            <>
              <Section icon="user-shield" title={t().identitySection}>
                <Facts
                  items={[
                    { label: t().visibleName, value: identity().name, copy: identity().name },
                    { label: t().state, value: identity().enabled ? t().healthActive : t().paused },
                    { label: t().createdAt, value: when(identity().createdAt) },
                  ]}
                />
              </Section>
              <Section icon="world" title={t().allowedDomains} count={identity().allowedDomains.length}>
                <Prose
                  markdown={identity()
                    .allowedDomains.map((domain) => `- ${code(domain)}`)
                    .join("\n")}
                />
              </Section>
              <Section icon="note" title={words().reason}>
                {note(identity().note, t().noNote)}
              </Section>
            </>
          );
        }}
      </Show>
    </Pane>
  );
}
