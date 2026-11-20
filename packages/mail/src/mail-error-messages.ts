import { i18n } from "@k2b/stdlib";

export const mailErrorMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      senderUnverified: ({ address }: { address: string | null }) =>
        `${address ? `The sender identity ${address}` : "The selected sender identity"} is missing or not verified. Choose another verified sender identity, or ask a mailbox administrator to set it up and verify it in Mail → Mailbox settings → Accounts & identities → Sending identities, then try again.`,
      draftStorageFull:
        "Mail's draft storage is full. Keep your unsent text and try again later. If the problem continues, ask a mailbox administrator to check draft storage.",
      invalidCapabilityInput: "Check the details supplied for this mail action, then try again.",
    },
    de: {
      senderUnverified: ({ address }: { address: string | null }) =>
        `${address ? `Die Absenderidentität ${address} fehlt oder ist` : "Die gewählte Absenderidentität fehlt oder ist"} nicht bestätigt. Wähle eine andere bestätigte Absenderidentität oder bitte die Postfach-Administration, sie unter Mail → Postfacheinstellungen → Konten und Identitäten → Absenderidentitäten einzurichten und zu bestätigen. Versuche es danach erneut.`,
      draftStorageFull:
        "Der Entwurfsspeicher von Mail ist voll. Sichere deinen ungesendeten Text und versuche es später erneut. Bleibt das Problem bestehen, bitte die Postfach-Administration, den Entwurfsspeicher zu prüfen.",
      invalidCapabilityInput: "Prüfe die Angaben für diese Mail-Aktion und versuche es erneut.",
    },
  },
});
