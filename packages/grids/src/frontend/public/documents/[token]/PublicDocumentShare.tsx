import { useLocale } from "@k2b/ui";
import { Bar, Button, Empty, Facts, Pane, RecordHead, Section, Workspace } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import { resolveGridsMessages } from "../../../messages";

const remainingTime = (expiresAt: string, locale: string, now = Date.now()): string => {
  const { t } = resolveGridsMessages(locale);
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - now);
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return minutes <= 1 ? t.lessThanMinute : t.minutes({ count: minutes });
  const hours = Math.ceil(remainingMs / 3_600_000);
  if (hours < 48) return t.hours({ count: hours });
  const days = Math.ceil(remainingMs / 86_400_000);
  return t.days({ count: days });
};

/** The kind of a shared file in two to four letters, for its mark. */
const fileKind = (mimeType: string | undefined): string | undefined =>
  ({ "application/pdf": "PDF", "text/csv": "CSV", "application/xml": "XML", "application/zip": "ZIP" })[mimeType ?? ""];

/**
 * A document someone shared by link, for a visitor without an account (recipe `public-page`): the file's name in the
 * head with its one task, downloading; under it what the file is and how long the link lasts. A link that expired or
 * was revoked says so in one sentence, without a download.
 */
export function PublicDocumentShare(props: {
  filename?: string;
  mimeType?: string;
  expiresAt?: string;
  expiresAtLabel?: string;
  downloadHref?: string;
}): JSX.Element {
  const locale = useLocale();
  const t = () => resolveGridsMessages(locale()).t;
  const available = () => Boolean(props.filename && props.expiresAt && props.expiresAtLabel && props.downloadHref);

  return (
    <Workspace
      head={
        <Bar
          start={<RecordHead name={available() ? props.filename! : t().linkUnavailable} />}
          end={
            <Show when={available()}>
              {/* a plain link: the answer is an attachment, so the browser saves it and the page stays */}
              <Button variant="primary" icon="download" href={props.downloadHref} keep>
                {t().downloadFile}
              </Button>
            </Show>
          }
        />
      }
    >
      <Pane label={available() ? props.filename! : t().linkUnavailable}>
        <Show when={available()} fallback={<Empty icon="link-off" text={t().documentLinkUnavailable} />}>
          <Section icon={fileKind(props.mimeType) === "PDF" ? "file-type-pdf" : "file"} title={t().sharedThroughGrids}>
            <Facts
              items={[
                ...(fileKind(props.mimeType) ? [{ label: t().fileFormat, value: fileKind(props.mimeType)! }] : []),
                { label: t().linkExpiresLabel, value: remainingTime(props.expiresAt!, locale()) },
                { label: t().availableUntilLabel, value: props.expiresAtLabel! },
              ]}
            />
          </Section>
        </Show>
      </Pane>
    </Workspace>
  );
}
