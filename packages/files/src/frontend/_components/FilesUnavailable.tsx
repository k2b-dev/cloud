import { ButtonLink, Placeholder, useLocale } from "@k2b/ui";
import { filesMessages } from "../messages";

type Props = {
  title: string;
  description: string;
  icon: string;
  actionHref?: string;
  actionLabel?: string;
};

/** Shared recovery state for unavailable file-storage routes. */
export default function FilesUnavailable(props: Props) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  return (
    <main class="mx-auto flex min-h-64 max-w-md items-center px-3">
      <Placeholder
        state="error"
        variant="panel"
        surface="paper"
        title={props.title}
        description={props.description}
        icon={props.icon}
        class="w-full"
        action={
          <ButtonLink href={props.actionHref ?? "/app/files"} variant="secondary" size="sm">
            {props.actionLabel ?? t().backToFiles}
          </ButtonLink>
        }
      />
    </main>
  );
}
