import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const qrMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      qrCameraPreview: "Camera preview for scanning a QR code",
      qrCameraStarting: "Starting camera…",
      qrCameraInstructions: "Point the camera at a QR code.",
      qrCameraPrivacy: "Camera images stay on this device.",
    },
    de: {
      qrCameraPreview: "Kameravorschau zum Scannen eines QR-Codes",
      qrCameraStarting: "Kamera wird gestartet…",
      qrCameraInstructions: "Richte die Kamera auf einen QR-Code.",
      qrCameraPrivacy: "Kamerabilder bleiben auf diesem Gerät.",
    },
  },
});

export type QrMessages = ReturnType<(typeof qrMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useQrMessages = (): (() => QrMessages) => {
  const locale = useLocale();
  return () => qrMessages.resolve([locale()]).t;
};

export const checkQrMessages = () => qrMessages.check();
