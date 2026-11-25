import type { listLegalLinks } from "@k2b/cloud";
import { LOCALE_COOKIE } from "@k2b/cloud/shared";
import { cookies } from "@k2b/stdlib/browser";
import { useLocale } from "@k2b/ui";
import { Avatar, Bar, Inline, Menu, Pane, Text, Workspace } from "@k2b/ui/v2";
import { For, type JSX } from "solid-js";

export type LegalLinks = Awaited<ReturnType<typeof listLegalLinks>>;

/** The page's language as a choice in the head; a new language reloads the page in it. */
const LanguageMenu = () => {
  const locale = useLocale();
  const german = () => locale().toLowerCase().split("-")[0] === "de";
  const choose = (language: string) => {
    if ((language === "de") === german()) return;
    cookies.writeCookie(LOCALE_COOKIE, language);
    window.location.reload();
  };
  return (
    <Menu
      label={german() ? "Sprache" : "Language"}
      icon="language"
      variant="ghost"
      items={[
        {
          title: german() ? "Sprache" : "Language",
          choice: german() ? "de" : "en",
          onChoose: choose,
          items: [
            { label: "Deutsch", value: "de" },
            { label: "English", value: "en" },
          ],
        },
      ]}
    >
      {german() ? "Deutsch" : "English"}
    </Menu>
  );
};

/**
 * The frame of the sign-in pages on v2: the Cloud's logo and the page's title in the head, the language at its end,
 * one column with the page's content, and the legal links at its end. The page template sizes and centres it.
 */
export default function AuthFrame(props: {
  appName: string;
  title: string;
  legalLinks: LegalLinks;
  /** Views of the page, such as the account kinds of the sign-in, as the head of the column. */
  tabs?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <Workspace
      head={
        <Bar
          start={
            <Inline>
              <Avatar name={props.appName} image="/branding/logo" />
              <Text type="body" weight="strong">
                {props.title}
              </Text>
            </Inline>
          }
          end={<LanguageMenu />}
        />
      }
    >
      <Pane label={props.title} head={props.tabs}>
        {props.children}
        <Text type="meta" muted>
          <For each={props.legalLinks}>
            {(link, index) => (
              <>
                {index() > 0 ? " · " : ""}
                <Text href={link.href}>{link.label}</Text>
              </>
            )}
          </For>
        </Text>
      </Pane>
    </Workspace>
  );
}
