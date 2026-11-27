import { Bar, Button, Canvas, Empty, Facts, Pane, RecordHead, Section, useLocale, Workspace } from "@k2b/ui/v2";
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

const FILE_ICONS: Record<string, string> = { PDF: "file-type-pdf", CSV: "file-type-csv", XML: "file-type-xml", ZIP: "file-zip" };

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
    // on the phone the download floats; from 768 px it stands at the end of the head
    <Workspace primary={available() ? { label: t().downloadFile, icon: "download", href: props.downloadHref } : undefined}>
      <Pane label={available() ? props.filename! : t().linkUnavailable}>
        {/* k2b-ui slots (#4278 measure, #4360 object head): until both land, the page stands in a centred reading
            column of 640 px, so a single file never sits alone at the left edge of a wide screen */}
        <Canvas label={available() ? props.filename! : t().linkUnavailable}>
          <div class="mx-auto w-full max-w-[640px] py-6">
            <Bar
              start={<RecordHead name={available() ? props.filename! : t().linkUnavailable} />}
              end={
                <Show when={available()}>
                  {/* a plain link: the answer is an attachment, so the browser saves it and the page stays (k2b-ui
                      slot: a download attribute on Button) */}
                  <span class="hidden md:inline-flex">
                    <Button variant="primary" icon="download" href={props.downloadHref}>
                      {t().downloadFile}
                    </Button>
                  </span>
                </Show>
              }
            />
            <Show when={available()} fallback={<Empty icon="link-off" text={t().documentLinkUnavailable} />}>
              {/* each fact once: the format is the section's sign; the file's whole name stands here, since the head
                  cuts it (until #4346 lets it take two lines); how long the link lasts is one line with its date */}
              <Section icon={FILE_ICONS[fileKind(props.mimeType) ?? ""] ?? "file"} title={t().sharedThroughGrids}>
                <Facts
                  items={[
                    { label: t().fileLabel, value: props.filename! },
                    {
                      label: t().availableUntilLabel,
                      value: `${props.expiresAtLabel} (${remainingTime(props.expiresAt ?? "", locale())})`,
                    },
                  ]}
                />
              </Section>
            </Show>
          </div>
        </Canvas>
      </Pane>
    </Workspace>
  );
}
