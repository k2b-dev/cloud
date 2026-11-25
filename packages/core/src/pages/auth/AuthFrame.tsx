import type { listLegalLinks } from "@k2b/cloud";
import { cookies } from "@k2b/stdlib/browser";
import { useLocale } from "@k2b/ui";
import { Avatar, Bar, Inline, Menu, Pane, Text, Workspace } from "@k2b/ui/v2";
import { For, type JSX } from "solid-js";
import { authMessages } from "./messages";

export type LegalLinks = Awaited<ReturnType<typeof listLegalLinks>>;

/** The sign-in pages' messages in the page's locale. */
export const useAuthMessages = () => {
  const locale = useLocale();
  return () => authMessages.resolve([locale()]).t;
};

/** The page's language as a choice in the head; a new language reloads the page in it. */
const LanguageMenu = (props: { cookie: string }) => {
  const locale = useLocale();
  const german = () => locale().toLowerCase().split("-")[0] === "de";
  const choose = (language: string) => {
    if ((language === "de") === german()) return;
    cookies.writeCookie(props.cookie, language);
    window.location.reload();
  };
  return (
    // Without words the menu stays in the head on the phone too, where the head's other deeds give way.
    <Menu
      label={german() ? "Sprache: Deutsch" : "Language: English"}
      icon="language"
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
    />
  );
};

/**
 * The frame of the sign-in pages on v2: the Cloud's logo and the page's title in the head, the language at its end,
 * one column with the page's content, and the legal links at its end. The page template sizes and centres it.
 */
export default function AuthFrame(props: {
  appName: string;
  title: string;
  /** The name of the language cookie (`LOCALE_COOKIE`), from the server, so the island needs no platform barrel. */
  localeCookie: string;
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
          end={<LanguageMenu cookie={props.localeCookie} />}
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
