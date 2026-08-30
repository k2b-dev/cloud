import { Button, NoticeCard, Paper, TextInput } from "@k2b/ui";
import { MinimalLayout, type MinimalLayoutProps } from "@valentinkolb/cloud/ssr";
import { publicAttachmentMessages } from "./public-attachment-messages";

type PublicAttachmentUnlockPageProps = {
  byteLength: number;
  c: MinimalLayoutProps["c"];
  error?: string;
  filename: string | null;
  locale: string;
};

const formatBytes = (value: number, locale: string): string => {
  if (value < 1024) return `${new Intl.NumberFormat(locale).format(value)} B`;
  if (value < 1024 * 1024) return `${new Intl.NumberFormat(locale).format(Math.ceil(value / 1024))} KB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / (1024 * 1024))} MB`;
};

export default function PublicAttachmentUnlockPage(props: PublicAttachmentUnlockPageProps) {
  const t = publicAttachmentMessages.resolve([props.locale]).t;

  return (
    <MinimalLayout c={props.c}>
      <main class="flex min-h-screen items-center justify-center bg-[var(--ui-canvas)] px-4 py-8 text-primary">
        <Paper as="section" elevated class="w-full max-w-md p-6" aria-labelledby="attachment-unlock-title">
          <header>
            <h1 id="attachment-unlock-title" class="break-words text-xl font-semibold">
              {props.filename || t.attachment}
            </h1>
            <p class="mt-2 text-sm text-dimmed">
              {props.byteLength > 0 ? `${formatBytes(props.byteLength, props.locale)} · ` : ""}
              {t.instructions}
            </p>
          </header>
          {props.error && <NoticeCard class="mt-4" tone="danger" title={props.error} />}
          <form method="post" class="mt-5 flex flex-col gap-3">
            <TextInput
              id="password"
              name="password"
              label={t.password}
              value=""
              password
              autocomplete="current-password"
              maxLength={256}
              required
              autofocus
            />
            <Button type="submit" class="w-full">
              <i class="ti ti-lock-open" aria-hidden="true" />
              {t.unlock}
            </Button>
          </form>
        </Paper>
      </main>
    </MinimalLayout>
  );
}
