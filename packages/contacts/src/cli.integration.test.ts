import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { natsServers, testFor } from "../../../scripts/fixtures/test-infra";

/**
 * The real `cld contacts` CLI against the real Contacts API: ID and
 * `<book>:<name>` addressing, email lookup, ambiguity, and every verb.
 *
 * Runs in a child process: the API module binds its middleware at import time.
 */
if (process.env.CONTACTS_CLI_CHILD !== "1") {
  testFor("database", "nats")(
    "cld contacts addresses contacts by ID, book and name, or email",
    async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, CONTACTS_CLI_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
    },
    240_000,
  );
} else {
  type Book = { id: string; name: string };
  type Contact = {
    id: string;
    bookId: string;
    label: string | null;
    jobTitle: string | null;
    emails: { email: string }[];
    tags: { name: string }[];
  };

  const cliEntry = new URL("../../cloud-cli/src/index.ts", import.meta.url).pathname;
  let home = "";
  let serverUrl = "";
  let cleanup: () => Promise<void> = async () => undefined;

  const cld = async (args: string[], options: { stdin?: string; locale?: string } = {}) => {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        cliEntry,
        "--server",
        serverUrl,
        "--token",
        "cli-test",
        ...(options.locale ? ["--locale", options.locale] : []),
        ...args,
      ],
      cwd: home,
      env: { ...process.env, HOME: home },
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode, stdout, stderr };
  };
  const cldJson = async <T>(args: string[], options?: { stdin?: string }): Promise<T> => {
    const result = await cld(["--json", ...args], options);
    if (result.exitCode !== 0) throw new Error(`cld ${args.join(" ")} failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as T;
  };

  beforeAll(async () => {
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { connect } = await import("@nats-io/transport-node");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const server = await import("@k2b/cloud/server");
    const { oauthTokens } = await import("@k2b/cloud/services");
    spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
    const { migrate } = await import("./migrate");
    const { default: app } = await import("./api");

    const connection = await connect({ servers: natsServers() });
    const namespace = `contacts-cli-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "contacts", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const user: User = {
      id: crypto.randomUUID(),
      uid: `cli-${crypto.randomUUID().slice(0, 8)}`,
      roles: [],
      provider: "local",
      profile: "user",
      givenname: "Cli",
      sn: "Agent",
      displayName: "Cli Agent",
      mail: "cli-agent@example.test",
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    await sync.ready();
    await migrate();
    await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${user.id}::uuid, ${user.uid}, 'local', 'user')`;

    const http = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (!url.pathname.startsWith("/api/contacts")) return new Response("not found", { status: 404 });
        url.pathname = url.pathname.slice("/api/contacts".length) || "/";
        return app.fetch(new Request(url, request));
      },
    });
    serverUrl = `http://127.0.0.1:${http.port}`;
    home = await mkdtemp(join(tmpdir(), "cld-contacts-"));

    cleanup = async () => {
      http.stop(true);
      await sql`
        DELETE FROM contacts.books b
        USING contacts.book_access ba, auth.access a
        WHERE ba.book_id = b.id AND a.id = ba.access_id AND a.user_id = ${user.id}::uuid
      `;
      await sql`DELETE FROM auth.access WHERE user_id = ${user.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
      await rm(home, { recursive: true, force: true });
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    };
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  }, 60_000);

  describe("cld contacts", () => {
    test("runs the customer workflow by book and name, ID, and email", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const customers = await cldJson<Book>(["contacts", "books", "add", `Customers ${suffix}`]);
      const alumni = await cldJson<Book>(["contacts", "books", "add", `Alumni ${suffix}`]);
      const vip = await cldJson<{ id: string; name: string }>(["contacts", "tags", "add", `${customers.name}:VIP`, "--color", "#2563eb"]);
      expect(vip.name).toBe("VIP");

      const ada = await cldJson<Contact>([
        "contacts",
        "add",
        `${customers.name}:Ada Lovelace`,
        "--email",
        `work=ada-${suffix}@example.org`,
        "--tag",
        "VIP",
      ]);
      expect(ada).toMatchObject({ bookId: customers.id, label: "Ada Lovelace", tags: [{ name: "VIP" }] });

      // The same contact by book name, by book ID, by contact ID, and by email.
      for (const address of [`${customers.name}:Ada Lovelace`, `${customers.id}:Ada Lovelace`, ada.id])
        expect((await cldJson<Contact>(["contacts", "show", address])).id).toBe(ada.id);
      expect((await cldJson<Contact>(["contacts", "show", "--email", `ADA-${suffix}@example.org`])).id).toBe(ada.id);
      expect(await cldJson<Book>(["contacts", "show", `${customers.name}:`])).toMatchObject({ id: customers.id, name: customers.name });

      const listed = await cldJson<{ book: Book; data: Contact[] }>(["contacts", "ls", customers.name, "--tag", "VIP", "--q", "ada"]);
      expect(listed.book).toEqual({ id: customers.id, name: customers.name });
      expect(listed.data.map((contact) => contact.id)).toEqual([ada.id]);
      expect((await cldJson<{ data: Book[] }>(["contacts", "ls", "--q", suffix])).data.map((book) => book.id).sort()).toEqual(
        [customers.id, alumni.id].sort(),
      );
      expect((await cldJson<{ data: Contact[] }>(["contacts", "search", "Ada", "Lovelace"])).data.map((contact) => contact.id)).toContain(
        ada.id,
      );

      const updated = await cldJson<Contact>(["contacts", "set", `${customers.name}:Ada Lovelace`, "--job-title", "Mathematician"]);
      expect(updated.jobTitle).toBe("Mathematician");

      // A second contact with the same name and email: every name-based address now refuses to guess.
      const twin = await cldJson<Contact>(["contacts", "add", customers.name, "--from", "-"], {
        stdin: JSON.stringify({ label: "Ada Lovelace", emails: [{ email: `ada-${suffix}@example.org` }] }),
      });
      for (const args of [
        ["contacts", "show", `${customers.name}:Ada Lovelace`],
        ["contacts", "show", "--email", `ada-${suffix}@example.org`],
      ]) {
        const ambiguous = await cld(args);
        expect(ambiguous.exitCode).toBe(1);
        expect(ambiguous.stderr).toContain("matches several contacts");
        expect(ambiguous.stderr).toContain(`(${ada.id})`);
        expect(ambiguous.stderr).toContain(`(${twin.id})`);
      }
      const german = await cld(["contacts", "show", `${customers.name}:Ada Lovelace`], { locale: "de" });
      expect(german.stderr).toContain("passt zu mehreren Kontakten");

      const note = await cldJson<{ id: string; content: string }>(["contacts", "notes", "add", ada.id, "--content", "Met at the archive."]);
      expect((await cldJson<Array<{ id: string }>>(["contacts", "notes", "list", ada.id])).map((item) => item.id)).toEqual([note.id]);
      expect(
        await cldJson<{ content: string }>(["contacts", "notes", "update", ada.id, note.id, "--from", "-"], { stdin: "Changed." }),
      ).toMatchObject({
        content: "Changed.",
      });
      expect(await cldJson<unknown>(["contacts", "notes", "delete", ada.id, note.id, "--yes"])).toEqual({
        deleted: { id: note.id, contactId: ada.id },
      });

      // Book names are not unique either; the book ID always resolves.
      const alumniTwin = await cldJson<Book>(["contacts", "books", "add", alumni.name]);
      const ambiguousBook = await cld(["contacts", "ls", alumni.name]);
      expect(ambiguousBook.exitCode).toBe(1);
      expect(ambiguousBook.stderr).toContain("matches several contact books");
      expect(ambiguousBook.stderr).toContain(`${alumni.name} (${alumniTwin.id})`);
      await cldJson(["contacts", "books", "delete", alumniTwin.id, "--yes"]);
      const missing = await cld(["contacts", "show", `${customers.name}:Nobody`]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain(`No contact in ${customers.name} has the ID or exact name "Nobody".`);

      const moved = await cldJson<Contact>(["contacts", "mv", ada.id, alumni.name]);
      expect(moved.bookId).toBe(alumni.id);
      expect((await cldJson<Contact>(["contacts", "show", `${alumni.name}:Ada Lovelace`])).id).toBe(ada.id);

      const out = join(home, "customers.vcf");
      expect(await cldJson<unknown>(["contacts", "export", customers.name, "--out", out])).toEqual({
        book: { id: customers.id, name: customers.name },
        format: "vcf",
        output: out,
      });
      const vcf = await readFile(out, "utf8");
      expect(vcf).toContain("BEGIN:VCARD");

      await writeFile(
        join(home, "import.vcf"),
        `${vcf}BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Grace Hopper\r\nN:Hopper;Grace;;;\r\nEND:VCARD\r\n`,
      );
      const preview = await cldJson<{ candidates: Array<{ match: unknown }> }>([
        "contacts",
        "import",
        alumni.name,
        "--from",
        "import.vcf",
        "--dry-run",
      ]);
      expect(preview.candidates.length).toBe(2);
      expect(await cldJson<unknown>(["contacts", "import", customers.name, "--from", "import.vcf"])).toEqual({
        book: { id: customers.id, name: customers.name },
        created: 1,
        skipped: 1,
        failures: [],
      });

      const refused = await cld(["contacts", "rm", twin.id]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("--yes");
      expect(await cldJson<unknown>(["contacts", "rm", twin.id, "--yes"])).toEqual({
        deleted: { id: twin.id, bookId: customers.id, name: "Ada Lovelace" },
      });
      expect((await cld(["contacts", "show", twin.id])).exitCode).toBe(1);

      expect(await cldJson<unknown>(["contacts", "tags", "delete", `${customers.name}:VIP`, "--yes"])).toEqual({
        deleted: { id: vip.id, name: "VIP" },
      });
      expect(await cldJson<unknown>(["contacts", "books", "delete", alumni.id, "--yes"])).toEqual({
        deleted: { id: alumni.id, name: alumni.name },
      });
    }, 180_000);
  });
}
