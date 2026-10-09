import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/**
 * SignatureInput's own strings. They live beside the component instead of in
 * the shared catalog, so applications that never render a signature field do
 * not ship them.
 */
const signatureMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      method: "Signature method",
      draw: "Draw",
      type: "Type",
      signHere: "Sign here",
      drawArea: "Signature area. Draw with a finger, pen, or mouse.",
      drawn: "Drawn signature",
      typeName: "Type your name",
      undo: "Undo",
    },
    de: {
      method: "Art der Unterschrift",
      draw: "Zeichnen",
      type: "Tippen",
      signHere: "Hier unterschreiben",
      drawArea: "Unterschriftsfeld. Zeichne mit Finger, Stift oder Maus.",
      drawn: "Gezeichnete Unterschrift",
      typeName: "Namen eintippen",
      undo: "Rückgängig",
    },
  },
});

export const useSignatureMessages = () => {
  const locale = useLocale();
  return () => signatureMessages.resolve([locale()]).t;
};

export const checkSignatureMessages = () => signatureMessages.check();
