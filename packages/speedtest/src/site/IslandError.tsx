import type { IslandErrorProps } from "@k2b/ssr";
import { Button, Placeholder, useLocale } from "@k2b/ui";
import { speedTestMessages } from "../ui/messages";

export default function IslandError(props: IslandErrorProps) {
  const locale = useLocale();
  const text = () => speedTestMessages.resolve([locale()]).t;
  return (
    <Placeholder
      state="error"
      title={text().renderError}
      action={
        <Button variant="secondary" onClick={() => props.reset()}>
          {text().retry}
        </Button>
      }
    />
  );
}
