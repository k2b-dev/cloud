import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Every case spawns the real CLI one or more times.
setDefaultTimeout(30_000);

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const book = { id: "Book01", name: "Customers", description: null, createdAt: null, updatedAt: null };
const contact = {
  id: "Cont01",
  bookId: "Book01",
  label: "Ada Lovelace",
  firstName: null,
  lastName: null,
  companyName: null,
  jobTitle: null,
  emails: [{ email: "ada@example.org" }],
  phones: [],
  tags: [],
  updatedAt: "2026-09-26T00:00:00.000Z",
};

/** A fake Contacts API that records every request as `METHOD path?query`. */
const fakeApi = (handle: (request: Request, url: URL) => Response | Promise<Response> | undefined) => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      return handle(request, url) ?? new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
};

const runCli = async (server: string, args: string[]) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "../cloud-cli/src/index.ts", "--server", server, "--token", "test-token", ...args],
    cwd: new URL("..", import.meta.url).pathname,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
};

describe("contact addresses", () => {
  const resolving = () =>
    fakeApi((_request, url) => {
      if (url.pathname !== "/api/contacts/resolve") return undefined;
      return Response.json({ book, contact: url.searchParams.has("contact") || url.searchParams.has("email") ? contact : null });
    });

  test("resolves an ID, <book>:<name>, <book>:, and --email through the resolve endpoint", async () => {
    const api = resolving();
    for (const args of [["Cont01"], ["Customers:Ada Lovelace"], ["Book01:Ada Lovelace"], ["--email", "ada@example.org"]]) {
      const result = await runCli(api.url, ["--json", "contacts", "show", ...args]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(contact);
    }
    const shownBook = await runCli(api.url, ["--json", "contacts", "show", "Customers:"]);
    expect(JSON.parse(shownBook.stdout)).toEqual(book);
    expect(api.requests).toEqual([
      "GET /api/contacts/resolve?contact=Cont01",
      "GET /api/contacts/resolve?book=Customers&contact=Ada+Lovelace",
      "GET /api/contacts/resolve?book=Book01&contact=Ada+Lovelace",
      "GET /api/contacts/resolve?email=ada%40example.org",
      "GET /api/contacts/resolve?book=Customers",
    ]);
  });

  test("splits <book>:<name> at the first colon", async () => {
    const api = resolving();
    await runCli(api.url, ["--json", "contacts", "show", "Customers:Dr. Who: The Doctor"]);
    expect(api.requests).toEqual(["GET /api/contacts/resolve?book=Customers&contact=Dr.+Who%3A+The+Doctor"]);
  });

  test("passes the server's ambiguity message through and exits 1", async () => {
    const message =
      '"Ada Lovelace" matches several contacts: Customers:Ada Lovelace (Cont01), Customers:Ada Lovelace (Cont02). Use one of these paths or IDs.';
    const api = fakeApi(() => Response.json({ message, code: "CONFLICT" }, { status: 409 }));
    const result = await runCli(api.url, ["contacts", "show", "Customers:Ada Lovelace"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
  });

  test("rejects local paths and mixed arguments before any request", async () => {
    const api = resolving();
    const local = await runCli(api.url, ["contacts", "show", "./ada.vcf"]);
    expect(local.exitCode).toBe(1);
    expect(local.stderr).toContain("is a local path");
    const both = await runCli(api.url, ["contacts", "show", "Cont01", "--email", "ada@example.org"]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("Pass either a contact or --email");
    const bookAsContact = await runCli(api.url, ["contacts", "set", "Customers:", "--label", "X"]);
    expect(bookAsContact.exitCode).toBe(1);
    expect(bookAsContact.stderr).toContain("is a contact book, not a contact");
    expect(api.requests).toEqual([]);
  });
});

describe("commands", () => {
  test("ls without a book lists books; with a book it lists contacts with resolved tag filters", async () => {
    const api = fakeApi((_request, url) => {
      const page = { page: 1, per_page: 50, total: 1, total_pages: 1, has_next: false };
      if (url.pathname === "/api/contacts/books") return Response.json({ data: [book], pagination: page });
      if (url.pathname === "/api/contacts/resolve") return Response.json({ book, contact: null });
      if (url.pathname === "/api/contacts/books/Book01/tags")
        return Response.json([{ id: "Tag001", bookId: "Book01", name: "VIP", color: "#2563eb" }]);
      if (url.pathname === "/api/contacts/books/Book01/contacts")
        return Response.json({ data: [contact], pagination: page, favoriteKeys: [] });
      return undefined;
    });
    const books = await runCli(api.url, ["--json", "contacts", "ls", "--q", "cust"]);
    expect(JSON.parse(books.stdout).data).toEqual([book]);
    const listed = await runCli(api.url, ["--json", "contacts", "ls", "Customers", "--tag", "VIP", "--q", "ada"]);
    expect(Object.keys(JSON.parse(listed.stdout))).toEqual(["book", "data", "pagination"]);
    expect(JSON.parse(listed.stdout).book).toEqual({ id: "Book01", name: "Customers" });
    expect(api.requests).toEqual([
      "GET /api/contacts/books?q=cust",
      "GET /api/contacts/resolve?book=Customers",
      "GET /api/contacts/books/Book01/tags",
      "GET /api/contacts/books/Book01/contacts?q=ada&tag_id=Tag001",
    ]);
  });

  test("add takes the display name from <book>:<name> and sends repeatable fields", async () => {
    let body: unknown;
    const api = fakeApi((request, url) => {
      if (url.pathname === "/api/contacts/resolve") return Response.json({ book, contact: null });
      if (url.pathname === "/api/contacts/books/Book01/contacts" && request.method === "POST")
        return request.json().then((value) => {
          body = value;
          return Response.json(contact);
        });
      return undefined;
    });
    const result = await runCli(api.url, [
      "--json",
      "contacts",
      "add",
      "Customers:Ada Lovelace",
      "--email",
      "work=ada@example.org",
      "--email",
      "ada@home.example",
      "--job-title",
      "Mathematician",
    ]);
    expect(result.exitCode).toBe(0);
    expect(body).toEqual({
      label: "Ada Lovelace",
      jobTitle: "Mathematician",
      emails: [{ label: "work", email: "ada@example.org" }, { email: "ada@home.example" }],
    });
  });

  test("mv resolves the target book and posts its ID", async () => {
    const alumni = { ...book, id: "Book02", name: "Alumni" };
    const api = fakeApi((request, url) => {
      if (url.pathname === "/api/contacts/resolve")
        return Response.json(url.searchParams.get("book") === "Alumni" ? { book: alumni, contact: null } : { book, contact });
      if (url.pathname === "/api/contacts/books/Book01/contacts/Cont01/move")
        return request.json().then((value) => {
          expect(value).toEqual({ targetBookId: "Book02" });
          return Response.json({ ...contact, bookId: "Book02" });
        });
      return undefined;
    });
    const result = await runCli(api.url, ["--json", "contacts", "mv", "Cont01", "Alumni"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).bookId).toBe("Book02");
  });

  test("destructive commands refuse without --yes when nobody can confirm, and report what they deleted", async () => {
    const api = fakeApi((request, url) => {
      if (url.pathname === "/api/contacts/resolve") return Response.json({ book, contact });
      if (request.method === "DELETE" && url.pathname === "/api/contacts/books/Book01/contacts/Cont01")
        return Response.json({ message: "Contact deleted" });
      return undefined;
    });
    for (const args of [
      ["rm", "Cont01"],
      ["books", "delete", "Customers"],
      ["tags", "delete", "Customers:VIP"],
      ["notes", "delete", "Cont01", "Note01"],
    ]) {
      const refused = await runCli(api.url, ["contacts", ...args]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("Pass --yes");
    }
    expect(api.requests).toEqual([]);

    const deleted = await runCli(api.url, ["--json", "contacts", "rm", "Cont01", "--yes"]);
    expect(JSON.parse(deleted.stdout)).toEqual({ deleted: { id: "Cont01", bookId: "Book01", name: "Ada Lovelace" } });
  });

  test("notes take a six-character note ID", async () => {
    const api = fakeApi(() => undefined);
    const result = await runCli(api.url, [
      "contacts",
      "notes",
      "update",
      "Cont01",
      "11111111-1111-4111-8111-111111111111",
      "--content",
      "x",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is not a note ID");
  });

  test("tags address a tag as <book>:<tag>", async () => {
    const api = fakeApi(() => undefined);
    const result = await runCli(api.url, ["contacts", "tags", "update", "VIP", "--color", "#000000"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("<book>:<tag>");
    expect(api.requests).toEqual([]);
  });
});

test("help is complete in English and German", async () => {
  const api = fakeApi(() => undefined);
  const english = await runCli(api.url, ["contacts", "--help"]);
  const german = await runCli(api.url, ["--locale", "de", "contacts", "--help"]);
  for (const name of ["ls", "show", "search", "add", "set", "mv", "rm", "tree", "export", "import", "books", "tags", "notes", "access"]) {
    expect(english.stdout).toMatch(new RegExp(`^  ${name} `, "m"));
    expect(german.stdout).toMatch(new RegExp(`^  ${name} `, "m"));
  }
  expect(german.stdout).toContain("Kontakte per ID oder <buch>:<name> finden");
  const groups = await runCli(api.url, ["--locale", "de", "contacts", "books", "--help"]);
  expect(groups.stdout).toContain("Ein Kontaktbuch anlegen");
});
