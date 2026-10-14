import { i18n } from "@k2b/stdlib";
import type { SenderIdentity, SenderIdentityStatusReason } from "../../contracts";

/** Translations of the stable reason codes the Mail service reports for a sender identity that cannot send. */
export const mailSenderIdentityStatusMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      sentFolderMissing: "Sent folder missing",
      sentFolderMissingHint:
        "Choose the folder where Mail saves sent mail, then verify the identity. If the provider saves sent mail itself, verify the identity with that option turned on.",
      providerRejected: "Rejected by the provider",
      providerRejectedHint: "The provider refused the test message. Check the From address and delivery settings, then verify again.",
      verificationRequired: "Not verified",
      verificationRequiredHint: "Send a test message to confirm that the provider accepts this sender.",
      verificationPending: "Verification waiting",
      verificationPendingHint:
        "Mail is synchronizing this mailbox and sends the test message automatically as soon as it can. If that takes longer than 10 minutes, verify the identity again.",
      cannotSend: "This mailbox cannot send yet",
      identityReason: ({ label, reason }: { label: string; reason: string }) => `${label}: ${reason}.`,
      noIdentity: "It has no sender identity. Add one and verify it.",
      openSenderSettings: "Open sender settings",
      askAdmin: "Someone with Manage access to the mailbox can fix this in its settings.",
      chooseSentFolder: "Choose Sent folder",
    },
    de: {
      sentFolderMissing: "Ordner für gesendete E-Mails fehlt",
      sentFolderMissingHint:
        "Wähle den Ordner, in dem Mail gesendete E-Mails speichert, und bestätige dann die Absenderidentität. Speichert der Anbieter gesendete E-Mails selbst, bestätige sie mit eingeschalteter Option dafür.",
      providerRejected: "Vom Anbieter abgelehnt",
      providerRejectedHint:
        "Der Anbieter hat die Testnachricht abgelehnt. Prüfe die Absenderadresse und die Versandeinstellungen und bestätige die Absenderidentität erneut.",
      verificationRequired: "Nicht bestätigt",
      verificationRequiredHint: "Sende eine Testnachricht, um zu bestätigen, dass der Anbieter diesen Absender akzeptiert.",
      verificationPending: "Bestätigung wartet",
      verificationPendingHint:
        "Mail synchronisiert dieses Postfach und sendet die Testnachricht automatisch, sobald es möglich ist. Dauert das länger als 10 Minuten, bestätige die Absenderidentität erneut.",
      cannotSend: "Aus diesem Postfach kann noch nicht gesendet werden",
      identityReason: ({ label, reason }) => `${label}: ${reason}.`,
      noIdentity: "Es hat keine Absenderidentität. Füge eine hinzu und bestätige sie.",
      openSenderSettings: "Absendereinstellungen öffnen",
      askAdmin: "Eine Person mit Verwaltungszugriff auf das Postfach kann das in den Postfacheinstellungen beheben.",
      chooseSentFolder: "Ordner für gesendete E-Mails wählen",
    },
  },
});

/** The translated label and next step for a reason code. */
export const senderIdentityReasonCopy = (reason: SenderIdentityStatusReason, locale: string): { label: string; hint: string } => {
  const t = mailSenderIdentityStatusMessages.resolve([locale]).t;
  if (reason === "sent_folder_missing") return { label: t.sentFolderMissing, hint: t.sentFolderMissingHint };
  if (reason === "provider_rejected") return { label: t.providerRejected, hint: t.providerRejectedHint };
  if (reason === "verification_pending") return { label: t.verificationPending, hint: t.verificationPendingHint };
  return { label: t.verificationRequired, hint: t.verificationRequiredHint };
};

/** The identity whose reason explains why a mailbox without a verified sender cannot send: its default, else the first. */
export const blockedSenderIdentity = (identities: readonly SenderIdentity[]): SenderIdentity | null =>
  identities.find((identity) => identity.isDefault && identity.statusReason) ??
  identities.find((identity) => identity.statusReason) ??
  null;

/** Why a mailbox without a verified sender cannot send, and the next step, for a notice or a dialog. */
export const senderUnavailableDetail = (identities: readonly SenderIdentity[], locale: string): string => {
  const t = mailSenderIdentityStatusMessages.resolve([locale]).t;
  const identity = blockedSenderIdentity(identities);
  if (!identity?.statusReason) return t.noIdentity;
  const copy = senderIdentityReasonCopy(identity.statusReason, locale);
  return `${t.identityReason({ label: identity.label, reason: copy.label })} ${copy.hint}`;
};
