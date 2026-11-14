import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import {
  type CodeEventCatchupInput,
  CodeEventCatchupInputSchema,
  CodeEventCatchupStatusSchema,
  CodeTestMockSchema,
  CodeTestResultSchema,
} from "@k2b/cloud/code/events";
import { Button, DatePicker, NoticeCard, ProgressBar, Select, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { MailCodePreviewSchema, MailCodeSelectionSchema } from "../mail-code-contracts";
import { mailCodeMessages } from "./mail-code-messages";

type Selection = z.infer<typeof MailCodeSelectionSchema>;
type Progress = z.infer<typeof CodeEventCatchupStatusSchema>;
/** Mail composes its selection controls with Core's public event tools; production execution stays in Core. */
export default function MailCodeTools(props: {
  mailboxId: string;
  codeId: string;
  versionId: string;
  folders: { id: string; name: string }[];
}) {
  const locale = useLocale();
  const t = () => mailCodeMessages.resolve([locale()]).t;
  const [folder, setFolder] = createSignal<string | null>(null);
  const [from, setFrom] = createSignal<string | null>(null),
    [to, setTo] = createSignal<string | null>(null);
  const [selection, setSelection] = createSignal<Selection | null>(null);
  const [message, setMessage] = createSignal<string | null>(null);
  const [mocks, setMocks] = createSignal("[]");
  const [preview, setPreview] = createSignal<z.infer<typeof CodeTestResultSchema> | null>(null);
  const [progress, setProgress] = createSignal<Progress | null>(null);
  const [operationId, setOperationId] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<CodeEventCatchupInput | null>(null);
  const [pendingResume, setPendingResume] = createSignal<{ operationId: string; newOperationId: string } | null>(null);
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal<string | null>(null);
  const storageKey = () => `mail.code.catchup:${props.codeId}`;
  const remember = () => {
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify({ operationId: operationId(), pending: pending(), resume: pendingResume() }));
    } catch {
      /* The current page still retains its receipt. */
    }
  };
  const target = () => ({ type: "core.code", id: props.codeId });
  const active = () => progress() && ["queued", "running", "waiting"].includes(progress()!.status);
  const run = async (action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().failed);
    } finally {
      setBusy(false);
    }
  };
  const core = async (capabilityId: string, kind: "query" | "action", input: object, key?: string) => {
    const result = await invokeCapabilityWithDataSchema(
      { appId: "core", capabilityId, kind, target: target(), input, ...(key ? { idempotencyKey: key } : {}) },
      CodeEventCatchupStatusSchema,
    );
    if (!result.ok) {
      if (kind === "action" && [400, 403, 404, 409, 413, 422].includes(result.error.status)) {
        setPending(null);
        setPendingResume(null);
        if (capabilityId !== "code.event.catchup.cancel") {
          setOperationId(null);
          setProgress(null);
        }
        remember();
      }
      throw new Error(result.error.message);
    }
    setProgress(result.data.data);
    setOperationId(result.data.data.operationId);
    setPending(null);
    setPendingResume(null);
    remember();
  };
  const refresh = () => (operationId() ? core("code.event.catchup.read", "query", { operationId: operationId() }) : Promise.resolve());
  const poll = async () => {
    try {
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().failed);
    }
  };
  onMount(() => {
    try {
      const saved = z
        .object({
          operationId: z.uuid().nullable(),
          pending: CodeEventCatchupInputSchema.nullable(),
          resume: z.object({ operationId: z.uuid(), newOperationId: z.uuid() }).nullable().default(null),
        })
        .parse(JSON.parse(sessionStorage.getItem(storageKey()) ?? "null"));
      setOperationId(saved.operationId);
      setPending(saved.pending);
      setPendingResume(saved.resume);
      if (saved.operationId) void run(refresh);
    } catch {
      /* No saved operation. */
    }
  });
  onMount(() => {
    const timer = setInterval(() => {
      if (active() && !busy()) void poll();
    }, 3_000);
    onCleanup(() => clearInterval(timer));
  });
  const stateLabels = () => ({
    queued: t().queued,
    running: t().running,
    waiting: t().waiting,
    completed: t().completed,
    failed: t().failedState,
    canceled: t().canceled,
  });
  const select = async (next = false) => {
    const previous = next ? selection() : null;
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "mail",
        capabilityId: "message.catchup",
        kind: "query",
        target: { type: "mail.mailbox", id: props.mailboxId },
        input: {
          ...(folder() ? { folderId: folder() } : {}),
          ...(from() ? { from: `${from()}T00:00:00.000Z` } : {}),
          ...(to() ? { to: `${to()}T00:00:00.000Z` } : {}),
          ...(previous?.nextCursor ? { cutoffAt: previous.cutoffAt, cursor: previous.nextCursor } : {}),
        },
      },
      MailCodeSelectionSchema,
    );
    if (!result.ok) throw new Error(result.error.message);
    setSelection(result.data.data);
    setMessage(result.data.data.items[0]?.event.subject.id ?? null);
    setPreview(null);
  };
  const start = async () => {
    const request = pending() ?? {
      operationId: crypto.randomUUID(),
      versionId: props.versionId,
      events: selection()!.items.map((item) => item.event),
    };
    setOperationId(request.operationId);
    setPending(request);
    remember();
    await core("code.event.catchup", "action", request, request.operationId);
  };
  const simulate = async () => {
    setPreview(null);
    const extra = z.array(CodeTestMockSchema).max(99).parse(JSON.parse(mocks()));
    const fixture = await invokeCapabilityWithDataSchema(
      {
        appId: "mail",
        capabilityId: "message.event-preview",
        kind: "query",
        target: { type: "mail.mailbox", id: props.mailboxId },
        input: { messageId: message() },
      },
      MailCodePreviewSchema,
    );
    if (!fixture.ok) throw new Error(fixture.error.message);
    const response = await fetch("/api/code/authoring/simulateEvent", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        codeId: props.codeId,
        versionId: props.versionId,
        event: fixture.data.data.event,
        mocks: [fixture.data.data.mock, ...extra],
      }),
    });
    if (!response.ok) throw new Error(t().failed);
    const body: unknown = await response.json();
    setPreview(CodeTestResultSchema.parse(body));
  };
  const invalidate = () => {
    setSelection(null);
    setMessage(null);
    setPreview(null);
    setPending(null);
    setPendingResume(null);
    remember();
  };
  return (
    <section class="mt-6 space-y-4 border-t border-border pt-6" aria-label={t().title}>
      <h2 class="text-lg font-semibold">{t().title}</h2>
      <p class="text-muted">{t().description}</p>
      <div class="grid gap-3 sm:grid-cols-3">
        <Select
          label={t().folder}
          value={folder}
          onValueChange={(value) => {
            setFolder(value);
            invalidate();
          }}
          options={props.folders.map((item) => ({ id: item.id, label: item.name }))}
          placeholder={t().allFolders}
          clearable
          disabled={busy()}
        />
        <DatePicker
          label={t().from}
          value={from}
          onValueChange={(value) => {
            setFrom(value);
            invalidate();
          }}
          clearable
          disabled={busy()}
        />
        <DatePicker
          label={t().to}
          value={to}
          onValueChange={(value) => {
            setTo(value);
            invalidate();
          }}
          clearable
          disabled={busy()}
        />
      </div>
      <div class="flex flex-wrap gap-2">
        <Button variant="secondary" loading={busy()} onClick={() => void run(() => select())}>
          {t().select}
        </Button>
        <Show when={selection()?.nextCursor}>
          <Button variant="secondary" disabled={busy()} onClick={() => void run(() => select(true))}>
            {t().next}
          </Button>
        </Show>
      </div>
      <Show when={error()}>
        <div role="alert">
          <NoticeCard tone="danger" title={error()!} />
        </div>
      </Show>
      <Show when={selection()} fallback={<p class="text-sm text-muted">{t().noSelection}</p>}>
        {(page) => (
          <>
            <p>{page().items.length ? t().selected({ count: page().items.length }) : t().empty}</p>
            <Show when={page().items.length}>
              <Select
                label={t().message}
                value={message}
                onValueChange={(value) => {
                  setMessage(value);
                  setPreview(null);
                }}
                options={page().items.map((item) => ({ id: item.event.subject.id, label: item.title || item.event.subject.id }))}
              />
              <TextInput label={t().mocks} value={mocks} onValueChange={setMocks} multiline monospace lines={3} />
              <p class="text-sm text-muted">{t().dryRun}</p>
              <Button variant="secondary" disabled={busy() || !message()} onClick={() => void run(simulate)}>
                {t().preview}
              </Button>
              <p class="text-sm text-muted">{t().catchupHint}</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={(selection()?.items.length || pending()) && !active() && !pendingResume()}>
        <Button disabled={busy()} onClick={() => void run(start)}>
          {t().catchup}
        </Button>
      </Show>
      <Show when={preview()}>
        {(result) => (
          <div class="space-y-2" aria-live="polite">
            <h3 class="font-semibold">{t().calls}</h3>
            <Show when={!result().ok}>
              <p>
                {t().previewFailed} {result().error}
              </p>
            </Show>
            <For each={result().cases.flatMap((item) => item.runs.flatMap((run) => run.calls))}>
              {(call) => <pre class="overflow-auto whitespace-pre-wrap text-sm">{JSON.stringify(call, null, 2)}</pre>}
            </For>
            <For
              each={result()
                .cases.flatMap((item) => item.runs)
                .filter((run) => run.error)}
            >
              {(run) => <p>{run.error}</p>}
            </For>
            <For each={result().diagnostics}>{(diagnostic) => <p>{diagnostic.message}</p>}</For>
          </div>
        )}
      </Show>
      <Show when={operationId()}>
        <div class="space-y-3" aria-live="polite">
          <h3 class="font-semibold">{t().state}</h3>
          <Show when={progress()}>
            {(state) => (
              <>
                <p>{stateLabels()[state().status]}</p>
                <p>
                  {t().version}: <code>{state().versionId}</code>
                </p>
                <p>{t().progress({ done: state().dispatched, total: state().total })}</p>
                <ProgressBar segments={[{ value: state().dispatched }]} limit={state().total} label={t().state} />
                <Show when={state().lastError}>
                  <p role="alert">{state().lastError}</p>
                </Show>
              </>
            )}
          </Show>
          <p class="text-sm text-muted">{t().cancelHint}</p>
          <div class="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy()} onClick={() => void run(refresh)}>
              {t().refresh}
            </Button>
            <Show when={active()}>
              <Button
                variant="secondary"
                disabled={busy()}
                onClick={() =>
                  void run(() => core("code.event.catchup.cancel", "action", { operationId: operationId() }, `cancel:${operationId()}`))
                }
              >
                {t().cancel}
              </Button>
            </Show>
            <Show when={progress()?.status === "failed" || progress()?.status === "canceled" || pendingResume()}>
              <Button
                variant="secondary"
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    const request = pendingResume() ?? { operationId: operationId()!, newOperationId: crypto.randomUUID() };
                    setPendingResume(request);
                    setOperationId(request.newOperationId);
                    setProgress(null);
                    remember();
                    await core("code.event.catchup.resume", "action", request, request.newOperationId);
                  })
                }
              >
                {t().resume}
              </Button>
            </Show>
          </div>
        </div>
      </Show>
    </section>
  );
}
