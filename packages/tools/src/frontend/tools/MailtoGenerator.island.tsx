import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Button, Empty, Facts, Field, Input, Notice, Pane, Section } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { toolsWorkspaceMessages } from "../tools-messages";

export const mailtoMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      // Rendered after a literal <code>mailto:</code> subject token.
      noticeReplyTo: "does not support a Reply-To field. The recipient will always reply to the sender address.",
      toLabel: "To",
      toDescription: "Primary recipient email address.",
      toPlaceholder: "recipient@example.com",
      ccDescription: "Carbon copy, visible to all recipients. Separate several addresses with commas.",
      ccPlaceholder: "Add CC address...",
      bccDescription: "Blind carbon copy, hidden from other recipients.",
      bccPlaceholder: "Add BCC address...",
      subjectLabel: "Subject",
      subjectDescription: "Pre-filled subject line for the email.",
      subjectPlaceholder: "Email subject",
      bodyLabel: "Body",
      bodyDescription: "Pre-filled body text. Line breaks are preserved.",
      bodyPlaceholder: "Email body text...",
      emailLinkLabel: ({ to }: { to: string }) => `Email ${to}`,
      mailtoLink: "Mailto Link",
      copyLink: "Copy Link",
      copyMarkdown: "Copy Markdown",
      copyHtml: "Copy HTML",
      openInMailClient: "Open in Mail Client",
    },
    de: {
      noticeReplyTo: "unterstützt kein Reply-To-Feld. Antworten gehen immer an die Absenderadresse.",
      toLabel: "An",
      toDescription: "E-Mail-Adresse für das Feld „An“.",
      toPlaceholder: "empfaenger@example.com",
      ccDescription: "Kopie, für alle Empfänger sichtbar. Mehrere Adressen mit Kommas trennen.",
      ccPlaceholder: "CC-Adresse hinzufügen...",
      bccDescription: "Blindkopie, die für andere empfangende Personen nicht sichtbar ist.",
      bccPlaceholder: "BCC-Adresse hinzufügen...",
      subjectLabel: "Betreff",
      subjectDescription: "Vorausgefüllter Betreff der E-Mail.",
      subjectPlaceholder: "Betreff der E-Mail",
      bodyLabel: "Nachricht",
      bodyDescription: "Vorausgefüllter Nachrichtentext. Zeilenumbrüche bleiben erhalten.",
      bodyPlaceholder: "Nachrichtentext...",
      emailLinkLabel: ({ to }) => `E-Mail an ${to}`,
      mailtoLink: "Mailto-Link",
      copyLink: "Link kopieren",
      copyMarkdown: "Markdown kopieren",
      copyHtml: "HTML kopieren",
      openInMailClient: "Im E-Mail-Programm öffnen",
    },
  },
});

/** Addresses typed into one field, separated by commas, semicolons or spaces. */
const addresses = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter(Boolean);

/**
 * Email links on v2: the recipients, subject and text as fields, the link with its Markdown and HTML forms below as
 * values to copy, and "Im Mailprogramm öffnen" as the page's main deed. The Reply-To limit of `mailto:` is a note
 * above the fields.
 */
export default function MailtoGenerator() {
  const locale = useLocale();
  const t = () => mailtoMessages.resolve([locale()]).t;
  const w = () => toolsWorkspaceMessages.resolve([locale()]).t;
  const [to, setTo] = createSignal("");
  const [cc, setCc] = createSignal("");
  const [bcc, setBcc] = createSignal("");
  const [subject, setSubject] = createSignal("");
  const [body, setBody] = createSignal("");
  const mailto = createMemo(() => {
    const toAddr = to().trim();
    if (!toAddr) return "";
    const params: string[] = [];
    if (addresses(cc()).length > 0) params.push(`cc=${encodeURIComponent(addresses(cc()).join(","))}`);
    if (addresses(bcc()).length > 0) params.push(`bcc=${encodeURIComponent(addresses(bcc()).join(","))}`);
    if (subject().trim()) params.push(`subject=${encodeURIComponent(subject().trim())}`);
    if (body().trim()) params.push(`body=${encodeURIComponent(body().trim())}`);
    return `mailto:${encodeURIComponent(toAddr)}${params.length > 0 ? `?${params.join("&")}` : ""}`;
  });
  const label = () => subject().trim() || t().emailLinkLabel({ to: to().trim() });
  const markdownLink = () => (mailto() ? `[${label()}](${mailto()})` : "");
  const htmlLink = () => (mailto() ? `<a href="${mailto()}">${label()}</a>` : "");
  return (
    <ToolsScreen
      tool="mailto"
      primary={{ label: t().openInMailClient, icon: "external-link", href: mailto() || undefined, disabled: !mailto() }}
      end={
        <Button variant="primary" icon="external-link" href={mailto() || undefined} disabled={!mailto()}>
          {t().openInMailClient}
        </Button>
      }
    >
      <Pane label={w().result} scrollKey="tools-mailto">
        <Notice tone="warn" title="mailto:">
          {`mailto: ${t().noticeReplyTo}`}
        </Notice>
        <Band label={w().input}>
          <Field label={t().toLabel} hint={t().toDescription}>
            <Input type="email" icon="mail" placeholder={t().toPlaceholder} value={to()} onInput={setTo} />
          </Field>
          {/* k2b-ui gap: v2 has no tags input for several addresses; they are typed into one field, separated by commas. */}
          <Field.Row>
            <Field label="CC" hint={t().ccDescription} optional={w().optional}>
              <Input icon="users" placeholder={t().ccPlaceholder} value={cc()} onInput={setCc} />
            </Field>
            <Field label="BCC" hint={t().bccDescription} optional={w().optional}>
              <Input icon="user-off" placeholder={t().bccPlaceholder} value={bcc()} onInput={setBcc} />
            </Field>
          </Field.Row>
          <Field label={t().subjectLabel} hint={t().subjectDescription} optional={w().optional}>
            <Input placeholder={t().subjectPlaceholder} value={subject()} onInput={setSubject} />
          </Field>
          <Field label={t().bodyLabel} hint={t().bodyDescription} optional={w().optional}>
            <Input multiline placeholder={t().bodyPlaceholder} value={body()} onInput={setBody} />
          </Field>
        </Band>
        <Section icon="link" title={w().result}>
          <Show when={mailto()} fallback={<Empty icon="mail-forward" text={w().nothingYet} />}>
            <Facts
              items={[
                { label: t().mailtoLink, value: mailto(), mono: true, copy: mailto() },
                { label: "Markdown", value: markdownLink(), mono: true, copy: markdownLink() },
                { label: "HTML", value: htmlLink(), mono: true, copy: htmlLink() },
              ]}
            />
          </Show>
        </Section>
      </Pane>
    </ToolsScreen>
  );
}
