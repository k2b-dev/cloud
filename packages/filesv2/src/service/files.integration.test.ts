import { beforeAll, beforeEach, expect, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import type { RequestActor } from "@k2b/cloud/server";
import { accountIdentities, secrets } from "@k2b/cloud/services";
import { type ExecutionIdentity, Filegate, type Node, type WriteOptions } from "@k2b/filegate";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { assertPrivateDatabase } from "../../test/private-database";
import { bindings } from "../data/bases";
import { resolveEntryRefId } from "../data/references";
import type { DocumentFormat } from "../documents";
import { migrate } from "../migrate";
import { entryRefId } from "../resource-ref";
import { createFilesService } from ".";
import { createTemplateService } from "./templates";

const suite = suiteFor("database");
suite("Files service and durable bindings", () => {
  const nodes = new Map<string, Node>();
  const defaults = new Map<string, unknown>();
  let lostMoveResponse = false;
  let failMove = false;
  let leases = 0;
  let sessionCounter = 0;
  let versionCounter = 0;
  let nodeRevisionCounter = 0;
  let directCounter = 0;
  let afterSegment: (() => void) | undefined;
  let afterSessionRead: (() => void) | undefined;
  let beforeDirectPublish: (() => void) | undefined;
  const directRequests: Array<{ root: string; path: string; precondition?: { ifMatch?: string; ifNoneMatch?: boolean } }> = [];
  let ipaIndexed = false;
  const executions: Array<{ source: unknown; target: unknown; operation: string }> = [];
  const versions = new Map<
    string,
    Array<{
      id: string;
      fileId: string;
      created: string;
      size: number;
      pinned: boolean;
      metadata?: Record<string, unknown>;
      copyMode: string;
      content: string;
    }>
  >();
  const archives: Array<Array<{ root: string; path: string; archivePath: string }>> = [];
  let lostCommitResponse = false;
  const sessionKeys = new Map<string, string>();
  let lostCreateResponse = false;
  const sessions = new Map<
    string,
    {
      id: string;
      root: string;
      path: string;
      size: number;
      received: number;
      state: string;
      options: WriteOptions;
      execution?: ExecutionIdentity;
      ownership?: unknown;
      onConflict?: string;
      result?: Node;
    }
  >();
  const privateSession = (id: string) => sessions.get(sessionKeys.get(id)!)!;
  let reconciliations = 0;
  const scopedMetadata: Array<{ operation: string; path: string }> = [];
  let config = {
    url: "http://filegate:4000",
    token: "backend-test-secret",
    tokenConfigured: true,
    cloud: {
      autoCreate: false,
      autoArchive: true,
      enabled: true,
      root: "cloud",
      prefix: "",
      homes: "users",
      groups: "groups",
      archive: "archive",
    },
    freeipa: { enabled: true, root: "freeipa", prefix: "", homes: "users", groups: "groups", archive: "archive" },
    collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as DocumentFormat },
  };
  const set = async (key: string, value: unknown) => {
    const encrypted = await secrets.encrypt(value);
    await sql`INSERT INTO settings.entries(key,value) VALUES(${key},${encrypted}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  };
  const directory = (root: string, path: string, uid = 1001, gid = 2001, mode = "0770", directory = true) => {
    const revision = ++nodeRevisionCounter;
    const node = {
      root,
      path,
      uid,
      gid,
      mode,
      directory,
      size: directory ? 0 : 12,
      modified: new Date(Date.now() + revision).toISOString(),
      ...(root === "cloud" && !directory ? { revision: `revision-${revision}` } : {}),
    };
    nodes.set(`${root}:${path}`, node);
    return node;
  };
  const directUploads = new Map<
    string,
    {
      root: string;
      path: string;
      size: number;
      ownership: { uid?: number; gid?: number; mode?: string };
      onConflict?: string;
      precondition?: { ifMatch?: string; ifNoneMatch?: boolean };
    }
  >();
  const contents = new Map<string, string>();
  const DISCOVERY = `<wopi-discovery><net-zone name="external-http"><app name="writer"><action default="true" ext="odt" name="edit" urlsrc="http://collabora:9980/browser/abc/cool.html?"/><action ext="odt" name="view" urlsrc="http://collabora:9980/browser/abc/cool.html?"/></app></net-zone></wopi-discovery>`;
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const req = new URL(input instanceof Request ? input.url : input.toString());
      const parts = req.pathname.split("/");
      const executionHeader = new Headers(init?.headers).get("X-Filegate-Execution");
      const execution = executionHeader
        ? z.object({ uid: z.number(), gid: z.number(), groups: z.array(z.number()).optional() }).parse(JSON.parse(executionHeader))
        : null;
      const allowed = (node: Node, rights: number) => {
        if (!execution) return true;
        const mode = Number.parseInt(node.mode, 8);
        const bits =
          node.uid === execution.uid ? mode >> 6 : node.gid === execution.gid || execution.groups?.includes(node.gid) ? mode >> 3 : mode;
        return (bits & rights) === rights;
      };
      const readableTree = (root: string, path: string) => {
        for (const node of nodes.values())
          if (
            node.root === root &&
            (node.path === path || node.path.startsWith(`${path}/`) || path.startsWith(`${node.path}/`) || node.path === ".")
          ) {
            const ancestor = node.path === "." || path.startsWith(`${node.path}/`);
            if (!allowed(node, ancestor ? 1 : node.directory ? 5 : 4)) return false;
          }
        return true;
      };
      // Direct leases: bytes bypass the API and land on the storage node itself.
      if (req.pathname === "/hosting/discovery") return new Response(DISCOVERY);
      if (parts[1] === "v1" && parts[2] === "direct" && /\.(test|renewed)$/.test(parts[3] ?? "") && init?.method === "PUT") {
        const session = sessions.get(parts[3]!.split(".")[0]!);
        if (!session) return Response.json({ error: "not_found" }, { status: 404 });
        init.signal?.throwIfAborted();
        const bytes = await new Response(init.body).arrayBuffer();
        session.received += bytes.byteLength;
        afterSegment?.();
        return Response.json({ ...session, chunkSize: 4, expires: "2099-01-01T00:00:00Z", uploadedSegments: 1 });
      }
      if (parts[1] === "signed") {
        const key = `${parts[2]}:${decodeURIComponent(parts.slice(3).join("/"))}`;
        return nodes.has(key) ? new Response(contents.get(key) ?? "") : new Response("", { status: 404 });
      }
      if (parts[1] === "v1" && parts[2] === "direct") {
        const leaseId = parts[3]?.split(".")[0] ?? "";
        const pending = directUploads.get(leaseId);
        if (!pending || init?.method !== "PUT") return Response.json({ error: "not_found" }, { status: 404 });
        const key = `${pending.root}:${pending.path}`;
        expect(new Headers(init.headers).has("Authorization")).toBeFalse();
        expect(new Headers(init.headers).has("X-Filegate-Execution")).toBeFalse();
        expect(init.credentials).toBe("omit");
        expect(req.origin).toBe(config.url);
        const bytes = await new Response(init.body as BodyInit).arrayBuffer();
        if (bytes.byteLength !== pending.size) return Response.json({ error: "invalid_size", message: "size mismatch" }, { status: 400 });
        const body = new TextDecoder().decode(bytes);
        const beforePublish = beforeDirectPublish;
        beforeDirectPublish = undefined;
        beforePublish?.();
        const existing = nodes.get(key);
        if (
          (pending.precondition?.ifNoneMatch && existing) ||
          (pending.precondition?.ifMatch && existing?.revision !== pending.precondition.ifMatch)
        )
          return Response.json({ error: "precondition_failed", message: "changed" }, { status: 412 });
        if (existing && (existing.directory || pending.onConflict === "error"))
          return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
        const node = {
          ...directory(
            pending.root,
            pending.path,
            pending.ownership.uid ?? existing?.uid ?? 0,
            pending.ownership.gid ?? existing?.gid ?? 0,
            pending.ownership.mode ?? existing?.mode ?? "0644",
            false,
          ),
          size: bytes.byteLength,
          modified: new Date(Date.now() + ++versionCounter * 1000).toISOString(),
        };
        nodes.set(key, node);
        contents.set(key, body);
        directUploads.delete(leaseId);
        return Response.json(node);
      }
      if (req.pathname === "/v1/downloads/archives") {
        const input = z
          .object({ items: z.array(z.object({ root: z.string(), path: z.string(), archivePath: z.string() })) })
          .parse(JSON.parse(String(init?.body)));
        if (input.items.some((item) => !readableTree(item.root, item.path)))
          return Response.json({ error: "forbidden", message: "Unix access denied" }, { status: 403 });
        archives.push(input.items);
        return Response.json({ url: "http://localhost:4000/archive", method: "POST", expires: "2099-01-01T00:00:00Z", manifest: "signed" });
      }
      const root = parts[3]!;
      const operation = parts[4];
      if (execution && (operation === "stat" || operation === "acl")) {
        const path = req.searchParams.get("path") ?? ".";
        scopedMetadata.push({ operation, path });
        // O_PATH metadata lookup needs search permission on ancestors, not read permission on the leaf.
        const segments = path === "." ? [] : path.split("/");
        for (let i = 0; i < segments.length; i++) {
          const parent = i === 0 ? "." : segments.slice(0, i).join("/");
          const node = nodes.get(`${root}:${parent}`);
          if (!node?.directory) return Response.json({ error: "not_found" }, { status: 404 });
          if (!allowed(node, 1)) return Response.json({ error: "forbidden" }, { status: 403 });
        }
      }
      if (!operation)
        return Response.json({
          name: root,
          managed: root === "cloud",
          execution: true,
          index: { enabled: root === "cloud" || ipaIndexed },
          versioning: { enabled: root === "cloud" },
          stats: null,
          versions: 0,
          versionBytes: 0,
          activeUploads: 0,
          available: 1000,
          capacity: 2000,
        });
      if (operation === "content")
        return nodes.has(`${root}:${req.searchParams.get("path")}`)
          ? new Response(contents.get(`${root}:${req.searchParams.get("path")}`) ?? "")
          : new Response("", { status: 404 });
      if (operation === "downloads" || operation === "thumbnail") {
        leases++;
        const target = z.object({ path: z.string().optional() }).parse(init?.body ? JSON.parse(String(init.body)) : {});
        return Response.json({
          method: "GET",
          url: `http://localhost:4000/signed/${root}/${target.path ?? ""}`,
          expires: "2099-01-01T00:00:00Z",
        });
      }
      if (operation === "uploads") {
        const sessionId = parts[6];
        const action = parts[7];
        const input = z
          .object({
            path: z.string().optional(),
            size: z.number().optional(),
            onConflict: z.enum(["error", "overwrite", "rename"]).optional(),
            ownership: z.object({ uid: z.number().optional(), gid: z.number().optional(), mode: z.string().optional() }).optional(),
            precondition: z.object({ ifMatch: z.string().optional(), ifNoneMatch: z.literal(true).optional() }).optional(),
            idempotencyKey: z.string().optional(),
          })
          .parse(init?.body ? JSON.parse(String(init.body)) : {});
        if (parts[5] === "direct") {
          if (input.precondition && root !== "cloud")
            return Response.json({ error: "feature_disabled", message: "managed root required" }, { status: 409 });
          if (nodes.has(`${root}:${input.path}`) && input.onConflict === "error")
            return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
          const ownership = z
            .object({ uid: z.number().optional(), gid: z.number().optional(), mode: z.string().optional() })
            .parse(input.ownership ?? {});
          const leaseId = `direct-${++directCounter}`;
          directUploads.set(leaseId, {
            root,
            path: input.path!,
            size: input.size!,
            ownership,
            onConflict: input.onConflict,
            precondition: input.precondition,
          });
          directRequests.push({ root, path: input.path!, precondition: input.precondition });
          return Response.json({
            method: "PUT",
            url: `http://localhost:4000/v1/direct/${leaseId}.signature`,
            expires: "2099-01-01T00:00:00Z",
          });
        }
        if (!sessionId) {
          if (input.precondition?.ifNoneMatch && input.onConflict === "overwrite")
            return Response.json({ error: "invalid_argument" }, { status: 400 });
          const key = input.idempotencyKey;
          const prior = key ? sessions.get(sessionKeys.get(key) ?? "") : undefined;
          if (prior)
            return Response.json({
              session: { ...prior, chunkSize: 4, expires: "2099-01-01T00:00:00Z", uploadedSegments: 0 },
              ...(prior.state === "open"
                ? {
                    lease: {
                      url: `http://localhost:4000/v1/direct/${prior.id}.test`,
                      expires: "2099-01-01T00:00:00Z",
                      operations: ["status", "write", "abort"],
                    },
                  }
                : {}),
            });
          if (nodes.has(`${root}:${input.path}`) && input.onConflict === "error")
            return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
          const id = `session-${++sessionCounter}`;
          const executionHeader = new Headers(init?.headers).get("X-Filegate-Execution");
          const execution = executionHeader
            ? z.object({ uid: z.number(), gid: z.number(), groups: z.array(z.number()).optional() }).parse(JSON.parse(executionHeader))
            : undefined;
          const options = { onConflict: input.onConflict, ownership: input.ownership, precondition: input.precondition };
          sessions.set(id, {
            id,
            root,
            path: input.path!,
            size: input.size!,
            received: 0,
            state: "open",
            options,
            execution,
            ownership: input.ownership,
            onConflict: input.onConflict,
          });
          if (key) sessionKeys.set(key, id);
          if (lostCreateResponse) {
            lostCreateResponse = false;
            throw new Error("lost_create_response");
          }
          return Response.json({
            session: { ...sessions.get(id), chunkSize: 4, expires: "2099-01-01T00:00:00Z", uploadedSegments: 0 },
            lease: {
              url: `http://localhost:4000/v1/direct/${id}.test`,
              expires: "2099-01-01T00:00:00Z",
              operations: ["status", "write", "abort"],
            },
          });
        }
        const session = sessions.get(sessionId);
        if (!session) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
        const requestExecution = new Headers(init?.headers).get("X-Filegate-Execution");
        if (JSON.stringify(session.execution ?? null) !== JSON.stringify(requestExecution ? JSON.parse(requestExecution) : null))
          return Response.json({ error: "forbidden" }, { status: 403 });
        if (action === "lease")
          return Response.json({
            url: `http://localhost:4000/v1/direct/${sessionId}.renewed`,
            expires: "2099-01-01T00:00:00Z",
            operations: ["status", "write"],
          });
        if (action === "commit") {
          if (session.state !== "open") return Response.json({ error: "conflict", message: "closed" }, { status: 409 });
          const old = nodes.get(`${root}:${session.path}`);
          if (
            (session.options.precondition?.ifNoneMatch && old) ||
            (session.options.precondition?.ifMatch && old?.revision !== session.options.precondition.ifMatch)
          )
            return Response.json({ error: "precondition_failed" }, { status: 412 });
          const ownership = z
            .object({ uid: z.number().optional(), gid: z.number().optional(), mode: z.string().optional() })
            .parse(session.ownership ?? {});
          let target = session.path;
          if (session.onConflict === "rename")
            for (let i = 1; nodes.has(`${root}:${target}`); i++)
              target = session.path.replace(/(\.[^./]+)?$/, `-${String(i).padStart(2, "0")}$1`);
          const node = {
            ...directory(root, target, ownership.uid ?? 0, ownership.gid ?? 0, ownership.mode ?? "0644", false),
            size: session.size,
          };
          nodes.set(`${root}:${target}`, node);
          session.state = "committed";
          session.result = node;
          if (lostCommitResponse) {
            lostCommitResponse = false;
            throw new Error("lost_response");
          }
          return Response.json(node);
        }
        if (init?.method === "DELETE") {
          if (session.state === "committed" || session.state === "expired")
            return Response.json({ error: `session_${session.state}` }, { status: 409 });
          session.state = "aborted";
          return new Response(null, { status: 204 });
        }
        afterSessionRead?.();
        return Response.json({ ...session, chunkSize: 4, expires: "2099-01-01T00:00:00Z", uploadedSegments: 0 });
      }
      const body = z
        .object({
          path: z.string().optional(),
          targetRoot: z.string().optional(),
          targetExecution: z
            .discriminatedUnion("mode", [
              z.object({ mode: z.literal("service") }),
              z.object({
                mode: z.literal("unix"),
                identity: z.object({ uid: z.number(), gid: z.number(), groups: z.array(z.number()).optional() }),
              }),
            ])
            .optional(),
          targetPath: z.string().optional(),
          ownership: z
            .object({ uid: z.number().optional(), gid: z.number().optional(), mode: z.string().optional(), dirMode: z.string().optional() })
            .optional(),
          acl: z.object({ default: z.unknown().optional() }).optional(),
          move: z.boolean().optional(),
          onConflict: z.string().optional(),
        })
        .parse(init?.body ? JSON.parse(String(init.body)) : {});
      if (operation === "directories" && init?.method === "POST") {
        const target = body.path!;
        if (nodes.has(`${root}:${target}`)) return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
        const made = directory(root, target, body.ownership?.uid ?? 0, body.ownership?.gid ?? 0, body.ownership?.dirMode ?? "0755");
        if (body.acl?.default) defaults.set(`${root}:${target}`, body.acl.default);
        return Response.json(made);
      }
      if (operation === "transfers") {
        executions.push({ source: execution, target: body.targetExecution, operation });
        if (failMove) {
          failMove = false;
          throw new Error("unavailable");
        }
        const source = body.path!;
        const targetRoot = body.targetRoot ?? root;
        if (body.move === true && root === targetRoot && body.ownership)
          return Response.json({ error: "invalid_request", message: "native moves do not accept ownership" }, { status: 400 });
        let target = body.targetPath!;
        const original = nodes.get(`${root}:${source}`);
        if (!original) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
        if (body.move !== true && !readableTree(root, source))
          return Response.json({ error: "forbidden", message: "Unix access denied" }, { status: 403 });
        if (nodes.has(`${targetRoot}:${target}`)) {
          if (body.onConflict !== "rename") return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
          const dot = body.targetPath!.slice(body.targetPath!.lastIndexOf("/") + 1).lastIndexOf(".");
          const stem =
            dot > 0
              ? body.targetPath!.slice(
                  0,
                  body.targetPath!.length - (body.targetPath!.slice(body.targetPath!.lastIndexOf("/") + 1).length - dot),
                )
              : body.targetPath!;
          const ext = dot > 0 ? body.targetPath!.slice(stem.length) : "";
          for (let attempt = 0; nodes.has(`${targetRoot}:${target}`) && attempt < 8; attempt++)
            target = `${stem}-${crypto.randomUUID().replaceAll("-", "")}${ext}`;
          if (nodes.has(`${targetRoot}:${target}`))
            return Response.json({ error: "already_exists", message: "rename exhausted" }, { status: 409 });
        }
        for (const [key, node] of [...nodes])
          if (node.root === root && (node.path === source || node.path.startsWith(source + "/"))) {
            if (body.move === true) nodes.delete(key);
            const updated = {
              ...node,
              root: targetRoot,
              path: target + node.path.slice(source.length),
              ...(body.move !== true && body.ownership
                ? {
                    uid: body.ownership.uid ?? (body.targetExecution?.mode === "unix" ? body.targetExecution.identity.uid : 0),
                    gid: body.ownership.gid ?? (body.targetExecution?.mode === "unix" ? body.targetExecution.identity.gid : 0),
                    mode: node.directory ? (body.ownership.dirMode ?? node.mode) : (body.ownership.mode ?? node.mode),
                  }
                : {}),
            };
            nodes.set(`${targetRoot}:${updated.path}`, updated);
          }
        if (body.move !== true) return Response.json({ state: "completed", node: nodes.get(`${targetRoot}:${target}`) });
        if (lostMoveResponse) {
          lostMoveResponse = false;
          failMove = false;
          throw new Error("lost_response");
        }
        const state = contents.get("__transfer_response_state__") ?? "completed";
        return Response.json({ state, node: nodes.get(`${targetRoot}:${target}`) }, { status: state === "completed" ? 200 : 202 });
      }
      const path = req.searchParams.get("path") ?? ".";
      if (operation === "versions") {
        const versionId = parts[5];
        const action = parts[6];
        // Direct version downloads carry the path in the body instead of the query.
        const vpath = req.searchParams.get("path") ?? z.object({ path: z.string() }).parse(JSON.parse(String(init?.body ?? "{}"))).path;
        const fileVersions = () => versions.get(`${root}:${vpath}`) ?? [];
        if (!versionId) {
          if (init?.method === "POST") {
            const options = z
              .object({ pinned: z.boolean().optional(), metadata: z.record(z.string(), z.unknown()).optional() })
              .parse(init.body ? JSON.parse(String(init.body)) : {});
            const version = {
              id: `v${++versionCounter}`,
              fileId: "file",
              created: new Date().toISOString(),
              size: nodes.get(`${root}:${vpath}`)?.size ?? 0,
              pinned: options.pinned ?? false,
              metadata: options.metadata,
              copyMode: "copy",
              content: `content-of-${nodes.get(`${root}:${vpath}`)?.modified}`,
            };
            versions.set(`${root}:${vpath}`, [version, ...fileVersions()]);
            return Response.json(version, { status: 201 });
          }
          return Response.json(fileVersions());
        }
        const version = fileVersions().find((item) => item.id === versionId);
        if (!version) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
        if (action === "copy") {
          executions.push({ source: execution, target: body.targetExecution, operation: "copyVersion" });
          const targetRoot = body.targetRoot ?? root;
          const targetPath = body.targetPath!;
          if (root === targetRoot && vpath === targetPath)
            return Response.json({ error: "invalid_request", message: "same source and target" }, { status: 400 });
          if (nodes.has(`${targetRoot}:${targetPath}`))
            return Response.json({ error: "already_exists", message: "exists" }, { status: 409 });
          const original = nodes.get(`${root}:${vpath}`)!;
          const copied = {
            ...original,
            root: targetRoot,
            path: targetPath,
            size: version.size,
            modified: `copy:${version.id}`,
            uid: body.ownership?.uid ?? 0,
            gid: body.ownership?.gid ?? 0,
            mode: body.ownership?.mode ?? "0600",
          };
          nodes.set(`${targetRoot}:${targetPath}`, copied);
          contents.set(`${targetRoot}:${targetPath}`, version.content);
          return Response.json(copied, { status: 201 });
        }
        if (action === "restore") {
          const node = nodes.get(`${root}:${vpath}`)!;
          const snapshot = {
            ...version,
            id: `v${++versionCounter}`,
            metadata: undefined,
            created: new Date().toISOString(),
            content: `content-of-${node.modified}`,
          };
          versions.set(`${root}:${vpath}`, [snapshot, ...fileVersions()]);
          const restored = { ...node, modified: `restored:${version.id}` };
          nodes.set(`${root}:${vpath}`, restored);
          return Response.json(restored);
        }
        if (action === "downloads") {
          leases++;
          return Response.json({ method: "GET", url: `http://localhost:4000/signed/${versionId}`, expires: "2099-01-01T00:00:00Z" });
        }
        if (init?.method === "PATCH") {
          const options = z
            .object({ pinned: z.boolean().optional(), metadata: z.record(z.string(), z.unknown()).optional() })
            .parse(JSON.parse(String(init.body)));
          Object.assign(version, { pinned: options.pinned ?? version.pinned, metadata: options.metadata });
          return Response.json(version);
        }
        if (init?.method === "DELETE") {
          versions.set(
            `${root}:${vpath}`,
            fileVersions().filter((item) => item.id !== versionId),
          );
          return new Response(null, { status: 204 });
        }
        return Response.json(version);
      }
      if (operation === "files" && init?.method === "DELETE") {
        for (const [key, node] of [...nodes])
          if (node.root === root && (node.path === path || node.path.startsWith(path + "/"))) nodes.delete(key);
        return new Response(null, { status: 204 });
      }
      const node = nodes.get(`${root}:${path}`);
      if (!node) return Response.json({ error: "not_found", message: "missing" }, { status: 404 });
      if (operation === "acl") {
        if (req.searchParams.get("scope") === "default") return Response.json(defaults.get(`${root}:${path}`) ?? { entries: [] });
        const mode = Number.parseInt(node.mode, 8);
        const permission = (bits: number) => `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
        return Response.json({
          entries: [
            { tag: "owner", permissions: permission((mode >> 6) & 7) },
            { tag: "owningGroup", permissions: permission((mode >> 3) & 7) },
            { tag: "other", permissions: permission(mode & 7) },
          ],
        });
      }
      if (operation === "search" || operation === "entries") {
        let items = [...nodes.values()].filter((item) => item.root === root && item.path.startsWith(`${path}/`));
        if (operation === "search") {
          executions.push({ source: execution, target: null, operation });
          if (execution && items.some((item) => item.directory && !allowed(item, 5)))
            return Response.json({ error: "forbidden" }, { status: 403 });
          if (items.length > Number(req.searchParams.get("maxEntries") ?? 100000))
            return Response.json({ error: "limit_exceeded", message: "limit exceeded" }, { status: 413 });
          const q = req.searchParams.get("q")!.toLowerCase();
          items = items.filter((item) => item.path.split("/").at(-1)!.toLowerCase().includes(q));
        } else items = items.filter((item) => !item.path.slice(path.length + 1).includes("/"));
        const type = req.searchParams.get("type") ?? "all";
        items = items.filter((item) => type === "all" || item.directory === (type === "directories"));
        const sort = req.searchParams.get("sort") ?? "path";
        const direction = req.searchParams.get("order") === "desc" ? -1 : 1;
        const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        items.sort(
          (a, b) =>
            direction *
            ((sort === "size"
              ? a.size - b.size
              : sort === "modified"
                ? compare(a.modified, b.modified)
                : sort === "name"
                  ? compare(a.path.split("/").at(-1)!, b.path.split("/").at(-1)!)
                  : compare(a.path, b.path)) || compare(a.path, b.path)),
        );
        const offset = Number((req.searchParams.get("after") ?? "cursor:0").slice(7));
        const limit = Number(req.searchParams.get("limit") ?? 50);
        return Response.json({
          items: items.slice(offset, offset + limit),
          next: offset + limit < items.length ? `cursor:${offset + limit}` : undefined,
        });
      }
      return Response.json(node);
    },
    { preconnect: fetch.preconnect },
  );
  const service = createFilesService({
    identities: {
      ...accountIdentities,
      async reconcile(...args: Parameters<typeof accountIdentities.reconcile>) {
        reconciliations++;
        return accountIdentities.reconcile(...args);
      },
    },
    bindings,
    readConfiguration: async () => config,
    writeConfiguration: async (input) => {
      config = { ...input, token: input.token || config.token, tokenConfigured: true };
    },
    publicOrigin: async () => "https://cloud.test",
    userById: async (id: string) => users.get(id) ?? null,
    transfer: transport,
    connect: (configuration) =>
      new Filegate({ baseUrl: configuration.url, transferBaseUrl: configuration.url, token: configuration.token, fetch: transport }),
  });
  /** WOPI resolves users by id; the test keeps every actor it created. */
  const users = new Map<string, Extract<RequestActor, { kind: "user" }>["user"]>();
  const user = async (
    name: string,
    provider: "local" | "ipa" = "local",
    admin = false,
    profile: "user" | "guest" = "user",
  ): Promise<RequestActor> => {
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,admin) VALUES(${name},${provider},${profile},${admin}) RETURNING id`;
    if (provider === "ipa") await sql`INSERT INTO auth.user_posix VALUES(${row!.id},'ipa',1001,2001)`;
    const parsed = UserSchema.parse({
      id: row!.id,
      uid: name,
      provider,
      profile,
      roles: admin ? ["user", "admin"] : [profile],
      givenname: "",
      sn: "",
      displayName: name,
      mail: null,
      avatarHash: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      ipa:
        provider === "local"
          ? null
          : {
              uidNumber: 1001,
              phone: null,
              employeeType: null,
              mobile: null,
              address: { street: null, postalCode: null, city: null, state: null },
              passwordExpires: null,
              lastLoginIpa: null,
              syncedAt: null,
              sshPublicKeys: [],
              sshFingerprints: [],
            },
    });
    users.set(parsed.id, parsed);
    return { kind: "user", user: parsed };
  };
  const id = (actor: RequestActor) => (actor.kind === "user" ? actor.user.id : "");
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`DO $$ BEGIN CREATE TYPE auth.permission_level AS ENUM ('none','read','write','admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, group_id uuid, service_account_id uuid, authenticated_only boolean NOT NULL DEFAULT false, permission auth.permission_level NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`.simple();
    await migrate();
    await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await sql`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    await sql`CREATE SCHEMA IF NOT EXISTS audit`.simple();
    await sql`CREATE TABLE IF NOT EXISTS audit.events(id bigserial primary key,action text,outcome text,actor_user_id uuid,actor_uid text,actor_provider text,actor_roles text[],target_type text,target_id text,target_label text,target_provider text,reason text,error_code text,error_message text,request_id text,metadata jsonb)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),uid text,provider text,profile text,admin boolean,account_expires timestamptz)`.simple();
    await sql`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS display_name text, ADD COLUMN IF NOT EXISTS avatar_hash text`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.user_posix(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,managed_by text,uid_number integer,primary_gid_number integer)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,provider text,gid_number integer)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.user_groups_v2(user_id uuid REFERENCES auth.users(id),group_id uuid REFERENCES auth.groups(id))`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.group_groups_v2(parent_group_id uuid,child_group_id uuid)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS auth.ipa_user_effective_groups(user_id uuid,group_name text)`.simple();
    await sql`CREATE TABLE IF NOT EXISTS settings.entries(key text PRIMARY KEY,value text)`.simple();
  });
  beforeEach(async () => {
    ipaIndexed = false;
    executions.length = 0;
    sessions.clear();
    scopedMetadata.length = 0;
    sessionKeys.clear();
    lostCreateResponse = false;
    versions.clear();
    directUploads.clear();
    directRequests.length = 0;
    beforeDirectPublish = undefined;
    nodeRevisionCounter = 0;
    directCounter = 0;
    contents.clear();
    users.clear();
    config.collabora = { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" };
    archives.length = 0;
    lostCommitResponse = false;
    await sql`TRUNCATE filesv2.templates,auth.access,filesv2.recent,filesv2.favorites,filesv2.shares,filesv2.trash,filesv2.uploads,filesv2.operations,filesv2.maintenance,filesv2.bases,audit.events,auth.users,auth.user_posix,auth.groups,auth.user_groups_v2,auth.group_groups_v2,auth.ipa_user_effective_groups,settings.entries CASCADE`.simple();
    await set(
      "linux.identity_config",
      JSON.stringify({ enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" }),
    );
    await set("freeipa.enable", true);
    config.cloud.enabled = true;
    config.freeipa.enabled = true;
    config.cloud.autoCreate = false;
    config.cloud.autoArchive = true;
    defaults.clear();
    lostMoveResponse = false;
    failMove = false;
    nodes.clear();
    leases = 0;
    reconciliations = 0;
    for (const root of ["cloud", "freeipa"]) {
      directory(root, ".", 0, 0, "0755");
      directory(root, "users", 0, 0, "0755");
      directory(root, "groups", 0, 0, "0755");
    }
  });
  test("external IPA home is detected without index/provisioning and direct lease checks current Unix rights", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/report", 1001, 2001, "0640", false);
    const bases = await service.bases(actor);
    expect(bases.items[0]?.status).toBe("existing");
    const baseId = bases.items[0]!.id;
    const listed = await service.list(actor, { baseId });
    expect(listed.items[0]?.name).toBe("report");
    expect((await service.download(actor, { baseId, path: "report" })).method).toBe("GET");
    expect(leases).toBe(1);
    directory("freeipa", "users/alice/report", 999, 999, "0600", false);
    await expect(service.download(actor, { baseId, path: "report" })).rejects.toMatchObject({ code: "forbidden" });
    expect(leases).toBe(1);
    directory("freeipa", "users/alice", 1001, 2001, "0600");
    await expect(service.download(actor, { baseId, path: "report" })).rejects.toMatchObject({ code: "forbidden" });
  });
  test("indexed FreeIPA search uses Unix execution, rejects unreadable trees, hides trash and reports scan limits", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Reports");
    directory("freeipa", "users/alice/Reports/q3-report.pdf", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Private", 999, 999, "0700");
    directory("freeipa", "users/alice/Private/secret-report.txt", 999, 999, "0600", false);
    directory("freeipa", "users/alice/trash");
    directory("freeipa", "users/alice/trash/old-report.txt", 1001, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    ipaIndexed = true;
    await expect(service.search(actor, { baseId, q: "report", groupFolders: false })).rejects.toMatchObject({ status: 403 });
    nodes.delete("freeipa:users/alice/Private");
    nodes.delete("freeipa:users/alice/Private/secret-report.txt");
    const result = await service.search(actor, { baseId, q: "report", groupFolders: false });
    expect(executions.filter((item) => item.operation === "search").every((item) => item.source !== null)).toBe(true);
    expect(result.query).toBe("report");
    expect(result.items.map((item) => item.path)).toEqual(["Reports", "Reports/q3-report.pdf"]);
    expect((await service.search(actor, { baseId, path: "Reports", q: "REPORT" })).items).toHaveLength(1);
    await expect(service.search(actor, { baseId, path: "trash", q: "old" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.search(actor, { baseId, path: "Private", q: "secret" })).rejects.toMatchObject({ status: 404 });
    for (let i = 0; i < 10_001; i++) directory("freeipa", `users/alice/Reports/bulk-${i}.txt`, 1001, 2001, "0640", false);
    await expect(service.search(actor, { baseId, path: "Reports", q: "bulk" })).rejects.toMatchObject({ code: "search_limited" });
  });
  test("global listing and search sorting filter before pagination and directory grouping crosses page boundaries", async () => {
    const actor = await user("browse", "local", true);
    config.cloud.autoCreate = true;
    const baseId = (await service.bases(actor)).items[0]!.id;
    for (let index = 0; index < 61; index++) {
      directory("cloud", `users/browse/z-folder-${String(index).padStart(2, "0")}`);
      const file = directory("cloud", `users/browse/a-file-${String(index).padStart(2, "0")}.txt`, 1001, 2001, "0600", false);
      file.size = index;
      file.modified = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    }
    const first = await service.list(actor, { baseId });
    expect(first.items).toHaveLength(50);
    expect(first.items.every((item) => item.directory)).toBe(true);
    const second = await service.list(actor, { baseId, after: first.next! });
    expect(second.items).toHaveLength(61);
    expect(second.items.slice(0, 11).every((item) => item.directory)).toBe(true);
    expect(second.items.slice(11).every((item) => !item.directory)).toBe(true);
    const third = await service.list(actor, { baseId, after: second.next! });
    expect(third.items).toHaveLength(11);
    expect(third.items.every((item) => !item.directory)).toBe(true);
    expect(third.next).toBeNull();
    const mixed = await service.list(actor, { baseId, groupFolders: false, sort: "name" });
    expect(mixed.items[0]?.name).toBe("a-file-00.txt");
    const sorted = await service.search(actor, { baseId, q: "file", type: "files", sort: "size", order: "desc" });
    expect(sorted.items.map((item) => item.size)).toEqual(Array.from({ length: 50 }, (_, index) => 60 - index));
    const more = await service.search(actor, { baseId, q: "file", type: "files", sort: "size", order: "desc", after: sorted.next! });
    expect(more.items.map((item) => item.size)).toEqual(Array.from({ length: 11 }, (_, index) => 10 - index));
    await expect(service.list(actor, { baseId, after: first.next!, sort: "modified" })).rejects.toMatchObject({ code: "cursor_invalid" });
  });
  test("mkdir requires write access to the parent, keeps user ownership and rejects reserved or existing paths", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/ReadOnly", 999, 2001, "0750");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const created = await service.mkdir(actor, { baseId, path: "Projects" });
    expect(created.entry).toMatchObject({ name: "Projects", path: "Projects", directory: true });
    expect(nodes.get("freeipa:users/alice/Projects")).toMatchObject({ uid: 1001, gid: 2001, mode: "0700" });
    expect((await service.mkdir(actor, { baseId, path: "Projects/2026" })).entry.path).toBe("Projects/2026");
    await expect(service.mkdir(actor, { baseId, path: "Projects" })).rejects.toMatchObject({ status: 409 });
    await expect(service.mkdir(actor, { baseId, path: "trash" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.mkdir(actor, { baseId, path: "trash/keep" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.mkdir(actor, { baseId, path: "ReadOnly/new" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.mkdir(actor, { baseId, path: "Missing/new" })).rejects.toMatchObject({ code: "not_found" });
    const admin = await user("admin", "local", true);
    config.cloud.autoCreate = true;
    const cloudBase = (await service.bases(admin)).items.find((base) => base.area === "cloud")!.id;
    await service.mkdir(admin, { baseId: cloudBase, path: "Notes" });
    expect(nodes.get("cloud:users/admin/Notes")).toMatchObject({ mode: "0700" });
  });
  test("uploads open a bound Filegate session and publish only after the owner commits a complete transfer", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Reports");
    directory("freeipa", "users/alice/existing.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/ReadOnly", 999, 2001, "0750");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const opened = await service.upload(actor, {
      idempotencyKey: crypto.randomUUID(),
      baseId,
      path: "Reports/new.txt",
      size: 12,
      onConflict: "error",
    });
    expect(opened).toMatchObject({
      path: "Reports/new.txt",
      size: 12,
      chunkSize: 4,
      url: `http://localhost:4000/v1/direct/${sessionKeys.get(opened.id)}.renewed`,
    });
    expect(privateSession(opened.id)?.ownership).toEqual({ uid: 1001, gid: 2001, mode: "0600" });
    await expect(service.commitUpload(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "upload_incomplete" });
    privateSession(opened.id)!.received = 12;
    expect((await service.uploadLease(actor, { baseId, id: opened.id })).url).toContain("renewed");
    const committed = await service.commitUpload(actor, { baseId, id: opened.id });
    expect(committed.entry).toMatchObject({ path: "Reports/new.txt", size: 12, directory: false });
    expect(nodes.get("freeipa:users/alice/Reports/new.txt")).toMatchObject({ uid: 1001, gid: 2001, mode: "0600" });
    // Repeating the commit is idempotent and no longer talks to Filegate.
    sessions.delete(sessionKeys.get(opened.id)!);
    expect((await service.commitUpload(actor, { baseId, id: opened.id })).entry.path).toBe("Reports/new.txt");
    expect(await service.capabilityUploadStatus(actor, { baseId, id: opened.id })).toMatchObject({
      state: "completed",
      entry: { path: "Reports/new.txt" },
    });
    let cancelled = false;
    const replayBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    expect((await service.capabilityUpload(actor, { baseId, id: opened.id }, replayBody, new AbortController().signal)).entry.path).toBe(
      "Reports/new.txt",
    );
    expect(cancelled).toBe(true);
    await expect(service.uploadLease(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "upload_closed" });
    // Existing names are only replaced when the client asks for it.
    await expect(
      service.upload(actor, { idempotencyKey: crypto.randomUUID(), baseId, path: "existing.txt", size: 1, onConflict: "error" }),
    ).rejects.toMatchObject({ status: 409 });
    const replace = await service.upload(actor, {
      idempotencyKey: crypto.randomUUID(),
      baseId,
      path: "existing.txt",
      size: 1,
      onConflict: "overwrite",
    });
    expect(replace.path).toBe("existing.txt");
    await expect(
      service.upload(actor, { idempotencyKey: crypto.randomUUID(), baseId, path: "Reports", size: 1, onConflict: "overwrite" }),
    ).rejects.toMatchObject({ code: "not_file" });
    await expect(
      service.upload(actor, { idempotencyKey: crypto.randomUUID(), baseId, path: "ReadOnly/x.txt", size: 1, onConflict: "error" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.upload(actor, { idempotencyKey: crypto.randomUUID(), baseId, path: "trash/x.txt", size: 1, onConflict: "error" }),
    ).rejects.toMatchObject({ code: "reserved_path" });
    await expect(
      service.upload(actor, { idempotencyKey: crypto.randomUUID(), baseId, path: "huge.bin", size: 5000, onConflict: "error" }),
    ).rejects.toMatchObject({ code: "insufficient_space" });
    // Another user cannot commit, renew or abort a session they did not open.
    const bob = await user("bob", "ipa");
    directory("freeipa", "users/bob");
    await expect(service.commitUpload(bob, { baseId, id: replace.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.abortUpload(bob, { baseId, id: replace.id })).rejects.toMatchObject({ code: "not_found" });
    await service.abortUpload(actor, { baseId, id: replace.id });
    expect(privateSession(replace.id)?.state).toBe("aborted");
    await expect(service.commitUpload(actor, { baseId, id: replace.id })).rejects.toMatchObject({ code: "upload_closed" });
    await service.abortUpload(actor, { baseId, id: replace.id });
  });
  test("folder readmes ignore listing filters and pages, select casing deterministically and obey Unix read access", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/nested");
    directory("freeipa", "users/alice/nested/README.md", 1001, 2001, "0600", false);
    directory("freeipa", "users/alice/ReAdMe.Md", 1001, 2001, "0600", false);
    directory("freeipa", "users/alice/readme.md", 1001, 2001, "0600", false);
    directory("freeipa", "users/alice/README.md", 1001, 2001, "0600", false);
    for (let i = 0; i < 1001; i++) directory("freeipa", `users/alice/000-${i}`, 1001, 2001, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    expect((await service.list(actor, { baseId, type: "directories" })).readme?.name).toBe("README.md");
    expect((await service.search(actor, { baseId, q: "000", scope: "folder" })).readme?.name).toBe("README.md");
    nodes.delete("freeipa:users/alice/README.md");
    expect((await service.list(actor, { baseId })).readme?.name).toBe("readme.md");
    nodes.delete("freeipa:users/alice/readme.md");
    expect((await service.list(actor, { baseId })).readme?.name).toBe("ReAdMe.Md");
    nodes.get("freeipa:users/alice/ReAdMe.Md")!.mode = "0000";
    expect((await service.list(actor, { baseId })).readme).toBeNull();
    for (let i = 1001; i < 10001; i++) directory("freeipa", `users/alice/000-${i}`, 1001, 2001, "0600", false);
    expect((await service.list(actor, { baseId, type: "directories" })).readme).toBeNull();
  });
  test("capability transfers reject stale reads, incomplete bodies, concurrent writers and cancellation before commit", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/source.txt", 1001, 2001, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    await expect(
      service.capabilityDownload(actor, { baseId, path: "source.txt", revision: "stale" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "write_conflict" });
    for (const length of [3, 5]) {
      const upload = await service.upload(actor, {
        idempotencyKey: crypto.randomUUID(),
        baseId,
        path: `bad-${length}`,
        size: 4,
        onConflict: "error",
      });
      await expect(
        service.capabilityUpload(
          actor,
          { baseId, id: upload.id },
          new Blob([new Uint8Array(length)]).stream(),
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(privateSession(upload.id).state).toBe("open");
      expect(nodes.has(`freeipa:users/alice/bad-${length}`)).toBe(false);
    }
    const upload = await service.upload(actor, {
      idempotencyKey: crypto.randomUUID(),
      baseId,
      path: "cancelled.bin",
      size: 4,
      onConflict: "error",
    });
    const controller = new AbortController();
    // Abort during the final receipt read, after body consumption and initial abort check.
    afterSegment = () => {
      afterSessionRead = () => controller.abort();
    };
    try {
      await expect(
        service.capabilityUpload(actor, { baseId, id: upload.id }, new Blob(["1234"]).stream(), controller.signal),
      ).rejects.toThrow();
      expect(privateSession(upload.id).state).toBe("open");
      expect(nodes.has("freeipa:users/alice/cancelled.bin")).toBe(false);
    } finally {
      afterSegment = undefined;
      afterSessionRead = undefined;
    }
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    privateSession(upload.id).received = 0;
    const first = service.capabilityUpload(
      actor,
      { baseId, id: upload.id },
      new ReadableStream(
        {
          async pull(c) {
            entered.resolve();
            await release.promise;
            c.enqueue(new TextEncoder().encode("1234"));
            c.close();
          },
        },
        { highWaterMark: 0 },
      ),
      new AbortController().signal,
    );
    // The body is consumed only after the upload lock has been acquired.
    await entered.promise;
    try {
      await expect(
        service.capabilityUpload(actor, { baseId, id: upload.id }, new Blob(["1234"]).stream(), new AbortController().signal),
      ).rejects.toMatchObject({ code: "operation_busy" });
    } finally {
      release.resolve();
    }
    expect((await first).entry.path).toBe("cancelled.bin");
  });
  test("capability upload locks reject concurrent writers without exhausting domain connections", async () => {
    const { withUploadLock } = await import("../data/operations");
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const id = crypto.randomUUID();
    const first = withUploadLock(id, async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      await expect(withUploadLock(id, async () => {})).rejects.toThrow("operation_busy");
      const probes = await Promise.all(Array.from({ length: 10 }, () => sql`SELECT 1 AS value`));
      expect(probes.every((rows) => rows[0].value === 1)).toBe(true);
    } finally {
      release.resolve();
      await first;
    }
  });
  test("a commit whose response was lost is recovered from the Filegate session record", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const opened = await service.upload(actor, {
      idempotencyKey: crypto.randomUUID(),
      baseId,
      path: "lost.txt",
      size: 0,
      onConflict: "error",
    });
    lostCommitResponse = true;
    await expect(service.commitUpload(actor, { baseId, id: opened.id })).rejects.toThrow("lost_response");
    const recovered = await service.commitUpload(actor, { baseId, id: opened.id });
    expect(recovered.entry).toMatchObject({ path: "lost.txt", size: 0 });
    const gone = await service.upload(actor, {
      idempotencyKey: crypto.randomUUID(),
      baseId,
      path: "expired.txt",
      size: 2,
      onConflict: "error",
    });
    privateSession(gone.id)!.state = "expired";
    await expect(service.commitUpload(actor, { baseId, id: gone.id })).rejects.toMatchObject({ code: "upload_closed" });
  });
  test("private uploads reserve before creation and recover the original session and terminal receipt", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const input = { baseId, path: "receipt.txt", size: 0, onConflict: "error" as const, idempotencyKey: crypto.randomUUID() };
    lostCreateResponse = true;
    await expect(service.upload(actor, input)).rejects.toThrow("lost_create_response");
    const [pending] = await sql`SELECT * FROM filesv2.uploads WHERE id=${input.idempotencyKey}`;
    expect(pending).toMatchObject({
      state: "open",
      filegate_session_id: null,
      write_options: { onConflict: "error" },
      execution: { uid: 1001, gid: 2001 },
    });
    const count = sessions.size;
    const opened = await service.upload(actor, input);
    expect(opened.id).toBe(input.idempotencyKey);
    expect(privateSession(opened.id).id).not.toBe(opened.id);
    expect(sessions.size).toBe(count);
    await expect(service.upload(actor, { ...input, size: 1 })).rejects.toMatchObject({ code: "upload_changed" });
    await expect(service.upload(actor, { ...input, onConflict: "overwrite" })).rejects.toMatchObject({ code: "upload_changed" });
    await service.commitUpload(actor, { baseId, id: opened.id });
    const repeated = await service.upload(actor, input);
    expect(repeated).toMatchObject({ id: opened.id, state: "committed" });
    expect(repeated.url).toBeUndefined();
    expect(sessions.size).toBe(count);
    // Recovery can receive a terminal create replay with no lease at all.
    const terminalInput = { ...input, path: "already-published.txt", idempotencyKey: crypto.randomUUID() };
    lostCreateResponse = true;
    await expect(service.upload(actor, terminalInput)).rejects.toThrow("lost_create_response");
    const terminal = privateSession(terminalInput.idempotencyKey);
    terminal.state = "committed";
    terminal.result = { ...directory("freeipa", "users/alice/already-published.txt", 1001, 2001, "0600", false), size: 0 };
    nodes.set("freeipa:users/alice/already-published.txt", terminal.result);
    expect(await service.upload(actor, terminalInput)).toMatchObject({ id: terminalInput.idempotencyKey, state: "committed" });
    expect((await service.commitUpload(actor, { baseId, id: terminalInput.idempotencyKey })).entry.path).toBe("already-published.txt");
  });
  test("private upload recovery never recreates missing or old ambiguous receipts", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const input = { baseId, path: "unknown.txt", size: 0, onConflict: "error" as const, idempotencyKey: crypto.randomUUID() };
    const opened = await service.upload(actor, input);
    sessions.delete(sessionKeys.get(opened.id)!);
    await expect(service.upload(actor, input)).rejects.toMatchObject({ code: "receipt_unknown" });
    await expect(service.commitUpload(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "receipt_unknown" });
    expect(sessions.size).toBe(0);
    const old = { ...input, path: "old.txt", idempotencyKey: crypto.randomUUID() };
    lostCreateResponse = true;
    await expect(service.upload(actor, old)).rejects.toThrow("lost_create_response");
    await sql`UPDATE filesv2.uploads SET created_at=now()-interval '8 days' WHERE id=${old.idempotencyKey}`;
    const count = sessions.size;
    await expect(service.upload(actor, old)).rejects.toMatchObject({ code: "receipt_unknown" });
    expect(sessions.size).toBe(count);
  });
  test("managed private uploads capture revisions and reject publication after another write", async () => {
    const actor = await user("alice", "local", true);
    directory("cloud", "users/alice", 0, 0, "0700");
    await service.adopt(actor, { area: "cloud", kind: "users", identityId: id(actor) });
    directory("cloud", "users/alice/report.txt", 0, 0, "0600", false);
    const before = nodes.get("cloud:users/alice/report.txt")!;
    const baseId = (await service.bases(actor)).items[0]!.id;
    const input = { baseId, path: "report.txt", size: 12, onConflict: "overwrite" as const, idempotencyKey: crypto.randomUUID() };
    const opened = await service.upload(actor, input);
    expect(privateSession(opened.id).options.precondition).toEqual({ ifMatch: before.revision });
    privateSession(opened.id).received = 12;
    nodes.set("cloud:users/alice/report.txt", { ...before, revision: "new-revision" });
    await service.upload(actor, input);
    expect(privateSession(opened.id).options.precondition).toEqual({ ifMatch: before.revision });
    await expect(service.commitUpload(actor, { baseId, id: opened.id })).rejects.toMatchObject({ status: 412 });
    expect(nodes.get("cloud:users/alice/report.txt")!.revision).toBe("new-revision");
  });
  test("private upload retries and every action require the original execution and options", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const input = { baseId, path: "scoped.txt", size: 0, onConflict: "error" as const, idempotencyKey: crypto.randomUUID() };
    const opened = await service.upload(actor, input);
    const session = privateSession(opened.id);
    session.options.onConflict = "overwrite";
    await expect(service.uploadLease(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "upload_changed" });
    await expect(service.abortUpload(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "upload_changed" });
    session.options.onConflict = "error";
    const [group] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups(name,provider,gid_number) VALUES('new-team','ipa',2002) RETURNING id`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${id(actor)},${group!.id})`;
    await expect(service.upload(actor, input)).rejects.toMatchObject({ code: "upload_changed" });
    await expect(service.uploadLease(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "upload_changed" });
    await expect(service.commitUpload(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "upload_changed" });
    await expect(service.abortUpload(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "upload_changed" });
    expect(session.state).toBe("open");
  });
  test("managed upload overwrite for an absent target stays create-only on retries", async () => {
    const actor = await user("alice", "local", true);
    directory("cloud", "users/alice", 0, 0, "0700");
    await service.adopt(actor, { area: "cloud", kind: "users", identityId: id(actor) });
    const baseId = (await service.bases(actor)).items[0]!.id;
    const input = { baseId, path: "new.txt", size: 0, onConflict: "overwrite" as const, idempotencyKey: crypto.randomUUID() };
    const opened = await service.upload(actor, input);
    expect(privateSession(opened.id).options).toMatchObject({ onConflict: "error", precondition: { ifNoneMatch: true } });
    directory("cloud", "users/alice/new.txt", 0, 0, "0600", false);
    expect((await service.upload(actor, input)).id).toBe(opened.id);
    expect(privateSession(opened.id).options).toMatchObject({ onConflict: "error", precondition: { ifNoneMatch: true } });
    await expect(service.commitUpload(actor, { baseId, id: opened.id })).rejects.toMatchObject({ status: 412 });
    expect(nodes.get("cloud:users/alice/new.txt")!.size).toBe(12);
  });
  test("rename, move and duplicate stay inside the base, need a writable parent and never touch trash", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/Docs/a.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Archive", 999, 2001, "0750");
    directory("freeipa", "users/alice/Archive/old.txt", 999, 2001, "0640", false);
    directory("freeipa", "users/alice/trash");
    const baseId = (await service.bases(actor)).items[0]!.id;
    expect((await service.rename(actor, { baseId, path: "Docs/a.txt", name: "b.txt" })).entry.path).toBe("Docs/b.txt");
    await expect(service.rename(actor, { baseId, path: "Docs/b.txt", name: "../x.txt" })).rejects.toMatchObject({ code: "invalid_path" });
    await expect(service.rename(actor, { baseId, path: "Docs", name: "trash" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.rename(actor, { baseId, path: "Archive/old.txt", name: "new.txt" })).rejects.toMatchObject({ code: "forbidden" });
    const moved = await service.move(actor, { baseId, paths: ["Docs/b.txt"], folder: "" });
    expect(moved.entries.map((entry) => entry.path)).toEqual(["b.txt"]);
    expect((await service.move(actor, { baseId, paths: ["Docs"], folder: "Docs" })).results).toMatchObject([
      { ok: false, error: "move_into_self" },
    ]);
    expect((await service.move(actor, { baseId, paths: ["b.txt"], folder: "Archive" })).results).toMatchObject([
      { ok: false, error: "forbidden" },
    ]);
    await expect(service.move(actor, { baseId, paths: ["b.txt"], folder: "trash" })).rejects.toMatchObject({ code: "reserved_path" });
    const duplicated = await service.copy(actor, { baseId, paths: ["b.txt"], targetBaseId: baseId, folder: "" });
    expect(duplicated.entries[0]!.path).toMatch(/^b-[0-9a-f]{32}\.txt$/);
    expect(nodes.get(`freeipa:users/alice/${duplicated.entries[0]!.path}`)).toMatchObject({ uid: 1001, gid: 2001, mode: "0600" });
  });
  test("copies may cross bases but moves never leave a base", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/private.txt", 1001, 2001, "0640", false);
    const [group] = await sql<{ id: string }[]>`INSERT INTO auth.groups(name,provider,gid_number) VALUES('team','ipa',2002) RETURNING id`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${id(actor)},${group!.id})`;
    await sql`INSERT INTO auth.ipa_user_effective_groups VALUES(${id(actor)},'team')`;
    directory("freeipa", "groups/team", 10001, 2002, "2770");
    directory("freeipa", "groups/team/shared.txt", 999, 2002, "0660", false);
    const bases = (await service.bases(actor)).items;
    const home = bases.find((base) => base.kind === "users")!.id;
    const team = bases.find((base) => base.kind === "groups")!.id;
    expect(group).toBeTruthy();
    const copied = await service.copy(actor, { baseId: home, paths: ["private.txt"], targetBaseId: team, folder: "" });
    expect(copied.base.id).toBe(team);
    expect(nodes.get("freeipa:groups/team/private.txt")).toMatchObject({ uid: 1001, gid: 2002, mode: "0660" });
    expect(nodes.has("freeipa:users/alice/private.txt")).toBeTrue();
    // The service has no cross-base move; a target folder always belongs to the source base.
    await expect(service.move(actor, { baseId: team, paths: ["shared.txt"], folder: "../../users/alice" })).rejects.toThrow();
    expect(nodes.has("freeipa:groups/team/shared.txt")).toBeTrue();
  });
  test("deleting moves entries into trash with a restorable record", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/Docs/note.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Docs/note (1).txt", 1001, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const removed = await service.remove(actor, { baseId, paths: ["Docs/note.txt"] });
    expect(removed.entries[0]).toMatchObject({ original: "Docs/note.txt", name: "note.txt", directory: false });
    expect(nodes.has("freeipa:users/alice/Docs/note.txt")).toBeFalse();
    expect(nodes.get("freeipa:users/alice/trash")).toMatchObject({ uid: 1001, gid: 2001, mode: "0700" });
    expect(nodes.has(`freeipa:users/alice/trash/${removed.entries[0]!.id}`)).toBeTrue();
    expect((await service.list(actor, { baseId, path: "" })).items.map((item) => item.name)).toEqual(["Docs"]);
    const listed = await service.trash(actor, { baseId });
    expect(listed.entries.map((entry) => entry.original)).toEqual(["Docs/note.txt"]);
    await expect(service.remove(actor, { baseId, paths: ["trash/note.txt"] })).rejects.toMatchObject({ code: "reserved_path" });
    // A second delete of the same name lands beside the first, and restoring requires a free original path.
    directory("freeipa", "users/alice/Docs/note.txt", 1001, 2001, "0640", false);
    const removedAgain = await service.remove(actor, { baseId, paths: ["Docs/note.txt"] });
    expect(nodes.has(`freeipa:users/alice/trash/${removedAgain.entries[0]!.id}`)).toBeTrue();
    expect(removedAgain.entries[0]!.id).not.toBe(removed.entries[0]!.id);
    const restored = await service.restoreTrash(actor, { baseId, id: removed.entries[0]!.id });
    expect(restored.entry.path).toBe("Docs/note.txt");
    expect((await service.restoreTrash(actor, { baseId, id: removed.entries[0]!.id })).entry.path).toBe("Docs/note.txt");
    const second = (await service.trash(actor, { baseId })).entries[0]!;
    await expect(service.restoreTrash(actor, { baseId, id: second.id })).rejects.toMatchObject({ status: 409 });
  });
  test("selections download as one signed archive of authorized entries", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/a.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/secret.txt", 999, 999, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const lease = await service.bundle(actor, { baseId, paths: ["Docs", "a.txt"] });
    expect(lease).toMatchObject({ method: "POST", manifest: "signed" });
    expect(archives[0]).toEqual([
      { root: "freeipa", path: "users/alice/Docs", archivePath: "Docs" },
      { root: "freeipa", path: "users/alice/a.txt", archivePath: "a.txt" },
    ]);
    await expect(service.bundle(actor, { baseId, paths: ["a.txt", "secret.txt"] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.bundle(actor, { baseId, paths: ["trash"] })).rejects.toMatchObject({ code: "reserved_path" });
    expect(archives).toHaveLength(1);
  });
  test("native FreeIPA tree copies reject unreadable descendants before publishing a destination", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/Docs/readable.txt", 1001, 2001, "0600", false);
    directory("freeipa", "users/alice/Docs/secret.txt", 999, 999, "0600", false);
    directory("freeipa", "users/alice/Copies");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const result = await service.copy(actor, { baseId, paths: ["Docs"], targetBaseId: baseId, folder: "Copies" });
    expect(result.entries).toEqual([]);
    expect(result.results).toMatchObject([{ path: "Docs", ok: false, error: "forbidden" }]);
    expect(nodes.has("freeipa:users/alice/Copies/Docs")).toBe(false);
  });
  test("mixed Cloud and FreeIPA copies bind separate source and destination identities", async () => {
    const admin = await user("admin", "local", true);
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/private.txt", 1001, 2001, "0600", false);
    directory("cloud", "groups/team", 99, 99);
    directory("cloud", "groups/team/shared.txt", 99, 99, "0600", false);
    const [group] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups(name,provider,gid_number) VALUES('team','local',200003) RETURNING id`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${id(actor)},${group!.id})`;
    const team = await service.adopt(admin, { area: "cloud", kind: "groups", identityId: group!.id });
    const home = (await service.bases(actor)).items.find((base) => base.area === "freeipa")!;
    const toCloud = await service.copy(actor, { baseId: home.id, paths: ["private.txt"], targetBaseId: team.id, folder: "" });
    const toFreeipa = await service.copy(actor, { baseId: team.id, paths: ["shared.txt"], targetBaseId: home.id, folder: "" });
    expect(toCloud.results).toMatchObject([{ ok: true }]);
    expect(toFreeipa.results).toMatchObject([{ ok: true }]);
    expect(nodes.get("cloud:groups/team/private.txt")).toMatchObject({ uid: 0, gid: 0, mode: "0660" });
    expect(nodes.get("freeipa:users/alice/shared.txt")).toMatchObject({ uid: 1001, gid: 2001, mode: "0600" });
    expect(executions).toEqual([
      { operation: "transfers", source: { uid: 1001, gid: 2001, groups: [] }, target: { mode: "service" } },
      { operation: "transfers", source: null, target: { mode: "unix", identity: { uid: 1001, gid: 2001, groups: [] } } },
    ]);
    directory("freeipa", "users/alice/secret.txt", 999, 999, "0600", false);
    expect(
      (await service.copy(actor, { baseId: home.id, paths: ["secret.txt"], targetBaseId: team.id, folder: "" })).results,
    ).toMatchObject([{ ok: false, error: "forbidden" }]);
    expect(nodes.has("cloud:groups/team/secret.txt")).toBe(false);
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id=${id(actor)}`;
    await expect(service.copy(actor, { baseId: home.id, paths: ["private.txt"], targetBaseId: team.id, folder: "" })).rejects.toMatchObject(
      { code: "not_found" },
    );
  });
  test("pending native transfer responses never become a completed rename", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/old.txt", 1001, 2001, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    contents.set("__transfer_response_state__", "source_pending");
    await expect(service.rename(actor, { baseId, path: "old.txt", name: "new.txt" })).rejects.toMatchObject({ code: "operation_pending" });
  });
  test("versions are listed with comments, restored in place or as a copy, and deleted", async () => {
    const admin = await user("admin", "local", true);
    config.cloud.autoCreate = true;
    const baseId = (await service.bases(admin)).items.find((base) => base.area === "cloud")!.id;
    directory("cloud", "users/admin/report.txt", 0, 0, "0600", false);
    expect(await service.versions(admin, { baseId, path: "report.txt" })).toEqual([]);
    const filegate = new Filegate({ baseUrl: "http://filegate:4000", token: "backend-test-secret", fetch: transport }).root("cloud");
    const v1 = await filegate.snapshot("users/admin/report.txt", { metadata: { comment: "first" } });
    const commented = await service.commentVersion(admin, { baseId, path: "report.txt", id: v1.id, comment: "final draft" });
    expect(commented).toMatchObject({ id: v1.id, comment: "final draft", author: "admin" });
    expect((await service.versions(admin, { baseId, path: "report.txt" }))[0]).toMatchObject({ id: v1.id, comment: "final draft" });
    const originalNode = structuredClone(nodes.get("cloud:users/admin/report.txt"));
    const originalHistory = structuredClone(versions.get("cloud:users/admin/report.txt"));
    const originalContent = contents.get("cloud:users/admin/report.txt");
    const asCopy = await service.restoreVersionAs(admin, { baseId, path: "report.txt", id: v1.id, name: "report-v1.txt" });
    expect(executions.at(-1)).toEqual({ source: null, target: { mode: "service" }, operation: "copyVersion" });
    expect(asCopy.entry.path).toBe("report-v1.txt");
    expect(contents.get("cloud:users/admin/report-v1.txt")).toBe(originalHistory![0]!.content);
    expect(nodes.get("cloud:users/admin/report.txt")).toEqual(originalNode);
    expect(versions.get("cloud:users/admin/report.txt")).toEqual(originalHistory);
    expect(contents.get("cloud:users/admin/report.txt")).toBe(originalContent);
    await expect(service.restoreVersionAs(admin, { baseId, path: "report.txt", id: v1.id, name: "report-v1.txt" })).rejects.toMatchObject({
      status: 409,
    });
    expect(nodes.get("cloud:users/admin/report.txt")).toEqual(originalNode);
    expect(versions.get("cloud:users/admin/report.txt")).toEqual(originalHistory);
    expect((await service.versions(admin, { baseId, path: "report.txt" })).some((version) => version.id === v1.id)).toBeTrue();
    await expect(service.restoreVersionAs(admin, { baseId, path: "report.txt", id: v1.id, name: "report.txt" })).rejects.toMatchObject({
      code: "invalid_path",
    });
    const restored = await service.restoreVersion(admin, { baseId, path: "report.txt", id: v1.id });
    expect(restored.entry.modified).toBe(`restored:${v1.id}`);
    expect((await service.versionDownload(admin, { baseId, path: "report.txt", id: v1.id })).url).toContain(v1.id);
    await service.deleteVersion(admin, { baseId, path: "report.txt", id: v1.id });
    expect((await service.versions(admin, { baseId, path: "report.txt" })).some((version) => version.id === v1.id)).toBeFalse();
    await expect(service.versions(admin, { baseId, path: "trash/x" })).rejects.toMatchObject({ code: "reserved_path" });
  });
  test("office documents are created from templates and edited through token-bound WOPI calls that re-check rights", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    const baseId = (await service.bases(actor)).items[0]!.id;
    expect((await service.bases(actor)).editor).toBeNull();
    await expect(service.createDocument(actor, { baseId, path: "Docs/Minutes", kind: "text" })).rejects.toMatchObject({
      code: "editor_disabled",
      status: 403,
    });
    config.collabora = {
      url: "http://localhost:9980",
      internalUrl: "http://collabora:9980",
      wopiOrigin: "http://gateway:3000",
      documentFormat: "odf",
    };
    expect((await service.bases(actor)).editor).toEqual({ documentFormat: "odf" });
    const created = await service.createDocument(actor, { baseId, path: "Docs/Minutes", kind: "text" });
    expect(created.entry).toMatchObject({ name: "Minutes.odt", path: "Docs/Minutes.odt", directory: false });
    expect(nodes.get("freeipa:users/alice/Docs/Minutes.odt")).toMatchObject({ uid: 1001, gid: 2001, mode: "0600" });
    expect(contents.get("freeipa:users/alice/Docs/Minutes.odt")?.length).toBeGreaterThan(0);
    await expect(service.createDocument(actor, { baseId, path: "Docs/Minutes", kind: "text" })).rejects.toMatchObject({
      code: "path_conflict",
      status: 409,
    });
    directory("freeipa", "users/alice/Docs/notes.txt", 1001, 2001, "0640", false);
    await expect(service.editor(actor, { baseId, path: "Docs/notes.txt" })).rejects.toMatchObject({ code: "editor_unsupported" });
    const launch = await service.editor(actor, { baseId, path: "Docs/Minutes.odt" });
    if (launch.kind === "markdown") throw new Error("Expected office editor");
    expect(launch.canWrite).toBe(true);
    expect(launch.action.startsWith("http://localhost:9980/browser/abc/cool.html?WOPISrc=")).toBe(true);
    const wopiSrc = decodeURIComponent(launch.action.split("WOPISrc=")[1]!);
    expect(wopiSrc.startsWith("http://gateway:3000/api/filesv2/wopi/files/")).toBe(true);
    const fileId = wopiSrc.split("/").at(-1)!;
    const info = await service.editorFileInfo(launch.token, fileId);
    expect(info).toMatchObject({
      BaseFileName: "Minutes.odt",
      UserCanWrite: true,
      UserFriendlyName: "alice",
      PostMessageOrigin: "https://cloud.test",
      EnableShare: false,
      UserCanNotWriteRelative: true,
    });
    expect(await (await service.editorContent(launch.token, fileId)).text()).toBe(
      contents.get("freeipa:users/alice/Docs/Minutes.odt") ?? "",
    );
    const saved = await service.editorSave(launch.token, fileId, {
      read: async () => new Blob(["edited"]),
      timestamp: info.LastModifiedTime,
    });
    expect(saved).toMatchObject({ modified: expect.any(String) });
    expect(contents.get("freeipa:users/alice/Docs/Minutes.odt")).toBe("edited");
    expect(nodes.get("freeipa:users/alice/Docs/Minutes.odt")).toMatchObject({ uid: 1001, gid: 2001, mode: "0600" });
    // Saving a group-writable file owned by someone else keeps that owner and mode.
    directory("freeipa", "users/alice/Docs/Minutes.odt", 999, 2001, "0664", false);
    const shared = await service.editor(actor, { baseId, path: "Docs/Minutes.odt" });
    if (shared.kind === "markdown") throw new Error("Expected office editor");
    expect(shared.canWrite).toBe(true);
    await service.editorSave(shared.token, fileId, { read: async () => new Blob(["group edit"]), timestamp: null });
    expect(nodes.get("freeipa:users/alice/Docs/Minutes.odt")).toMatchObject({ uid: 999, gid: 2001, mode: "0664" });
    directory("freeipa", "users/alice/Docs/Minutes.odt", 1001, 2001, "0600", false);
    expect(
      await service.editorSave(launch.token, fileId, { read: async () => new Blob(["stale"]), timestamp: info.LastModifiedTime }),
    ).toEqual({ conflict: true });
    expect(contents.get("freeipa:users/alice/Docs/Minutes.odt")).toBe("group edit");
    await expect(service.editorFileInfo(`${launch.token}x`, fileId)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(service.editorFileInfo(launch.token, entryRefId(baseId, "Docs/notes.txt")!)).rejects.toMatchObject({ code: "forbidden" });
    // Rights are read at call time: a file that becomes group-readable only opens read-only and refuses saves.
    directory("freeipa", "users/alice/Docs/Minutes.odt", 999, 2001, "0640", false);
    const readOnly = await service.editor(actor, { baseId, path: "Docs/Minutes.odt" });
    if (readOnly.kind === "markdown") throw new Error("Expected office editor");
    expect(readOnly.canWrite).toBe(false);
    expect((await service.editorFileInfo(readOnly.token, fileId)).UserCanWrite).toBe(false);
    await expect(service.editorSave(readOnly.token, fileId, { read: async () => new Blob(["x"]), timestamp: null })).rejects.toMatchObject({
      code: "forbidden",
    });
    directory("freeipa", "users/alice/Docs/Minutes.odt", 999, 999, "0600", false);
    await expect(service.editorFileInfo(launch.token, fileId)).rejects.toMatchObject({ code: "forbidden" });
    users.delete(id(actor));
    await expect(service.editorFileInfo(readOnly.token, fileId)).rejects.toMatchObject({ code: "forbidden" });
  });
  test("moves and copies never land in trash, archives and shares check whole FreeIPA subtrees, and version writes need file rights", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/Docs/trash");
    directory("freeipa", "users/alice/Docs/trash/keep.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Docs/hr", 999, 999, "0700");
    directory("freeipa", "users/alice/Docs/hr/salaries.txt", 999, 999, "0600", false);
    directory("freeipa", "users/alice/Docs/plan.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Docs/shared.txt", 999, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    expect((await service.move(actor, { baseId, paths: ["Docs/trash"], folder: "" })).results).toMatchObject([
      { ok: false, error: "reserved_path" },
    ]);
    expect((await service.copy(actor, { baseId, paths: ["Docs/trash"], targetBaseId: baseId, folder: "" })).results).toMatchObject([
      { ok: false, error: "reserved_path" },
    ]);
    expect(nodes.has("freeipa:users/alice/trash")).toBe(false);
    await expect(service.bundle(actor, { baseId, paths: ["Docs"] })).rejects.toMatchObject({ code: "forbidden" });
    const share = await service.createShare(actor, {
      baseId,
      kind: "download",
      paths: ["Docs"],
      folder: "",
      title: "Docs",
      expiresIn: "7d",
    });
    const token = share.url!.split("/").at(-1)!;
    await expect(service.publicShareArchive(token)).rejects.toMatchObject({ code: "forbidden" });
    const visible = await service.publicShare(token, "download", { path: "Docs" });
    expect(visible.items.some((item) => item.path === "Docs/hr")).toBe(false);
    expect((await service.bundle(actor, { baseId, paths: ["Docs/plan.txt", "Docs/shared.txt"] })).method).toBe("POST");
    directory("freeipa", "users/alice/Docs/hr", 999, 2001, "0750");
    directory("freeipa", "users/alice/Docs/hr/salaries.txt", 999, 2001, "0640", false);
    expect((await service.bundle(actor, { baseId, paths: ["Docs"] })).method).toBe("POST");
    // A shared file that alice may only read cannot have its versions rewritten by her.
    await expect(service.restoreVersion(actor, { baseId, path: "Docs/shared.txt", id: "v1" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.versions(actor, { baseId, path: "Docs/shared.txt" })).resolves.toEqual([]);
  });
  test("recent and favorites point at bindings the user can still reach", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/Docs/plan.odt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Docs/notes.txt", 1001, 2001, "0640", false);
    contents.set("freeipa:users/alice/Docs/plan.odt", "odt bytes");
    const baseId = (await service.bases(actor)).items[0]!.id;
    expect(await service.recent(actor)).toEqual([]);
    await service.download(actor, { baseId, path: "Docs/plan.odt" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await service.recent(actor)).map((item) => item.entry.path)).toEqual(["Docs/plan.odt"]);
    expect((await service.setFavorite(actor, { baseId, path: "Docs", favorite: true })).favorite).toBe(true);
    expect((await service.entry(actor, { baseId, path: "Docs" })).favorite).toBe(true);
    expect((await service.favorites(actor)).map((item) => `${item.base.name}:${item.entry.path}:${item.entry.directory}`)).toEqual([
      "alice:Docs:true",
    ]);
    await service.rename(actor, { baseId, path: "Docs/plan.odt", name: "plan2.odt" });
    expect(await service.recent(actor)).toEqual([]);
    expect((await service.setFavorite(actor, { baseId, path: "Docs", favorite: false })).favorite).toBe(false);
    expect(await service.favorites(actor)).toEqual([]);
    config.collabora = { url: "http://localhost:9980", internalUrl: "http://collabora:9980", wopiOrigin: "", documentFormat: "odf" };
    // Favorites of a base the user lost are hidden, not shown as reachable entries.
    await service.setFavorite(actor, { baseId, path: "Docs/notes.txt", favorite: true });
    await sql`UPDATE filesv2.bases SET lifecycle='archived' WHERE root='freeipa' AND path='users/alice'`;
    directory("freeipa", "users/alice", 999, 999, "0700");
    expect(await service.favorites(actor)).toEqual([]);
  });
  test("share scopes stop at the first differing folder and shares end with their binding", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    for (const path of ["A", "A/B", "A/B/C", "A/X", "A/X/C", "A/C"]) directory("freeipa", `users/alice/${path}`);
    directory("freeipa", "users/alice/A/B/C/f1.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/A/X/C/f2.txt", 1001, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const share = await service.createShare(actor, {
      baseId,
      kind: "download",
      paths: ["A/B/C/f1.txt", "A/X/C/f2.txt"],
      folder: "",
      title: "Both",
      expiresIn: "7d",
    });
    expect(share.scope).toBe("A");
    const token = share.url!.split("/").at(-1)!;
    expect((await service.publicShare(token, "download")).items).toHaveLength(2);
    config.freeipa.enabled = false;
    await expect(service.publicShare(token, "download")).rejects.toMatchObject({ code: "not_found" });
    config.freeipa.enabled = true;
    await sql`UPDATE filesv2.bases SET lifecycle='archived' WHERE root='freeipa' AND path='users/alice'`;
    await expect(service.publicShare(token, "download")).rejects.toMatchObject({ code: "not_found" });
  });
  test("password shares gate every public operation, store only a salted hash and retain revocation", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/Docs/a.txt", 1001, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const password = "separate secret 123";
    const download = await service.createShare(actor, { baseId, kind: "download", paths: ["Docs"], title: "Private", password });
    const inbox = await service.createShare(actor, { baseId, kind: "inbox", folder: "Docs", title: "Private inbox", password });
    expect(download.passwordProtected).toBe(true);
    expect(JSON.stringify(download)).not.toContain(password);
    const [stored] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM filesv2.shares WHERE id=${download.id}::uuid`;
    expect(stored!.password_hash).toStartWith("$argon2id$");
    expect(await Bun.password.verify(password, stored!.password_hash)).toBe(true);
    const token = download.url.split("/").at(-1)!;
    const inboxToken = inbox.url.split("/").at(-1)!;
    const denied = { code: "share_password_required" };
    await expect(service.publicShare(token, "download")).rejects.toMatchObject(denied);
    await expect(service.publicShareDownload(token, "Docs/a.txt")).rejects.toMatchObject(denied);
    await expect(service.publicShareArchive(token)).rejects.toMatchObject(denied);
    await expect(service.publicShare(inboxToken, "inbox")).rejects.toMatchObject(denied);
    await expect(
      service.publicInboxUpload(inboxToken, { name: "a.txt", size: 8, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject(denied);
    for (const operation of [service.publicInboxLease, service.publicInboxCommit, service.publicInboxAbort])
      await expect(operation(inboxToken, crypto.randomUUID())).rejects.toMatchObject(denied);
    await expect(service.unlockShare(token, "download", "wrong password")).rejects.toMatchObject({ code: "share_password_invalid" });
    const access = await service.unlockShare(token, "download", password);
    expect((await service.publicShare(token, "download", {}, access)).title).toBe("Private");
    expect((await service.publicShareDownload(token, "Docs/a.txt", access)).method).toBe("GET");
    expect((await service.publicShareArchive(token, access)).method).toBe("POST");
    await expect(service.publicShare(inboxToken, "inbox", {}, access)).rejects.toMatchObject(denied);
    const inboxAccess = await service.unlockShare(inboxToken, "inbox", password);
    const opened = await service.publicInboxUpload(
      inboxToken,
      { name: "received.txt", size: 8, idempotencyKey: crypto.randomUUID() },
      inboxAccess,
    );
    expect((await service.publicInboxLease(inboxToken, opened.id, inboxAccess)).url).toContain("renewed");
    const [reservation] = await sql<
      { filegate_session_id: string }[]
    >`SELECT filegate_session_id FROM filesv2.uploads WHERE id=${opened.id}`;
    sessions.get(reservation!.filegate_session_id)!.received = 8;
    expect((await service.publicInboxCommit(inboxToken, opened.id, inboxAccess)).name).toBe("received.txt");
    await service.publicInboxAbort(inboxToken, opened.id, inboxAccess);
    await service.revokeShare(actor, { id: download.id });
    await expect(service.publicShare(token, "download", {}, access)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.unlockShare(token, "download", password)).rejects.toMatchObject({ code: "not_found" });
    await sql`UPDATE filesv2.shares SET expires_at=now()-interval '1 minute' WHERE id=${inbox.id}::uuid`;
    await expect(service.publicShare(inboxToken, "inbox", {}, inboxAccess)).rejects.toMatchObject({ code: "not_found" });
  });
  test("shares stay inside one base, are private to their owner, and serve leases only while active", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Docs");
    directory("freeipa", "users/alice/Docs/a.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/Docs/Sub");
    directory("freeipa", "users/alice/Docs/Sub/b.txt", 1001, 2001, "0640", false);
    directory("freeipa", "users/alice/trash");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const share = await service.createShare(actor, {
      baseId,
      kind: "download",
      paths: ["Docs/a.txt", "Docs/Sub/b.txt"],
      folder: "",
      title: "Q3",
      expiresIn: "7d",
    });
    expect(share).toMatchObject({
      kind: "download",
      scope: "Docs",
      items: ["Docs/a.txt", "Docs/Sub/b.txt"],
      state: "active",
      createdBy: "alice",
    });
    expect(share.url).toMatch(/^https:\/\/cloud\.test\/share\/filesv2\/s\/[A-Za-z0-9_-]{32}$/);
    await expect(
      service.createShare(actor, { baseId, kind: "download", paths: ["trash/x"], folder: "", title: "t", expiresIn: "1d" }),
    ).rejects.toMatchObject({ code: "reserved_path" });
    const token = share.url!.split("/").at(-1)!;
    const view = await service.publicShare(token, "download");
    expect(view.items.map((item) => item.path)).toEqual(["Docs/a.txt", "Docs/Sub/b.txt"]);
    expect((await service.publicShareDownload(token, "Docs/a.txt")).method).toBe("GET");
    await expect(service.publicShareDownload(token, "Docs/Sub")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.publicShare(token, "inbox")).rejects.toMatchObject({ code: "not_found" });
    expect((await service.publicShareArchive(token)).manifest).toBe("signed");
    expect((await service.listShares(actor)).items.map((item) => item.id)).toEqual([share.id]);
    // Another member without read rights on the scope does not see the share.
    const bob = await user("bob", "ipa");
    await sql`UPDATE auth.user_posix SET uid_number=1002 WHERE user_id=${id(bob)}::uuid`;
    directory("freeipa", "users/bob");
    expect((await service.listShares(bob)).items).toEqual([]);
    await expect(service.revokeShare(bob, { id: share.id })).rejects.toMatchObject({ code: "not_found" });
    const revoked = await service.revokeShare(actor, { id: share.id });
    expect(revoked.state).toBe("revoked");
    await expect(service.publicShare(token, "download")).rejects.toMatchObject({ code: "not_found" });
    expect((await service.listShares(actor)).items[0]?.accessCount).toBe(3);
  });
  test("an upload inbox accepts anonymous sessions into its folder without replacing existing files", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/Inbox");
    directory("freeipa", "users/alice/Inbox/report.pdf", 1001, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const inbox = await service.createShare(actor, { baseId, kind: "inbox", paths: [], folder: "Inbox", title: "Drop", expiresIn: "30d" });
    expect(inbox).toMatchObject({ kind: "inbox", scope: "Inbox", items: [] });
    const token = inbox.url!.split("/").at(-1)!;
    expect((await service.publicShare(token, "inbox")).title).toBe("Drop");
    const opened = await service.publicInboxUpload(token, { idempotencyKey: crypto.randomUUID(), name: "report.pdf", size: 8 });
    expect(opened.path).toBe("Inbox/report.pdf");
    const [reservation] = await sql<
      { filegate_session_id: string }[]
    >`SELECT filegate_session_id FROM filesv2.uploads WHERE id=${opened.id}`;
    const filegateId = reservation!.filegate_session_id;
    expect(sessions.get(filegateId)?.ownership).toEqual({ uid: 1001, gid: 2001, mode: "0600" });
    await expect(service.publicInboxUpload(token, { idempotencyKey: crypto.randomUUID(), name: "../x", size: 1 })).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(service.publicInboxUpload(token, { idempotencyKey: crypto.randomUUID(), name: "sub/x", size: 1 })).rejects.toMatchObject({
      code: "invalid_path",
    });
    sessions.get(filegateId)!.received = 8;
    expect((await service.publicInboxLease(token, opened.id)).url).toContain("renewed");
    const committed = await service.publicInboxCommit(token, opened.id);
    expect(committed.name).toBe("report-01.pdf");
    expect(nodes.has("freeipa:users/alice/Inbox/report.pdf") && nodes.has("freeipa:users/alice/Inbox/report-01.pdf")).toBeTrue();
    await expect(service.publicInboxCommit("x".repeat(32), opened.id)).rejects.toMatchObject({ code: "not_found" });
    await service.revokeShare(actor, { id: inbox.id });
    await expect(
      service.publicInboxUpload(token, { idempotencyKey: crypto.randomUUID(), name: "late.txt", size: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  test("detail and thumbnails enforce current leaf rights, traversal and trash before any lease", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/photo.png", 1001, 2001, "0640", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    expect((await service.entry(actor, { baseId, path: "photo.png" })).entry.name).toBe("photo.png");
    expect((await service.thumbnail(actor, { baseId, path: "photo.png", size: "small" })).method).toBe("GET");
    expect(leases).toBe(1);
    directory("freeipa", "users/alice/photo.png", 999, 999, "0600", false);
    await expect(service.entry(actor, { baseId, path: "photo.png" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.thumbnail(actor, { baseId, path: "photo.png", size: "large" })).rejects.toMatchObject({ code: "forbidden" });
    for (const path of ["trash/photo.png", "../other", ""]) {
      await expect(service.entry(actor, { baseId, path })).rejects.toThrow();
      await expect(service.thumbnail(actor, { baseId, path, size: "small" })).rejects.toThrow();
    }
    expect(leases).toBe(1);
  });
  test("scoped metadata enforces ancestor traversal while leaf checks stay constant with depth", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/top.txt", 1001, 2001, "0600", false);
    for (const path of ["deep", "deep/one", "deep/one/two", "deep/one/two/three"]) directory("freeipa", `users/alice/${path}`);
    const deep = "deep/one/two/three/file.txt";
    directory("freeipa", `users/alice/${deep}`, 1001, 2001, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    scopedMetadata.length = 0;
    await service.download(actor, { baseId, path: "top.txt" });
    const shallowCalls = scopedMetadata.length;
    scopedMetadata.length = 0;
    await service.download(actor, { baseId, path: deep });
    expect(scopedMetadata.length).toBe(shallowCalls);
    expect(scopedMetadata.filter((call) => call.operation === "acl")).toEqual([{ operation: "acl", path: `users/alice/${deep}` }]);
    directory("freeipa", "users/alice/deep/one", 1001, 2001, "0600");
    const before = leases;
    await expect(service.download(actor, { baseId, path: deep })).rejects.toMatchObject({ status: 403 });
    await expect(service.entry(actor, { baseId, path: "deep/one/missing.txt" })).rejects.toMatchObject({ status: 403 });
    expect(leases).toBe(before);
    directory("freeipa", ".", 0, 0, "0700");
    expect((await service.bases(actor)).items[0]).toMatchObject({ status: "conflict", reason: "forbidden" });
  });
  test("Cloud adoption remains stable after POSIX allocation, provider off/on, and hides top-level trash", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/admin", 99, 99);
    directory("cloud", "users/admin/trash", 99, 99);
    directory("cloud", "users/admin/report", 99, 99, "0600", false);
    expect((await service.bases(admin)).items[0]?.status).toBe("unassigned");
    const base = await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(admin) });
    await sql`INSERT INTO auth.user_posix VALUES(${id(admin)},'local',200001,200001)`;
    await set("freeipa.enable", false);
    expect((await service.list(admin, { baseId: base.id })).items.map((item) => item.name)).toEqual(["report"]);
    await expect(service.download(admin, { baseId: base.id, path: "trash/report" })).rejects.toMatchObject({ code: "reserved_path" });
    await expect(service.download(admin, { baseId: base.id, path: "../other" })).rejects.toMatchObject({ code: "invalid_path" });
    config.cloud.enabled = false;
    await expect(service.list(admin, { baseId: base.id })).rejects.toMatchObject({ code: "area_disabled" });
    config.cloud.enabled = true;
    expect((await service.download(admin, { baseId: base.id, path: "report" })).method).toBe("GET");
  });
  test("retained claim denies a reused username and concurrent identity claims cannot take over coordinates", async () => {
    const first = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    await service.bases(first);
    await sql`DELETE FROM auth.users WHERE id=${id(first)}::uuid`;
    const second = await user("alice", "ipa");
    expect((await service.bases(second)).items[0]?.reason).toBe("binding_conflict");
    const a = {
      area: "cloud" as const,
      kind: "groups" as const,
      identity_id: crypto.randomUUID(),
      identity_name: "team",
      root: "cloud",
      path: "groups/team",
      uid_number: null,
      gid_number: 200003,
    };
    const b = { ...a, identity_id: crypto.randomUUID() };
    await Promise.all([bindings.claim(a), bindings.claim(b)]);
    const rows = await sql`SELECT * FROM filesv2.bases WHERE root='cloud' AND path='groups/team'`;
    expect(rows).toHaveLength(1);
    expect([a.identity_id, b.identity_id]).toContain(rows[0].identity_id);
  });
  test("guest and global Cloud prerequisite denial occurs before leases", async () => {
    const guest = await user("guest", "local", false, "guest");
    await expect(service.bases(guest)).rejects.toMatchObject({ code: "forbidden" });
    const actor = await user("alice");
    await set(
      "linux.identity_config",
      JSON.stringify({ enabled: false, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" }),
    );
    expect((await service.bases(actor)).issues).toContainEqual({ area: "cloud", code: "local_linux_disabled" });
    expect(leases).toBe(0);
  });
  test("admin inventory preserves unknown totals, marks ineligible folders, and never returns token", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "groups/logical", 99, 99);
    await sql`INSERT INTO auth.groups(name,provider,gid_number) VALUES('logical','local',NULL)`;
    const result = await service.admin(admin, { area: "cloud", kind: "groups", after: "fs:" });
    expect(result.root?.bytes).toBeNull();
    expect(result.items[0]?.reason).toBe("identity_ineligible");
    expect(JSON.stringify(result)).not.toContain("backend-test-secret");
    expect("token" in result.configuration).toBeFalse();
  });
  test("summary reads skip directory reconciliation and retain unknown root statistics", async () => {
    const admin = await user("admin", "local", true);
    const result = await service.admin(admin, { area: "freeipa", kind: "users", includeEntries: "false" });
    expect(result.items).toEqual([]);
    expect(result.next).toBeNull();
    expect(result.root?.bytes).toBeNull();
    expect(reconciliations).toBe(0);
  });
  test("slow FreeIPA inventory returns unknown with a continuation instead of waiting for the upstream timeout", async () => {
    const admin = await user("admin", "local", true);
    await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const slowService = createFilesService({
      identities: {
        ...accountIdentities,
        async reconcile(_actor, input) {
          if (!input.signal) throw new Error("Inventory must supply its cancellation signal");
          await new Promise<void>((resolve) => {
            if (input.signal!.aborted) resolve();
            else input.signal!.addEventListener("abort", () => resolve(), { once: true });
          });
          return { state: "unknown", reason: "provider_unavailable" };
        },
      },
      bindings,
      readConfiguration: async () => config,
      writeConfiguration: async () => {
        throw new Error("Unexpected configuration write");
      },
      publicOrigin: async () => "https://cloud.test",
      userById: async (id: string) => users.get(id) ?? null,
      transfer: transport,
      connect: (configuration) =>
        new Filegate({ baseUrl: configuration.url, transferBaseUrl: configuration.url, token: configuration.token, fetch: transport }),
    });
    const result = await slowService.admin(admin, { area: "freeipa", kind: "users" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: "alice",
      status: "unknown",
      reason: "identity_unknown",
      actions: { create: false, archive: false, delete: false },
    });
    expect(result.next).not.toBeNull();
    expect(nodes.has("freeipa:users/alice")).toBeTrue();
  }, 10_000);
  test("filtered inventory finds identities beyond the first source page", async () => {
    const admin = await user("admin", "local", true);
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin)
      SELECT ('10000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'other-'||i,'local','user',false FROM generate_series(1,60) AS i`;
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin)
      VALUES('ffffffff-ffff-4fff-bfff-fffffffffffe','needle','local','user',false)`;
    const result = await service.admin(admin, { area: "cloud", kind: "users", q: "needle", status: "missing" });
    expect(result.items.map((item) => item.name)).toEqual(["needle"]);
    expect(result.next).toBeNull();
  });
  test("inventory cursors resume partial filesystem pages without losing or duplicating entries", async () => {
    const admin = await user("admin", "local", true);
    for (let i = 0; i < 24; i++) await user(`known-${i}`);
    for (let i = 0; i < 70; i++) directory("cloud", `users/orphan-${String(i).padStart(3, "0")}`);
    const names: string[] = [];
    let after: string | undefined;
    let partialFilesystemPage = false;
    for (let pages = 0; pages < 10; pages++) {
      const page = await service.admin(admin, { area: "cloud", kind: "users", after });
      expect(page.items.length).toBeLessThanOrEqual(50);
      names.push(...page.items.map((item) => item.name));
      if (page.next?.startsWith("fs:") && page.next !== "fs:") {
        const [, offset] = JSON.parse(Buffer.from(page.next.slice(3), "base64url").toString());
        partialFilesystemPage ||= offset > 0;
      }
      after = page.next ?? undefined;
      if (!after) break;
    }
    expect(after).toBeUndefined();
    expect(partialFilesystemPage).toBeTrue();
    expect(names).toHaveLength(95);
    expect(new Set(names).size).toBe(95);
  }, 30_000);
  test("IPA user can read an adopted local POSIX group but loses it immediately when membership is removed", async () => {
    const actor = await user("alice", "ipa");
    const admin = await user("admin", "local", true);
    directory("freeipa", "users/alice");
    directory("cloud", "groups/team", 99, 99);
    directory("cloud", "groups/team/file", 99, 99, "0600", false);
    const [group] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups(name,provider,gid_number) VALUES('team','local',200003) RETURNING id`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${id(actor)},${group!.id})`;
    const base = await service.adopt(admin, { area: "cloud", kind: "groups", identityId: group!.id });
    expect((await service.download(actor, { baseId: base.id, path: "file" })).method).toBe("GET");
    await sql`DELETE FROM auth.user_groups_v2`;
    await expect(service.download(actor, { baseId: base.id, path: "file" })).rejects.toMatchObject({ code: "not_found" });
  });
  test("auto provision is opt-in and retire prevents silent recreation", async () => {
    const admin = await user("admin", "local", true);
    expect((await service.bases(admin)).items[0]?.status).toBe("missing");
    config.cloud.autoCreate = true;
    expect((await service.bases(admin)).items[0]?.status).toBe("existing");
    expect(nodes.get("cloud:users/admin")?.mode).toBe("0700");
    await service.retire(admin, { area: "cloud", kind: "users", name: "admin" });
    nodes.delete("cloud:users/admin");
    expect((await service.bases(admin)).items[0]?.status).toBe("retired");
    expect(nodes.has("cloud:users/admin")).toBeFalse();
  });
  test("archive journal survives lost move response, restores without changing ownership and forbids old-name reuse", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/admin", 0, 0, "0700");
    directory("cloud", "users/admin/file", 0, 0, "0600", false);
    await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(admin) });
    lostMoveResponse = true;
    const archived = await service.archive(admin, { area: "cloud", kind: "users", name: "admin" });
    expect(archived.state).toBe("complete");
    expect(nodes.has("cloud:users/admin")).toBeFalse();
    const [journal] = await sql<{ snapshot: Node }[]>`SELECT snapshot FROM filesv2.operations WHERE id=${archived.id}::uuid`;
    expect(journal!.snapshot.uid).toBe(0);
    const archive = await service.archives(admin, { area: "cloud" });
    expect(archive.items[0]?.state).toBe("archived");
    await service.adminDelete(admin, { area: "cloud", archiveId: archived.id, path: "file", confirmPath: archived.path + "/file" });
    const [base] = await sql<{ lifecycle: string }[]>`SELECT lifecycle FROM filesv2.bases WHERE identity_id=${id(admin)}::uuid`;
    expect(base?.lifecycle).toBe("archived");
    await service.restore(admin, archived.id, { confirmPath: "users/admin" });
    expect(nodes.get("cloud:users/admin")?.mode).toBe("0700");
    expect((await service.bases(admin)).items[0]?.status).toBe("existing");
  });
  test("maintenance archives only proven removed users and explicit logical groups, never guest conversion or renamed identity", async () => {
    const admin = await user("admin", "local", true);
    const removed = await user("removed");
    const guest = await user("guest");
    const renamed = await user("renamed");
    for (const [name, actor] of [
      ["removed", removed],
      ["guest", guest],
      ["renamed", renamed],
    ] as const) {
      directory("cloud", `users/${name}`, 0, 0, "0700");
      await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(actor) });
    }
    await sql`DELETE FROM auth.users WHERE id=${id(removed)}::uuid`;
    await sql`UPDATE auth.users SET profile='guest' WHERE id=${id(guest)}::uuid`;
    await sql`UPDATE auth.users SET uid='new-name' WHERE id=${id(renamed)}::uuid`;
    const totals = await service.maintain();
    expect(totals.archived).toBe(1);
    expect(nodes.has("cloud:users/removed")).toBeFalse();
    expect(nodes.has("cloud:users/guest")).toBeTrue();
    expect(nodes.has("cloud:users/renamed")).toBeTrue();
  });
  test("permanent deletion requires exact confirmation and service admin authorization", async () => {
    const admin = await user("admin", "local", true);
    const actor = await user("alice");
    directory("cloud", "users/alice", 0, 0, "0700");
    await expect(
      service.deleteDirectory(actor, { area: "cloud", kind: "users", name: "alice", confirmPath: "users/alice" }),
    ).rejects.toMatchObject({ code: "admin_required" });
    await expect(
      service.deleteDirectory(admin, { area: "cloud", kind: "users", name: "alice", confirmPath: "alice" }),
    ).rejects.toMatchObject({ code: "confirmation_mismatch" });
    await service.deleteDirectory(admin, { area: "cloud", kind: "users", name: "alice", confirmPath: "users/alice" });
    expect(nodes.has("cloud:users/alice")).toBeFalse();
  });
  test("pending archive recovery refuses recreated source and changed server, then completes durable intent", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/admin", 0, 0, "0700");
    await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(admin) });
    await sql`ALTER TABLE filesv2.operations ADD CONSTRAINT test_pause_finish CHECK (state<>'complete')`.simple();
    try {
      await expect(service.archive(admin, { area: "cloud", kind: "users", name: "admin" })).rejects.toThrow();
    } finally {
      await sql`ALTER TABLE filesv2.operations DROP CONSTRAINT test_pause_finish`.simple();
    }
    const [pending] = await sql<
      { id: string; target: string; state: string }[]
    >`SELECT id,target,state FROM filesv2.operations WHERE action='archive'`;
    expect(pending?.state).toBe("pending");
    expect(nodes.has("cloud:users/admin")).toBeFalse();
    directory("cloud", "users/admin", 0, 0, "0700");
    await expect(service.retry(admin, pending!.id)).rejects.toMatchObject({ code: "path_conflict" });
    expect(nodes.has("cloud:users/admin")).toBeTrue();
    nodes.delete("cloud:users/admin");
    config.url = "http://another-filegate:4000";
    await expect(service.retry(admin, pending!.id)).rejects.toMatchObject({ code: "configuration_changed" });
    config.url = "http://filegate:4000";
    expect((await service.retry(admin, pending!.id)).state).toBe("complete");
    expect((await service.retry(admin, pending!.id)).state).toBe("complete");
  });
  test("per-action archive destinations stay separate from active trees and survive default changes", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/admin", 0, 0, "0700");
    await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(admin) });
    await expect(
      service.archive(admin, { area: "cloud", kind: "users", name: "admin", archivePath: "users/archived" }),
    ).rejects.toMatchObject({ code: "overlapping_paths" });
    const archived = await service.archive(admin, { area: "cloud", kind: "users", name: "admin", archivePath: "retained/2026" });
    expect(archived.path.startsWith("retained/2026/")).toBeTrue();
    config.cloud.archive = "archive-new";
    expect((await service.archives(admin, { area: "cloud" })).items[0]?.canRestore).toBeTrue();
    await service.restore(admin, archived.id, { confirmPath: "users/admin" });
    expect(nodes.has("cloud:users/admin")).toBeTrue();
    config.cloud.archive = "archive";
  });
  test("whole-directory deletion retains known identity before optional auto-provisioning can recreate it", async () => {
    const admin = await user("admin", "local", true);
    const actor = await user("alice");
    directory("cloud", "users/alice", 0, 0, "0700");
    await service.deleteDirectory(admin, { area: "cloud", kind: "users", name: "alice", confirmPath: "users/alice" });
    config.cloud.autoCreate = true;
    expect((await service.bases(actor)).items[0]?.status).toBe("retired");
    expect(nodes.has("cloud:users/alice")).toBeFalse();
    await expect(service.provision(admin, { area: "cloud", kind: "users", identityId: id(actor) })).rejects.toMatchObject({
      code: "retired",
    });
  });
  test("unknown orphan deletion leaves a path tombstone for a later same-name account", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/old-owner", 0, 0, "0700");
    await service.deleteDirectory(admin, { area: "cloud", kind: "users", name: "old-owner", confirmPath: "users/old-owner" });
    const actor = await user("old-owner");
    config.cloud.autoCreate = true;
    expect((await service.bases(actor)).items[0]?.status).toBe("retired");
    await expect(service.provision(admin, { area: "cloud", kind: "users", identityId: id(actor) })).rejects.toMatchObject({
      code: "retired",
    });
    directory("cloud", "users/old-owner", 0, 0, "0700");
    await expect(service.adopt(admin, { area: "cloud", kind: "users", identityId: id(actor) })).rejects.toMatchObject({ code: "retired" });
  });
  test("repeating the original restore action rechecks identity eligibility before replaying a pending move", async () => {
    const admin = await user("admin", "local", true);
    const actor = await user("alice");
    directory("cloud", "users/alice", 0, 0, "0700");
    await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(actor) });
    const archived = await service.archive(admin, { area: "cloud", kind: "users", name: "alice" });
    failMove = true;
    await expect(service.restore(admin, archived.id, { confirmPath: "users/alice" })).rejects.toThrow();
    await sql`UPDATE auth.users SET profile='guest' WHERE id=${id(actor)}::uuid`;
    await expect(service.restore(admin, archived.id, { confirmPath: "users/alice" })).rejects.toMatchObject({
      code: "identity_incomplete",
    });
    expect(nodes.has("cloud:users/alice")).toBeFalse();
    expect(nodes.has(`cloud:${archived.path}`)).toBeTrue();
  });
  test("upload renewal and commit recheck a newly unwritable FreeIPA leaf", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/report.txt", 1001, 2001, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const upload = await service.upload(actor, {
      idempotencyKey: crypto.randomUUID(),
      baseId,
      path: "report.txt",
      size: 12,
      onConflict: "overwrite",
    });
    privateSession(upload.id)!.received = 12;
    directory("freeipa", "users/alice/report.txt", 9999, 9999, "0600", false);
    await expect(service.uploadLease(actor, { baseId, id: upload.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.commitUpload(actor, { baseId, id: upload.id })).rejects.toMatchObject({ code: "forbidden" });
    expect(privateSession(upload.id)!.state).toBe("open");
  });
  test("upload commits reject mismatched receipts and preserve unknown terminal outcomes", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const upload = await service.upload(actor, {
      idempotencyKey: crypto.randomUUID(),
      baseId,
      path: "new.txt",
      size: 12,
      onConflict: "error",
    });
    const session = privateSession(upload.id)!;
    session.received = 12;
    session.path = "users/another/new.txt";
    await expect(service.commitUpload(actor, { baseId, id: upload.id })).rejects.toMatchObject({ code: "upload_changed" });
    session.path = "users/alice/new.txt";
    session.state = "committed";
    await expect(service.commitUpload(actor, { baseId, id: upload.id })).rejects.toMatchObject({ code: "upload_changed" });
    expect((await sql`SELECT state FROM filesv2.uploads WHERE id=${upload.id}`)[0]!.state).toBe("open");
    session.result = directory("freeipa", "users/another/new.txt", 1001, 2001, "0600", false);
    await expect(service.commitUpload(actor, { baseId, id: upload.id })).rejects.toMatchObject({ code: "upload_changed" });
    expect((await sql`SELECT state FROM filesv2.uploads WHERE id=${upload.id}`)[0]!.state).toBe("open");
  });
  test("abort recovery validates committed receipts and preserves expired state", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const baseId = (await service.bases(actor)).items[0]!.id;
    const upload = await service.upload(actor, {
      idempotencyKey: crypto.randomUUID(),
      baseId,
      path: "new.txt",
      size: 12,
      onConflict: "error",
    });
    const session = privateSession(upload.id)!;
    session.state = "committed";
    session.result = directory("freeipa", "users/another/new.txt", 1001, 2001, "0600", false);
    await expect(service.abortUpload(actor, { baseId, id: upload.id })).rejects.toMatchObject({ code: "upload_changed" });
    expect((await sql`SELECT state FROM filesv2.uploads WHERE id=${upload.id}`)[0]!.state).toBe("open");
    session.result = directory("freeipa", "users/alice/new.txt", 1001, 2001, "0600", false);
    await expect(service.abortUpload(actor, { baseId, id: upload.id })).rejects.toMatchObject({ code: "upload_closed" });
    expect((await sql`SELECT state FROM filesv2.uploads WHERE id=${upload.id}`)[0]!.state).toBe("committed");
    const expired = await service.upload(actor, {
      idempotencyKey: crypto.randomUUID(),
      baseId,
      path: "expired.txt",
      size: 12,
      onConflict: "error",
    });
    privateSession(expired.id)!.state = "expired";
    await service.abortUpload(actor, { baseId, id: expired.id });
    expect((await sql`SELECT state FROM filesv2.uploads WHERE id=${expired.id}`)[0]!.state).toBe("expired");
  });
  test("long resource references persist complete paths without bypassing current rights", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    const segments = ["a".repeat(180), "b".repeat(180), "report.txt"];
    directory("freeipa", `users/alice/${segments[0]}`);
    directory("freeipa", `users/alice/${segments.slice(0, 2).join("/")}`);
    const path = segments.join("/");
    directory("freeipa", `users/alice/${path}`, 1001, 2001, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    const result = await service.entry(actor, { baseId, path });
    expect(result.resourceId).toStartWith("p:");
    expect(await resolveEntryRefId(result.resourceId!)).toEqual({ baseId, path });
    expect((await service.entry(actor, { baseId, path })).resourceId).toBe(result.resourceId);
    directory("freeipa", `users/alice/${path}`, 9999, 9999, "0600", false);
    await expect(service.entry(actor, (await resolveEntryRefId(result.resourceId!))!)).rejects.toMatchObject({ code: "forbidden" });
  });
  test("marks use live metadata, hide unreadable leaves and allow removal of missing entries", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/report.txt", 1001, 2001, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    await service.setFavorite(actor, { baseId, path: "report.txt", favorite: true });
    expect((await service.favorites(actor))[0]!.entry.size).toBe(12);
    directory("freeipa", "users/alice/report.txt", 9999, 9999, "0600", false);
    expect(await service.favorites(actor)).toEqual([]);
    nodes.delete("freeipa:users/alice/report.txt");
    await service.setFavorite(actor, { baseId, path: "report.txt", favorite: false });
    expect((await sql`SELECT * FROM filesv2.favorites`).length).toBe(0);
  });
  test("mark cleanup treats percent and underscore as literal path segments", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    for (const name of ["a%_", "abX", "a%_extra"]) {
      directory("freeipa", `users/alice/${name}`);
      directory("freeipa", `users/alice/${name}/child`, 1001, 2001, "0600", false);
    }
    const baseId = (await service.bases(actor)).items[0]!.id;
    for (const path of ["a%_/child", "abX/child", "a%_extra/child"]) await service.setFavorite(actor, { baseId, path, favorite: true });
    await service.rename(actor, { baseId, path: "a%_", name: "renamed" });
    expect((await sql<{ path: string }[]>`SELECT path FROM filesv2.favorites ORDER BY path`).map((row) => row.path)).toEqual([
      "a%_extra/child",
      "abX/child",
    ]);
  });
  test("a writable file never grants permanent version deletion to a regular user", async () => {
    const actor = await user("alice", "ipa");
    directory("freeipa", "users/alice");
    directory("freeipa", "users/alice/report.txt", 1001, 2001, "0600", false);
    const baseId = (await service.bases(actor)).items[0]!.id;
    await expect(service.deleteVersion(actor, { baseId, path: "report.txt", id: "any" })).rejects.toMatchObject({ code: "admin_required" });
  });

  test("an unexpected pending native archive receipt never finalizes its durable intent", async () => {
    const admin = await user("admin", "local", true);
    directory("cloud", "users/admin", 0, 0, "0700");
    await service.adopt(admin, { area: "cloud", kind: "users", identityId: id(admin) });
    contents.set("__transfer_response_state__", "source_pending");
    await expect(service.archive(admin, { area: "cloud", kind: "users", name: "admin" })).rejects.toMatchObject({
      code: "transfer_pending",
    });
    const [pending] = await sql<
      { id: string; state: string; error_code: string }[]
    >`SELECT id,state,error_code FROM filesv2.operations WHERE action='archive'`;
    expect(pending).toMatchObject({ state: "pending", error_code: "transfer_pending" });
    contents.delete("__transfer_response_state__");
    await expect(service.retry(admin, pending!.id)).rejects.toMatchObject({ code: "transfer_pending" });
    const [retained] = await sql<{ state: string }[]>`SELECT state FROM filesv2.operations WHERE id=${pending!.id}::uuid`;
    expect(retained?.state).toBe("pending");
  });

  const editorFixture = async (provider: "local" | "ipa") => {
    const actor = await user("writer", provider, provider === "local");
    const root = provider === "local" ? "cloud" : "freeipa";
    const uid = provider === "local" ? 0 : 1001;
    const gid = provider === "local" ? 0 : 2001;
    directory(root, "users/writer", uid, gid, "0700");
    if (provider === "local") await service.adopt(actor, { area: "cloud", kind: "users", identityId: id(actor) });
    const path = "users/writer/Minutes.odt";
    directory(root, path, uid, gid, "0600", false);
    contents.set(`${root}:${path}`, "original");
    config.collabora = {
      url: "http://localhost:9980",
      internalUrl: "http://collabora:9980",
      wopiOrigin: "http://gateway:3000",
      documentFormat: "odf",
    };
    const baseId = (await service.bases(actor)).items[0]!.id;
    const launch = await service.editor(actor, { baseId, path: "Minutes.odt" });
    if (launch.kind === "markdown") throw new Error("Expected office editor");
    const fileId = decodeURIComponent(launch.action.split("WOPISrc=")[1]!).split("/").at(-1)!;
    return { actor, root, uid, gid, path, baseId, launch, fileId, key: `${root}:${path}` };
  };
  test("WOPI rejects sub-millisecond stale saves before reading and preserves explicit overwrite", async () => {
    const fixture = await editorFixture("local");
    const node = nodes.get(fixture.key)!;
    node.modified = "2026-09-20T10:00:00.123457789Z";
    expect((await service.editorFileInfo(fixture.launch.token, fixture.fileId)).LastModifiedTime).toBe("2026-09-20T10:00:00.123457Z");
    let reads = 0;
    for (const timestamp of ["2026-09-20T10:00:00.123456Z", "", "invalid"]) {
      expect(
        await service.editorSave(fixture.launch.token, fixture.fileId, {
          timestamp,
          read: async () => {
            reads++;
            return new Blob(["stale"]);
          },
        }),
      ).toEqual({ conflict: true });
    }
    expect(reads).toBe(0);
    expect(contents.get(fixture.key)).toBe("original");
    const saved = await service.editorSave(fixture.launch.token, fixture.fileId, {
      timestamp: null,
      read: async () => new Blob(["explicit overwrite"]),
    });
    expect(saved).toHaveProperty("modified");
    expect(contents.get(fixture.key)).toBe("explicit overwrite");
    nodes.get(fixture.key)!.modified = "invalid";
    await expect(service.editorFileInfo(fixture.launch.token, fixture.fileId)).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      service.editorSave(fixture.launch.token, fixture.fileId, {
        timestamp: "",
        read: async () => {
          reads++;
          return new Blob(["invalid"]);
        },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(reads).toBe(0);
  });

  test("Cloud publications respect the shared root lock, release on failure, and retry safely", async () => {
    const { withRootLock } = await import("../data/operations");
    const fixture = await editorFixture("ipa");
    const timestamp = (await service.editorFileInfo(fixture.launch.token, fixture.fileId)).LastModifiedTime;
    const upload = await service.upload(fixture.actor, {
      baseId: fixture.baseId,
      path: "Minutes.odt",
      size: 0,
      onConflict: "overwrite",
      idempotencyKey: crypto.randomUUID(),
    });
    await withRootLock(fixture.root, async () => {
      await expect(
        service.editorSave(fixture.launch.token, fixture.fileId, { timestamp, read: async () => new Blob(["busy"]) }),
      ).rejects.toMatchObject({ code: "operation_busy", status: 503 });
      await expect(service.commitUpload(fixture.actor, { baseId: fixture.baseId, id: upload.id })).rejects.toMatchObject({
        code: "operation_busy",
        status: 503,
      });
      await expect(service.rename(fixture.actor, { baseId: fixture.baseId, path: "Minutes.odt", name: "Moved.odt" })).rejects.toMatchObject(
        { code: "operation_busy", status: 503 },
      );
      expect(contents.get(fixture.key)).toBe("original");
    });
    expect(
      await service.editorSave(fixture.launch.token, fixture.fileId, { timestamp, read: async () => new Blob(["retried"]) }),
    ).toHaveProperty("modified");
    expect(contents.get(fixture.key)).toBe("retried");
  });

  test("managed WOPI saves reject a concurrent write while reading the incoming document", async () => {
    const fixture = await editorFixture("local");
    const originalRevision = nodes.get(fixture.key)!.revision;
    const result = await service.editorSave(fixture.launch.token, fixture.fileId, {
      timestamp: null,
      read: async () => {
        directory(fixture.root, fixture.path, fixture.uid, fixture.gid, "0600", false);
        contents.set(fixture.key, "concurrent document");
        return new Blob(["stale document"]);
      },
    });
    expect(result).toEqual({ conflict: true });
    expect(contents.get(fixture.key)).toBe("concurrent document");
    expect(directRequests).toHaveLength(0);
    expect(nodes.get(fixture.key)!.revision).not.toBe(originalRevision);
  });
  test("managed WOPI conditions remain bound between lease issuance and direct publication", async () => {
    const fixture = await editorFixture("local");
    const originalRevision = nodes.get(fixture.key)!.revision;
    beforeDirectPublish = () => {
      directory(fixture.root, fixture.path, fixture.uid, fixture.gid, "0600", false);
      contents.set(fixture.key, "later writer");
    };
    const result = await service.editorSave(fixture.launch.token, fixture.fileId, {
      timestamp: null,
      read: async () => new Blob(["earlier writer"]),
    });
    expect(result).toEqual({ conflict: true });
    expect(contents.get(fixture.key)).toBe("later writer");
    expect(directRequests.at(-1)?.precondition).toEqual({ ifMatch: originalRevision });
  });
  test("managed template creation binds ifNoneMatch and preserves a concurrently created target", async () => {
    const fixture = await editorFixture("local");
    const target = "users/writer/New.odt";
    beforeDirectPublish = () => {
      directory("cloud", target, 777, 778, "0640", false);
      contents.set(`cloud:${target}`, "created by another writer");
    };
    await expect(service.createDocument(fixture.actor, { baseId: fixture.baseId, path: "New", kind: "text" })).rejects.toMatchObject({
      status: 412,
    });
    expect(directRequests.at(-1)?.precondition).toEqual({ ifNoneMatch: true });
    expect(contents.get(`cloud:${target}`)).toBe("created by another writer");
    expect(nodes.get(`cloud:${target}`)).toMatchObject({ uid: 777, gid: 778, mode: "0640" });
  });
  test("unmanaged WOPI saves recheck observed state after reading without claiming a publish condition", async () => {
    const fixture = await editorFixture("ipa");
    const conflicted = await service.editorSave(fixture.launch.token, fixture.fileId, {
      timestamp: null,
      read: async () => {
        directory(fixture.root, fixture.path, fixture.uid, fixture.gid, "0600", false);
        contents.set(fixture.key, "external NFS write");
        return new Blob(["stale editor write"]);
      },
    });
    expect(conflicted).toEqual({ conflict: true });
    expect(contents.get(fixture.key)).toBe("external NFS write");
    expect(directRequests).toHaveLength(0);
    const saved = await service.editorSave(fixture.launch.token, fixture.fileId, {
      timestamp: null,
      read: async () => new Blob(["fresh editor write"]),
    });
    expect(saved).toMatchObject({ modified: expect.any(String) });
    expect(contents.get(fixture.key)).toBe("fresh editor write");
    expect(directRequests.at(-1)?.precondition).toBeUndefined();
  });

  test("Markdown opens without Collabora and conditional uploads reject stale drafts and changed retry intent", async () => {
    const actor = await user("markdown", "local", true);
    directory("cloud", "users/markdown");
    await service.adopt(actor, { area: "cloud", kind: "users", identityId: id(actor) });
    const baseId = (await service.bases(actor)).items[0]!.id;
    const node = directory("cloud", "users/markdown/notes.md", 0, 0, "0600", false);
    const launch = await service.editor(actor, { baseId, path: "notes.md" });
    expect(launch.kind).toBe("markdown");
    expect(launch.canWrite).toBe(true);
    const key = crypto.randomUUID();
    await expect(
      service.upload(actor, { baseId, path: "notes.md", size: 0, onConflict: "overwrite", idempotencyKey: key, expectedRevision: "old" }),
    ).rejects.toMatchObject({ code: "write_conflict" });
    const opened = await service.upload(actor, {
      baseId,
      path: "notes.md",
      size: 0,
      onConflict: "overwrite",
      idempotencyKey: key,
      expectedRevision: node.revision,
    });
    await expect(
      service.upload(actor, {
        baseId,
        path: "notes.md",
        size: 0,
        onConflict: "overwrite",
        idempotencyKey: key,
        expectedRevision: "changed",
      }),
    ).rejects.toMatchObject({ code: "upload_changed" });
    directory("cloud", "users/markdown/notes.md", 0, 0, "0600", false);
    await expect(service.commitUpload(actor, { baseId, id: opened.id })).rejects.toMatchObject({ code: "write_conflict" });
    expect(privateSession(opened.id).state).toBe("open");
  });
  test("template snapshots and grants are independent of source files and destination permissions", async () => {
    const owner = await user("catalog-admin", "ipa", true);
    await sql`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${id(owner)}::uuid,'admins')`;
    const reader = await user("catalog-reader", "ipa");
    directory("freeipa", "users/catalog-admin");
    directory("freeipa", "users/catalog-reader");
    const sourceBase = (await service.bases(owner)).items[0]!.id;
    const targetBase = (await service.bases(reader)).items[0]!.id;
    directory("freeipa", "users/catalog-admin/protocol.md", 1001, 2001, "0600", false);
    contents.set("freeipa:users/catalog-admin/protocol.md", "original template");
    const templates = createTemplateService(service);
    const subject = { type: "user" as const, userId: id(reader) };
    const template = await templates.import(owner, {
      name: "Protocol",
      description: "Independent",
      source: { baseId: sourceBase, path: "protocol.md" },
    });
    expect((await templates.list(reader, subject, { q: "" })).items).toHaveLength(0);
    await expect(templates.use(reader, subject, template.id, { baseId: targetBase, path: "copy.md" })).rejects.toMatchObject({
      code: "forbidden",
    });
    const grant = await templates.grant(owner, template.id, { type: "user", userId: id(reader) });
    expect((await templates.list(reader, subject, { q: "pro" })).items.map((x) => x.id)).toEqual([template.id]);
    nodes.delete("freeipa:users/catalog-admin/protocol.md");
    contents.delete("freeipa:users/catalog-admin/protocol.md");
    await templates.use(reader, subject, template.id, { baseId: targetBase, path: "copy.md" });
    expect(contents.get("freeipa:users/catalog-reader/copy.md")).toBe("original template");
    await expect(templates.use(reader, subject, template.id, { baseId: targetBase, path: "copy.md" })).rejects.toMatchObject({
      status: 409,
    });
    await templates.replace(owner, template.id, { filename: "updated.md", content: Buffer.from("updated").toString("base64") });
    expect(contents.get("freeipa:users/catalog-reader/copy.md")).toBe("original template");
    directory("freeipa", "users/catalog-reader/readonly", 999, 2001, "0550");
    await expect(templates.use(reader, subject, template.id, { baseId: targetBase, path: "readonly/denied.md" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await templates.revoke(owner, template.id, grant.id);
    expect((await templates.list(reader, subject, { q: "" })).items).toHaveLength(0);
    await expect(templates.use(reader, subject, template.id, { baseId: targetBase, path: "denied.md" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(templates.upload(reader, { name: "Denied", description: "", filename: "x", content: "" })).rejects.toThrow();
    const [parent] = await sql<{ id: string }[]>`INSERT INTO auth.groups(name,provider) VALUES('catalog-parent','local') RETURNING id`;
    const [child] = await sql<{ id: string }[]>`INSERT INTO auth.groups(name,provider) VALUES('catalog-child','local') RETURNING id`;
    await sql`INSERT INTO auth.group_groups_v2(parent_group_id,child_group_id) VALUES(${parent!.id}::uuid,${child!.id}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2(user_id,group_id) VALUES(${id(reader)}::uuid,${child!.id}::uuid)`;
    await templates.grant(owner, template.id, { type: "group", groupId: parent!.id });
    expect((await templates.list(reader, subject, { q: "" })).items).toHaveLength(1);
    await templates.use(reader, subject, template.id, { baseId: targetBase, path: "nested.md" });
    expect(contents.get("freeipa:users/catalog-reader/nested.md")).toBe("updated");
    await sql`DELETE FROM auth.group_groups_v2 WHERE parent_group_id=${parent!.id}::uuid`;
    await expect(templates.use(reader, subject, template.id, { baseId: targetBase, path: "no-membership.md" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await templates.update(owner, template.id, {
      name: "Renamed",
      description: "Atomic",
      file: { filename: "atomic.md", content: Buffer.from("atomic").toString("base64") },
    });
    expect(await templates.get(owner, { type: "user", userId: id(owner) }, template.id, true)).toMatchObject({
      name: "Renamed",
      filename: "atomic.md",
      size: 6,
    });
    await expect(
      templates.upload(owner, {
        name: "Too large",
        description: "",
        filename: "large.bin",
        content: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "preview_too_large" });
    expect((await templates.list(owner, { type: "user", userId: id(owner) }, { q: "Too large" }, true)).items).toHaveLength(0);
    await templates.remove(owner, template.id);
    expect(contents.get("freeipa:users/catalog-reader/copy.md")).toBe("original template");
  });
});
