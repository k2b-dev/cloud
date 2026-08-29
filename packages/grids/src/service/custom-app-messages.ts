import { i18n } from "@k2b/stdlib";

export const customAppServiceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      customAppNotFound: "Grids App not found.",
      baseNotFound: "Base not found.",
      home: "Home",
      invalidDefinition: "The Grids App definition is invalid.",
      identityImmutable: "The Grids App identity cannot be changed.",
      noLiveVersion: "The Grids App has no published version.",
      invalidLiveVersion: "The published Grids App definition is invalid.",
      createFailed: "The Grids App could not be created.",
      invalidDraft: "The Grids App draft is invalid.",
    },
    de: {
      customAppNotFound: "Die Grids-App wurde nicht gefunden.",
      baseNotFound: "Die Base wurde nicht gefunden.",
      home: "Start",
      invalidDefinition: "Die Definition der Grids-App ist ungültig.",
      identityImmutable: "Die Identität der Grids-App kann nicht geändert werden.",
      noLiveVersion: "Die Grids-App hat keine veröffentlichte Version.",
      invalidLiveVersion: "Die Definition der veröffentlichten Grids-App ist ungültig.",
      createFailed: "Die Grids-App konnte nicht erstellt werden.",
      invalidDraft: "Der Entwurf der Grids-App ist ungültig.",
    },
  },
});

export const customAppMessagesFor = (locale?: string) => customAppServiceMessages.resolve(locale ? [locale] : []).t;
