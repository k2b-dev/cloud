import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { HttpOptions, NotesBindings } from "./app";
import { NotesError } from "./errors";
import { boundedJson } from "./http";
import { limits } from "./limits";
import type { NotesService } from "./service";
import { costs, textBytes } from "./store";
import { hash, randomId, validId } from "./tokens";

type Ctx = Context<{ Bindings: NotesBindings }>;
const COOKIE = "__Host-notes-admin";
const PREAUTH = "__Host-notes-login";
const sessionMs = 12 * 3_600_000;
const cookieOptions = { secure: true, httpOnly: true, sameSite: "Strict", path: "/" } as const;
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const reportInput = z.strictObject({
  linkId: z.string().length(22),
  reason: z.enum(["abuse", "illegal", "copyright", "privacy", "fraud"]),
  text: z.string().trim().min(10).max(10_000),
  email: z.email().max(320).optional(),
  confirmed: z.literal(true),
});
const decisionInput = z.strictObject({ action: z.enum(["keep", "block", "delete"]), reason: z.string().trim().min(10).max(10_000) });
const numberId = z.string().regex(/^[1-9][0-9]{0,17}$/);
export type Report = {
  id: string;
  read_id: string;
  reason: string;
  text: string;
  email: string | null;
  state: "open" | "decided";
  decision: "keep" | "block" | "delete" | null;
  reason_text: string | null;
  notification_state: "none" | "pending" | "sent";
  created_at: Date;
  storage_bytes: string;
};

