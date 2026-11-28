import { LocaleProvider } from "@k2b/ui";
import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import AiStateScreen from "./AiStateScreen";
import BudgetsScreen from "./BudgetsScreen";
import ClassesScreen from "./ClassesScreen";
import PeopleScreen from "./PeopleScreen";
import ProjectsScreen from "./ProjectsScreen";
import ProvidersScreen from "./ProvidersScreen";
import SettingsScreen from "./SettingsScreen";
import SkillsScreen from "./SkillsScreen";
import UsageScreen from "./UsageScreen";

// A section of the AI area on v2: the screen mounts fresh in the page's main area with the props the server rendered.
const screens: Record<string, (text: string) => JSX.Element> = {
  classes: (text) => createComponent(ClassesScreen, JSON.parse(text)),
  providers: (text) => createComponent(ProvidersScreen, JSON.parse(text)),
  budgets: (text) => createComponent(BudgetsScreen, JSON.parse(text)),
  people: (text) => createComponent(PeopleScreen, JSON.parse(text)),
  settings: (text) => createComponent(SettingsScreen, JSON.parse(text)),
  skills: (text) => createComponent(SkillsScreen, JSON.parse(text)),
  projects: (text) => createComponent(ProjectsScreen, JSON.parse(text)),
  usage: (text) => createComponent(UsageScreen, JSON.parse(text)),
  state: (text) => createComponent(AiStateScreen, JSON.parse(text)),
};
const data = document.getElementById("screen-props")!;
const main = document.querySelector<HTMLElement>("main.k2-ui")!;
const screen = screens[data.dataset.screen ?? ""]!;
main.replaceChildren();
render(
  () =>
    createComponent(LocaleProvider, {
      locale: document.documentElement.lang,
      get children() {
        return screen(data.textContent ?? "{}");
      },
    }),
  main,
);
main.dataset.ready = "true";
