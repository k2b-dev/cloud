import { i18n } from "@k2b/stdlib";

export const appPwaMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: ({ name }: { name: string }) => `Install ${name}`,
      workerFailed: "Offline support is unavailable. You can continue online or try again.",
      retry: "Try again",
    },
    de: {
      title: ({ name }: { name: string }) => `${name} installieren`,
      workerFailed: "Die Offline-Unterstützung ist nicht verfügbar. Du kannst online fortfahren oder es erneut versuchen.",
      retry: "Erneut versuchen",
    },
  },
});
