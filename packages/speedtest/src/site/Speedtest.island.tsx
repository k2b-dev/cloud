import { Bar, Button, Text, Workspace } from "@k2b/ui/v2";
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
            <Button keep variant="ghost" icon="language" href={props.locale === "de" ? "/en" : "/de"} title={text().language}>
              {props.locale === "de" ? "English" : "Deutsch"}
            </Button>
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
