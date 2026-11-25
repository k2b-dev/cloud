import type { IslandErrorProps } from "@k2b/ssr";
import { useLocale } from "@k2b/ui";
import { Failed, Pane, Workspace } from "@k2b/ui/v2";
import { speedTestMessages } from "../ui/messages";

/** The page could not be drawn: the measurement's place says so and offers to draw it again. */
export default function IslandError(props: IslandErrorProps) {
  const locale = useLocale();
  const text = () => speedTestMessages.resolve([locale()]).t;
  return (
    <Workspace>
      <Pane label={text().measurement}>
        <Failed text={text().renderError} onRetry={() => props.reset()} />
      </Pane>
    </Workspace>
  );
}
