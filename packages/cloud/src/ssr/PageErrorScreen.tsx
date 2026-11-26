import { Button, ErrorScreen, Pane, Workspace } from "@k2b/ui/v2";
import type { JSX } from "solid-js";
import ErrorPageSearch from "./ErrorPageSearch.island";

export type PageErrorScreenProps = {
  status: number;
  title: string;
  description: string;
  /** The page's way out, home by default. */
  action: { label: string; href: string; icon?: string };
  /** The address that failed, so "Erneut versuchen" loads it again without a script. */
  retryHref: string;
  labels: { retry: string; search: string };
  /** The waiting game's invitation, where a generic page offers it. */
  game?: JSX.Element;
};

/**
 * An error page on UI v2 in the Cloud shell (approved direction A "Zeichen"): the code large, the title, one sentence
 * and two ways out, in the middle of the page, without a head of its own. A failure of the server offers to load the
 * same address again first and home second; a missing or closed page offers its way out first and the search second.
 */
export default function PageErrorScreen(props: PageErrorScreenProps) {
  const failure = () => props.status >= 500;
  const way = (variant: "primary" | "secondary") => (
    <Button variant={variant} icon={props.action.icon ?? "home"} href={props.action.href}>
      {props.action.label}
    </Button>
  );
  return (
    <Workspace>
      {/* named by its status, so a page's own title never stands in an attribute */}
      <Pane label={String(props.status)}>
        <ErrorScreen
          code={String(props.status)}
          title={props.title}
          text={props.description}
          actions={
            failure() ? (
              <>
                <Button variant="primary" icon="refresh" href={props.retryHref}>
                  {props.labels.retry}
                </Button>
                {way("secondary")}
              </>
            ) : (
              <>
                {way("primary")}
                <ErrorPageSearch label={props.labels.search} />
              </>
            )
          }
          foot={props.game}
        />
      </Pane>
    </Workspace>
  );
}
