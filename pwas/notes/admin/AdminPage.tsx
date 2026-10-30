import { Button, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { z } from "zod";
import { adminMessages } from "./messages";
import "./admin.css";

const reportSchema = z.object({
  id: z.string(),
  read_id: z.string(),
  reason: z.enum(["abuse", "illegal", "copyright", "privacy", "fraud"]),
  text: z.string(),
  email: z.string().nullable(),
  state: z.enum(["open", "decided"]),
  decision: z.enum(["keep", "block", "delete"]).nullable(),
  reason_text: z.string().nullable(),
  notification_state: z.enum(["none", "pending", "sent"]),
});
const listSchema = z.object({ reports: z.array(reportSchema), next: z.string().nullable() });
const statusSchema = z.object({
  usedBytes: z.number(),
  capacityBytes: z.number(),
  sharingPaused: z.boolean(),
  full: z.boolean(),
  maintenanceError: z.string().nullable(),
  owner: z.boolean(),
});
type Report = z.infer<typeof reportSchema>;

/** Mounted by the Notes SPA at /admin; inherits its locale and shared UI styling. */
export const AdminPage = () => {
  const locale = useLocale();
  const t = createMemo(() => adminMessages.resolve([locale()]).t);
  const [authenticated, setAuthenticated] = createSignal(false);
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(true);
  const [failed, setFailed] = createSignal<"failed" | "passwordWrong" | "loginLimited" | "session" | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [reports, setReports] = createSignal<Report[]>([]);
  const [status, setStatus] = createSignal<z.infer<typeof statusSchema>>();
  const [next, setNext] = createSignal<string | null>(null);
  const [reasons, setReasons] = createSignal<Record<string, string>>({});
  let csrf = "";
  const request = async <T,>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> => {
    const response = await fetch(`/api/admin/${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      ...(body !== undefined
        ? { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) }
        : {}),
    });
    if (!response.ok) {
      if (response.status === 401) setAuthenticated(false);
      throw new Error(
        response.status === 401
          ? path === "login"
            ? "passwordWrong"
            : "session"
          : response.status === 429 && path === "login"
            ? "loginLimited"
            : "failed",
      );
    }
    return schema.parse(response.status === 204 ? null : await response.json());
  };
  const loadReports = async (older = false) => {
    const [list, currentStatus] = await Promise.all([
      request(`reports${older && next() ? `?before=${encodeURIComponent(next()!)}` : ""}`, listSchema),
      request("status", statusSchema),
    ]);
    setReports(older ? [...reports(), ...list.reports] : list.reports);
    setNext(list.next);
    setStatus(currentStatus);
  };
  const load = async () => {
    const current = await request("session", z.object({ authenticated: z.boolean(), csrf: z.string() }));
    csrf = current.csrf;
    setAuthenticated(current.authenticated);
    if (current.authenticated) await loadReports();
    else {
      setReports([]);
      setStatus(undefined);
    }
  };
  const run = async (action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setFailed(null);
    try {
      await action();
    } catch (error) {
      const code = error instanceof Error ? error.message : "failed";
      setFailed(code === "passwordWrong" || code === "loginLimited" || code === "session" ? code : "failed");
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  };
  onMount(() => {
    setBusy(false);
    void run(load);
  });
  const login = () =>
    run(async () => {
      const challenge = await request("session", z.object({ authenticated: z.boolean(), csrf: z.string() }));
      csrf = challenge.csrf;
      const result = await request("login", z.object({ authenticated: z.literal(true), csrf: z.string() }), { password: password() });
      csrf = result.csrf;
      setPassword("");
      setAuthenticated(true);
      await loadReports();
    });
  const decision = (report: Report, action: "keep" | "block" | "delete") =>
    run(async () => {
      await request(`reports/${report.id}/decision`, z.object({ number: z.string(), state: z.literal("decided") }), {
        action,
        reason: reasons()[report.id] ?? "",
      });
      await loadReports();
    });
  const label = (action: Report["decision"]) => (action === "block" ? t().blocked : action === "delete" ? t().removed : t().kept);
  const mail = (report: Report) =>
    `mailto:${encodeURIComponent(report.email ?? "")}?subject=${encodeURIComponent(t().mailSubject({ number: report.id }))}&body=${encodeURIComponent(t().mailBody({ number: report.id, decision: label(report.decision), reason: report.reason_text ?? "" }))}`;
  return (
    <main class="notes-admin" data-print-region>
      <header class="notes-admin-heading">
        <h1>{t().title}</h1>
        <Show when={authenticated()}>
          <Button
            variant="ghost"
            disabled={busy()}
            onClick={() =>
              void run(async () => {
                await request("logout", z.null(), {});
                await load();
              })
            }
          >
            {t().logout}
          </Button>
        </Show>
      </header>
      <Show when={!loaded()}>
        <p role="status" style={{ "min-height": "2rem" }}>
          {t().loading}
        </p>
      </Show>
      <Show when={failed()}>
        <NoticeCard tone="danger" role="alert">
          <p>{t()[failed() ?? "failed"]}</p>
          <Button disabled={busy()} onClick={() => void run(load)}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={!authenticated() && loaded()}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <TextInput
            password
            label={t().password}
            autocomplete="current-password"
            required
            value={password()}
            onValueChange={setPassword}
            maxLength={1024}
          />
          <Button type="submit" variant="primary" loading={busy()} disabled={!password() || busy()}>
            {t().login}
          </Button>
        </form>
      </Show>
      <Show when={authenticated()}>
        <Show when={status()}>
          {(value) => (
            <section aria-label={t().storage}>
              <p>
                {t().storage}:{" "}
                {new Intl.NumberFormat(locale(), { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(
                  value().usedBytes / 1_000_000,
                )}{" "}
                /{" "}
                {new Intl.NumberFormat(locale(), { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(
                  value().capacityBytes / 1_000_000,
                )}
              </p>
              <Show when={value().sharingPaused}>
                <p role="status">{value().full ? t().full : t().paused}</p>
              </Show>
              <Show when={value().maintenanceError || !value().owner}>
                <p role="alert">{t().maintenance}</p>
              </Show>
            </section>
          )}
        </Show>
        <Button variant="secondary" disabled={busy()} onClick={() => void run(load)}>
          {t().refresh}
        </Button>
        <Show when={!reports().length && !busy()}>
          <p>{t().empty}</p>
        </Show>
        <For each={reports()}>
          {(report) => (
            <article class="notes-admin-report">
              <h2>
                {t().report} {report.id} · {report.state === "open" ? t().open : t().decided}
              </h2>
              <p>
                {t().reason}: {t()[report.reason]}
              </p>
              <p class="notes-admin-prose">{report.text}</p>
              <a href={`/p/${report.read_id}`} target="_blank" rel="noopener noreferrer">
                {t().view}
              </a>
              <Show
                when={report.state === "open"}
                fallback={
                  <p class="notes-admin-prose">
                    {label(report.decision)}: {report.reason_text}
                  </p>
                }
              >
                <TextInput
                  multiline
                  lines={4}
                  required
                  minLength={10}
                  maxLength={10000}
                  label={t().explanation}
                  value={reasons()[report.id] ?? ""}
                  onValueChange={(value) => setReasons({ ...reasons(), [report.id]: value })}
                />
                <p>{t().warning}</p>
                <div class="notes-admin-actions">
                  <For each={["keep", "block", "delete"] as const}>
                    {(action) => (
                      <Button
                        variant={action === "keep" ? "secondary" : action === "delete" ? "danger" : "warning"}
                        disabled={busy() || (reasons()[report.id]?.trim().length ?? 0) < 10}
                        onClick={() => void decision(report, action)}
                      >
                        {action === "block" ? t().block : action === "delete" ? t().remove : t().keep}
                      </Button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={report.notification_state === "pending" && report.email}>
                <section>
                  <p>{t().notification}</p>
                  <p>{t().mailHint}</p>
                  <a href={mail(report)}>{t().mail}</a>
                  <Button
                    variant="secondary"
                    disabled={busy()}
                    onClick={() =>
                      void run(async () => {
                        await request(`reports/${report.id}/notified`, z.null(), {});
                        await loadReports();
                      })
                    }
                  >
                    {t().sent}
                  </Button>
                </section>
              </Show>
              <Show when={report.notification_state === "sent"}>
                <p>{t().notified}</p>
              </Show>
            </article>
          )}
        </For>
        <Show when={next()}>
          <Button disabled={busy()} onClick={() => void run(() => loadReports(true))}>
            {t().more}
          </Button>
        </Show>
      </Show>
    </main>
  );
};
