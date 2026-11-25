import { cloudAvatarImage } from "@k2b/cloud/account/ui";
import { LocaleProvider } from "@k2b/ui";
import { Bar, Button, RecordHead } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import { useAccountsMessages } from "../messages";
import { useAgentPictureChange } from "./agent-picture";

/** The head of an agent's page for a browser test, which answers the administration API itself. */
const AGENT = { id: "0b2f5c7e-0000-4000-8000-0000000000bb", name: "Festplaner" };

function Head() {
  const messages = useAccountsMessages();
  const change = useAgentPictureChange(() => AGENT);
  return (
    <Bar
      start={
        <RecordHead
          name={AGENT.name}
          avatar={{ name: AGENT.name, image: cloudAvatarImage({ kind: "service_account", userId: AGENT.id }) }}
          kinds={["Agent"]}
        />
      }
      end={
        <Button icon="photo" onClick={() => void change()}>
          {messages().agentChangePicture}
        </Button>
      }
    />
  );
}

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <Head />
    </LocaleProvider>
  ),
  host,
);