export const mountModeration = (
  app: Hono<{ Bindings: NotesBindings }>,
  service: NotesService,
  options: HttpOptions,
  ip: (c: Ctx) => string,
) => {
  const store = service.store;
  const db = store.db;
  const fingerprint = options.adminPasswordHash ? hash(options.adminPasswordHash) : "";
  const available = () => {
    if (!options.adminPasswordHash) throw new NotesError("not_found", 404);
  };
  const session = async (c: Ctx, mutation = false) => {
    available();
    const [id, csrf, extra] = (getCookie(c, COOKIE) ?? "").split(".");
    if (!id || !csrf || extra || !validId(id) || !validId(csrf)) throw new NotesError("unauthorized", 401);
    const [row] = await db<
      { csrf_hash: string }[]
    >`SELECT csrf_hash FROM admin_sessions WHERE id_hash=${hash(id)} AND expires_at>${new Date()} AND password_fingerprint=${fingerprint}`;
    if (!row || !equal(row.csrf_hash, hash(csrf))) throw new NotesError("unauthorized", 401);
    if (mutation && !equal(c.req.header("x-csrf-token") ?? "", csrf)) throw new NotesError("csrf_forbidden", 403);
    return { id, csrf };
  };
  app.post("/api/reports", async (c) => {
    service.rates.take("report", ip(c), limits.reportPerHour, 3_600_000);
    const input = reportInput.safeParse(await boundedJson(c.req.raw, 48_000));
    if (!input.success) throw new NotesError("invalid_report");
    const data = input.data;
    const access = await store.resolve(data.linkId);
    const id = await store.transaction(async (tx) => {
      const [pad] = await tx<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM pads WHERE read_id=${access.readId} FOR SHARE`;
      if (!pad || pad.deleted_at) throw new NotesError("deleted", 410);
      const bytes = costs.report + textBytes(data.reason) + textBytes(data.text) + textBytes(data.email ?? "");
      await store.reserve(tx, bytes);
      const [row] = await tx<
        { id: string }[]
      >`INSERT INTO reports(read_id,reason,text,email,storage_bytes) VALUES(${access.readId},${data.reason},${data.text},${data.email ?? null},${bytes}) RETURNING id::text`;
      return row!.id;
    });
    return c.json({ number: id }, 201);
  });
  app.get("/api/admin/session", async (c) => {
    available();
    if (getCookie(c, COOKIE)) {
      try {
        const current = await session(c);
        return c.json({ authenticated: true, csrf: current.csrf });
      } catch (error) {
        if (!(error instanceof NotesError) || error.status !== 401) throw error;
      }
    }
    const csrf = randomId();
    setCookie(c, PREAUTH, csrf, { ...cookieOptions, maxAge: 900 });
    return c.json({ authenticated: false, csrf });
  });
  app.post("/api/admin/login", async (c) => {
    available();
    const csrf = getCookie(c, PREAUTH) ?? "";
    if (!validId(csrf) || !equal(c.req.header("x-csrf-token") ?? "", csrf)) throw new NotesError("csrf_forbidden", 403);
    service.rates.take("admin_login", ip(c), limits.loginPerQuarterHour, 900_000);
    const input = z.strictObject({ password: z.string().min(1).max(1024) }).safeParse(await boundedJson(c.req.raw, 8192));
    if (!input.success || !(await Bun.password.verify(input.data.password, options.adminPasswordHash!)))
      throw new NotesError("unauthorized", 401);
    const id = randomId();
    const token = randomId();
    await store.transaction(async (tx) => {
      // A fresh login rotates an existing session instead of fixing its identifier.
      const previous = getCookie(c, COOKIE)?.split(".")[0];
      let released = 0;
      if (previous && validId(previous)) {
        const rows = await tx<
          { storage_bytes: string }[]
        >`DELETE FROM admin_sessions WHERE id_hash=${hash(previous)} RETURNING storage_bytes::text`;
        released = rows.reduce((sum, row) => sum + Number(row.storage_bytes), 0);
      }
      await store.reserve(tx, costs.session - released, "admin");
      await tx`INSERT INTO admin_sessions(id_hash,csrf_hash,expires_at,password_fingerprint,storage_bytes) VALUES(${hash(id)},${hash(token)},${new Date(Date.now() + sessionMs)},${fingerprint},${costs.session})`;
    });
    setCookie(c, COOKIE, `${id}.${token}`, { ...cookieOptions, maxAge: sessionMs / 1000 });
    deleteCookie(c, PREAUTH, cookieOptions);
    return c.json({ authenticated: true, csrf: token });
  });
  app.post("/api/admin/logout", async (c) => {
    const current = await session(c, true);
    await store.transaction(async (tx) => {
      const rows = await tx<
        { storage_bytes: string }[]
      >`DELETE FROM admin_sessions WHERE id_hash=${hash(current.id)} RETURNING storage_bytes::text`;
      await store.reserve(tx, -rows.reduce((sum, row) => sum + Number(row.storage_bytes), 0));
    });
    deleteCookie(c, COOKIE, cookieOptions);
    return c.body(null, 204);
  });
  app.get("/api/admin/reports", async (c) => {
    await session(c);
    const cursor = c.req.query("before");
    if (cursor && !numberId.safeParse(cursor).success) throw new NotesError("invalid_cursor");
    const rows = cursor
      ? await db<Report[]>`SELECT * FROM reports WHERE id<${cursor} ORDER BY id DESC LIMIT 50`
      : await db<Report[]>`SELECT * FROM reports ORDER BY id DESC LIMIT 50`;
    return c.json({
      reports: rows.map((row) => ({ ...row, id: String(row.id) })),
      next: rows.length === 50 ? String(rows.at(-1)!.id) : null,
    });
  });
  app.get("/api/admin/status", async (c) => {
    await session(c);
    return c.json({ ...(await store.status()), maintenanceError: service.maintenanceError, owner: await store.ownsDatabase() });
  });
  app.post("/api/admin/reports/:number/decision", async (c) => {
    await session(c, true);
    const id = numberId.safeParse(c.req.param("number"));
    const input = decisionInput.safeParse(await boundedJson(c.req.raw, 48_000));
    if (!id.success || !input.success) throw new NotesError("invalid_decision");
    const [report] = await db<{ read_id: string }[]>`SELECT read_id FROM reports WHERE id=${id.data}`;
    if (!report) throw new NotesError("not_found", 404);
    const data = input.data;
    await service.enqueue(report.read_id, async () => {
      let committed = false;
      try {
        await store.transaction(async (tx) => {
          const [row] = await tx<Report[]>`SELECT * FROM reports WHERE id=${id.data} FOR UPDATE`;
          if (!row) throw new NotesError("not_found", 404);
          if (row.state !== "open") {
            if (row.decision === data.action && row.reason_text === data.reason) return;
            throw new NotesError("already_decided", 409);
          }
          const [pad] = await tx<
            { size_bytes: string; status_reason: string | null }[]
          >`SELECT size_bytes::text,status_reason FROM pads WHERE read_id=${report.read_id} FOR UPDATE`;
          const reportDelta = textBytes(data.reason);
          const auditBytes = costs.decision + textBytes(data.reason);
          const tombstoneBytes = costs.tombstone + textBytes(pad!.status_reason ?? data.reason);
          const cleanupDelta = data.action === "keep" ? 0 : tombstoneBytes - Number(pad!.size_bytes);
          await store.reserve(tx, reportDelta + auditBytes + cleanupDelta, "admin");
          await tx`UPDATE reports SET state='decided',decision=${data.action},reason_text=${data.reason},decided_at=${new Date()},storage_bytes=storage_bytes+${reportDelta},notification_state=CASE WHEN email IS NULL THEN 'none' ELSE 'pending' END WHERE id=${id.data}`;
          await tx`INSERT INTO moderation_log(read_id,report_id,action,reason,storage_bytes) VALUES(${report.read_id},${id.data},${data.action},${data.reason},${auditBytes})`;
          if (data.action !== "keep") {
            await tx`UPDATE pads SET blocked_at=CASE WHEN ${data.action}='block' THEN COALESCE(blocked_at,${new Date()}) ELSE blocked_at END,deleted_at=CASE WHEN ${data.action}='delete' THEN COALESCE(deleted_at,${new Date()}) ELSE deleted_at END,status_reason=COALESCE(status_reason,${data.reason}),snapshot=''::bytea,content_md='',size_bytes=${tombstoneBytes} WHERE read_id=${report.read_id}`;
            await tx`DELETE FROM pad_updates WHERE read_id=${report.read_id}`;
            await tx`DELETE FROM pad_files WHERE read_id=${report.read_id}`;
            await tx`DELETE FROM pad_previews WHERE read_id=${report.read_id}`;
          }
        });
        committed = true;
      } finally {
        if (data.action !== "keep")
          service.invalidate(report.read_id, committed ? (data.action === "block" ? "blocked" : "deleted") : "resync_required");
      }
    });
    return c.json({ number: id.data, state: "decided" });
  });
  app.post("/api/admin/reports/:number/notified", async (c) => {
    await session(c, true);
    const id = numberId.safeParse(c.req.param("number"));
    if (!id.success) throw new NotesError("invalid_report");
    const rows = await store.transaction(
      (tx) =>
        tx`UPDATE reports SET notification_state='sent',notification_sent_at=${new Date()} WHERE id=${id.data} AND state='decided' AND notification_state IN ('pending','sent') RETURNING id`,
    );
    if (!rows.length) throw new NotesError("not_found", 404);
    return c.body(null, 204);
  });
};
