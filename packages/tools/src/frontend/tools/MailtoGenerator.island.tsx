import { i18n } from "@k2b/stdlib";
import { ButtonLink, CopyButton, NoticeCard, TagsInput, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { ToolCodeBlock } from "./ToolOutput";

export const mailtoMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      // Rendered after a literal <code>mailto:</code> subject token.
      noticeReplyTo: "does not support a Reply-To field. The recipient will always reply to the sender address.",
      toLabel: "To",
      toDescription: "Primary recipient email address.",
      toPlaceholder: "recipient@example.com",
      ccDescription: "Carbon copy — visible to all recipients. Press Enter to add.",
      ccPlaceholder: "Add CC address...",
      bccDescription: "Blind carbon copy — hidden from other recipients.",
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
      ccDescription: "Kopie, die für alle empfangenden Personen sichtbar ist. Mit Enter hinzufügen.",
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

export default function MailtoGenerator() {
  const locale = useLocale();
  const t = () => mailtoMessages.resolve([locale()]).t;
  const [to, setTo] = createSignal("");
  const [cc, setCc] = createSignal<string[]>([]);
  const [bcc, setBcc] = createSignal<string[]>([]);
  const [subject, setSubject] = createSignal("");
  const [body, setBody] = createSignal("");

  const mailto = createMemo(() => {
    const toAddr = to().trim();
    if (!toAddr) return "";

    const params: string[] = [];
    if (cc().length > 0) params.push(`cc=${encodeURIComponent(cc().join(","))}`);
    if (bcc().length > 0) params.push(`bcc=${encodeURIComponent(bcc().join(","))}`);
    if (subject().trim()) params.push(`subject=${encodeURIComponent(subject().trim())}`);
    if (body().trim()) params.push(`body=${encodeURIComponent(body().trim())}`);

    return `mailto:${encodeURIComponent(toAddr)}${params.length > 0 ? "?" + params.join("&") : ""}`;
  });

  const markdownLink = createMemo(() => {
    if (!mailto()) return "";
    const label = subject().trim() || t().emailLinkLabel({ to: to().trim() });
    return `[${label}](${mailto()})`;
  });

  const htmlLink = createMemo(() => {
    if (!mailto()) return "";
    const label = subject().trim() || t().emailLinkLabel({ to: to().trim() });
    return `<a href="${mailto()}">${label}</a>`;
  });

  return (
    <div class="flex flex-col gap-4">
      <NoticeCard tone="warning" icon={false} bodyClass="flex items-start gap-2">
        <i class="ti ti-alert-triangle shrink-0 mt-0.5" />
        <span>
          <code>mailto:</code> {t().noticeReplyTo}
        </span>
      </NoticeCard>

      <div class="paper p-4 flex flex-col gap-3">
        <TextInput
          label={t().toLabel}
          description={t().toDescription}
          placeholder={t().toPlaceholder}
          icon="ti ti-mail"
          value={to}
          onValueChange={setTo}
          required
        />
        <TagsInput
          label="CC"
          description={t().ccDescription}
          placeholder={t().ccPlaceholder}
          icon="ti ti-users"
          value={cc}
          onValueChange={setCc}
        />
        <TagsInput
          label="BCC"
          description={t().bccDescription}
          placeholder={t().bccPlaceholder}
          icon="ti ti-user-off"
          value={bcc}
          onValueChange={setBcc}
        />
        <TextInput
          label={t().subjectLabel}
          description={t().subjectDescription}
          placeholder={t().subjectPlaceholder}
          icon="ti ti-text-caption"
          value={subject}
          onValueChange={setSubject}
        />
        <TextInput
          label={t().bodyLabel}
          description={t().bodyDescription}
          placeholder={t().bodyPlaceholder}
          multiline
          value={body}
          onValueChange={setBody}
        />
      </div>

      {mailto() && (
        <div class="paper p-4 flex flex-col gap-3">
          {/* Raw mailto link */}
          <div class="flex flex-col gap-1">
            <p class="text-xs font-medium text-dimmed">{t().mailtoLink}</p>
            <ToolCodeBlock>{mailto()}</ToolCodeBlock>
          </div>

          {/* Markdown */}
          <div class="flex flex-col gap-1">
            <p class="text-xs font-medium text-dimmed">Markdown</p>
            <ToolCodeBlock>{markdownLink()}</ToolCodeBlock>
          </div>

          {/* HTML */}
          <div class="flex flex-col gap-1">
            <p class="text-xs font-medium text-dimmed">HTML</p>
            <ToolCodeBlock>{htmlLink()}</ToolCodeBlock>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <CopyButton value={mailto()} label={t().copyLink} variant="secondary" size="sm" />
            <CopyButton value={markdownLink()} label={t().copyMarkdown} variant="secondary" size="sm" />
            <CopyButton value={htmlLink()} label={t().copyHtml} variant="secondary" size="sm" />
            <ButtonLink href={mailto()} size="sm">
              <i class="ti ti-external-link" />
              {t().openInMailClient}
            </ButtonLink>
          </div>
        </div>
      )}
    </div>
  );
}
