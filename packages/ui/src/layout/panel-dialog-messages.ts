import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const panelDialogMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      dialogTabs: "Dialog tabs",
    },
    de: {
      dialogTabs: "Dialog-Tabs",
    },
  },
});

export type PanelDialogMessages = ReturnType<(typeof panelDialogMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const usePanelDialogMessages = (): (() => PanelDialogMessages) => {
  const locale = useLocale();
  return () => panelDialogMessages.resolve([locale()]).t;
};

export const checkPanelDialogMessages = () => panelDialogMessages.check();
