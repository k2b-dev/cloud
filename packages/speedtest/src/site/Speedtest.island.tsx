import { Bar, Menu, Text, Workspace } from "@k2b/ui/v2";
import SpeedtestPane from "../ui/SpeedtestPane";
import { type SiteLocale, siteText } from "./text";

/** The public speed test: one v2 workspace without a sidebar; the head names the page and offers the other language. */
export default function PublicSpeedtest(props: { server: string; locale: SiteLocale }) {
  const text = () => siteText[props.locale];
  return (
    <Workspace
      head={
        <Bar
          start={<Text type="body">{text().title}</Text>}
          end={
            <Menu
              icon="language"
              label={text().language}
              items={[
                { label: "Deutsch", href: "/de", checked: props.locale === "de" },
                { label: "English", href: "/en", checked: props.locale === "en" },
              ]}
            />
          }
        />
      }
    >
      <SpeedtestPane
        server={props.server}
        initialCliVariant="node"
        label={text().title}
        intro={text().introduction}
        footer={
          <>
            <Text type="meta" muted>
              {text().limits}
            </Text>
            <Text type="meta" muted>
              {text().privacy}
            </Text>
            <Text type="meta" href="https://cloud.k2b.dev">
              {`${text().promotion} · ${text().promotionDetail}`}
            </Text>
          </>
        }
      />
    </Workspace>
  );
}
