#!/usr/bin/env bun
/**
 * Seed fictional large notebooks into a development Cloud and measure the main
 * notebook paths against them. See `--help`.
 */
import { parseArgs } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { buildFixtureTree, FIXTURE_SHAPES, type FixtureShape, renderFixtureMarkdown } from "./large-notebook-fixture";

export const HELP = `Usage: bun packages/notebooks/scripts/large-notebook.ts <seed|measure> [options]

Seed and measure fictional large notebooks on a development Cloud. Never point
this at a production installation: it signs in with the development
administrator token and writes thousands of pages.

  seed     Create one notebook of the chosen shape and print its ID.
  measure  Time the main paths of one notebook and print a JSON report.

Options:
  --origin <url>     Development Cloud (default http://localhost:3000)
  --token <token>    Development administrator token (default dev-admin)
  --shape <shape>    small (13), medium (1,307) or large (20,000); seed only
  --notebook <id>    Notebook to measure; measure only
  --targets <json>   Pages to open, as printed by seed:
                     {"folder","page","other","linked"}; measure only
  --runs <n>         Samples per path, the median is reported (default 5)
  --concurrency <n>  Parallel page creations while seeding (default 8)
  --help             Show this help
`;

type Options = {
  origin: string;
  token: string;
  shape?: FixtureShape;
  notebook?: string;
  targets?: string;
  runs: number;
  concurrency: number;
};

const parseOptions = (args: string[]): { command: string | undefined; help: boolean; options: Options } => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      origin: { type: "string", default: "http://localhost:3000" },
      token: { type: "string", default: "dev-admin" },
      shape: { type: "string" },
      notebook: { type: "string" },
      targets: { type: "string" },
      runs: { type: "string", default: "5" },
      concurrency: { type: "string", default: "8" },
    },
  });
  if (values.shape !== undefined && !(values.shape in FIXTURE_SHAPES)) throw new Error("--shape must be small, medium or large");
  return {
    command: positionals[0],
    help: values.help ?? false,
    options: {
      origin: values.origin!,
      token: values.token!,
      shape: values.shape as FixtureShape | undefined,
      notebook: values.notebook,
      targets: values.targets,
      runs: Number(values.runs),
      concurrency: Number(values.concurrency),
    },
  };
};

class DevCloud {
  cookie = "";
  constructor(readonly origin: string) {}
  /** The development rate limit applies per second, so a limited request waits and tries again. */
  async fetch(path: string, init: { method?: string; json?: unknown; body?: BodyInit; accept?: string } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.send(path, init);
      if (response.status !== 429 || attempt === 60) return response;
      await response.arrayBuffer();
      await Bun.sleep(Number(response.headers.get("retry-after") ?? 1) * 1000);
    }
  }
  send(path: string, init: { method?: string; json?: unknown; body?: BodyInit; accept?: string }) {
    return fetch(new URL(path, this.origin), {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        ...(init.json === undefined ? {} : { "content-type": "application/json" }),
        accept: init.accept ?? "application/json",
        "accept-language": "en",
        origin: this.origin,
        ...(this.cookie ? { cookie: `session_token=${this.cookie}` } : {}),
      },
      body: init.json === undefined ? init.body : JSON.stringify(init.json),
    });
  }
  async json<T>(path: string, init: Parameters<DevCloud["fetch"]>[1] = {}): Promise<T> {
    const response = await this.fetch(path, init);
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned HTTP ${response.status}`);
    return (await response.json()) as T;
  }
  async login(token: string) {
    const result = await this.json<{ session_token: string }>("/api/auth/admin-login", { method: "POST", json: { token } });
    this.cookie = result.session_token;
    const consent = await this.fetch("/auth/continue", { accept: "text/html" });
    if (consent.status === 200) {
      const version = /name="version"\s+value="([^"]+)"/.exec(await consent.text())?.[1];
      if (version) await this.fetch("/api/auth/legal-consent", { method: "POST", json: { accepted: true, version } });
    }
  }
}

/** A valid 64x40 PNG with a two-colour diagram, built here so the fixture needs no binary file. */
const fixturePng = (): Uint8Array<ArrayBuffer> => {
  const width = 64;
  const height = 40;
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const out = new DataView(new ArrayBuffer(12 + data.length));
    out.setUint32(0, data.length);
    new Uint8Array(out.buffer).set(body, 4);
    out.setUint32(8 + data.length, crc32(body));
    return new Uint8Array(out.buffer);
  };
  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, width);
  header.setUint32(4, height);
  header.setUint8(8, 8);
  header.setUint8(9, 2);
  const rows = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rows.set(x < width / 2 === y < height / 2 ? [37, 99, 235] : [226, 232, 240], y * (1 + width * 3) + 1 + x * 3);
  return new Uint8Array([
    ...[137, 80, 78, 71, 13, 10, 26, 10],
    ...chunk("IHDR", new Uint8Array(header.buffer)),
    ...chunk("IDAT", deflateSync(rows)),
    ...chunk("IEND", new Uint8Array()),
  ]);
};

async function seed(cloud: DevCloud, shape: FixtureShape, concurrency: number) {
  const notes = buildFixtureTree(shape);
  const notebook = await cloud.json<{ id: string }>("/api/notebooks", {
    method: "POST",
    json: { name: `Perf ${shape} (${notes.length} pages)`, welcomeNote: false },
  });
  const form = new FormData();
  form.set("file", new File([fixturePng()], "diagram.png", { type: "image/png" }));
  const image = await cloud.json<{ id: string }>(`/api/notebooks/${notebook.id}/attachments`, { method: "POST", body: form });
  const shortIds: string[] = [];
  const started = performance.now();
  // A batch only refers to parents and link targets from earlier batches.
  for (let start = 0; start < notes.length; start += concurrency) {
    const batch = notes.slice(start, start + concurrency);
    const created = await Promise.all(
      batch.map((note) =>
        cloud.json<{ id: string }>(`/api/notebooks/${notebook.id}/notes`, {
          method: "POST",
          json: {
            parentId: note.parent === null ? undefined : shortIds[note.parent],
            contentMd: renderFixtureMarkdown(note, {
              shortIdOf: (index) => (index < start ? shortIds[index] : undefined),
              imageId: image.id,
            }),
          },
        }),
      ),
    );
    created.forEach((note, offset) => {
      shortIds[start + offset] = note.id;
    });
    if (start % 1000 < concurrency)
      console.error(`${start + batch.length}/${notes.length} pages, ${Math.round((performance.now() - started) / 1000)} s`);
  }
  const children = new Map<number, number[]>();
  for (const note of notes) if (note.parent !== null) children.set(note.parent, [...(children.get(note.parent) ?? []), note.index]);
  const [folder, pages] = [...children].sort((left, right) => right[1].length - left[1].length)[0]!;
  const inbound = new Map<number, number>();
  for (const note of notes) for (const target of note.links) inbound.set(target, (inbound.get(target) ?? 0) + 1);
  const linked = [...inbound].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 0;
  const target = { folder: shortIds[folder]!, page: shortIds[pages.at(-1)!]!, other: shortIds[pages[0]!]!, linked: shortIds[linked]! };
  console.log(JSON.stringify({ notebook: notebook.id, shape, pages: notes.length, ...target }));
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function sample(cloud: DevCloud, runs: number, path: string, init: Parameters<DevCloud["fetch"]>[1] = {}) {
  const times: number[] = [];
  let bytes = 0;
  let status = 0;
  for (let run = 0; run < runs; run++) {
    // A rate-limited attempt is not a sample: wait it out and measure the next one.
    let response: Response;
    let started: number;
    let body: ArrayBuffer;
    do {
      started = performance.now();
      response = await cloud.send(path, init);
      body = await response.arrayBuffer();
      if (response.status === 429) await Bun.sleep(1000);
    } while (response.status === 429);
    times.push(performance.now() - started);
    bytes = body.byteLength;
    status = response.status;
  }
  return { ms: Math.round(median(times)), bytes, status };
}

type Targets = { folder: string; page: string; other: string; linked: string };

async function measure(cloud: DevCloud, notebookId: string, targets: Targets, runs: number) {
  const { folder, page, other, linked } = targets;
  const notesPath = (id: string) => `/app/notebooks/${notebookId}/notes/${id}`;
  const html = { accept: "text/html" };
  const results = {
    openPage: await sample(cloud, runs, notesPath(page), html),
    openFolder: await sample(cloud, runs, notesPath(folder), html),
    switchPage: await sample(cloud, runs, `/api/notebooks/${notebookId}/route-state?href=${encodeURIComponent(notesPath(other))}`),
    workspaceState: await sample(cloud, runs, `/api/notebooks/${notebookId}/workspace-state`),
    tree: await sample(cloud, runs, `/api/notebooks/${notebookId}/tree`),
    folderBlocks: await sample(cloud, runs, `/api/notebooks/${notebookId}/notes/${folder}/block-preview`, { method: "POST", json: {} }),
    search: await sample(cloud, runs, `/api/notebooks/${notebookId}/search?q=${encodeURIComponent("steering group")}`),
    globalSearch: await sample(cloud, runs, `/api/notebooks/search?q=${encodeURIComponent("steering group")}&notebook=${notebookId}`),
    backlinks: await sample(cloud, runs, `/api/notebooks/${notebookId}/notes/${linked}/backlinks`),
    graphPage: await sample(cloud, runs, `/app/notebooks/${notebookId}?mode=graph&note=${page}`, html),
    graph: await sample(cloud, runs, `/api/notebooks/${notebookId}/graph`),
  };
  console.log(JSON.stringify({ notebook: notebookId, targets, results }, null, 2));
}

if (import.meta.main) {
  const { command, help, options } = parseOptions(process.argv.slice(2));
  if (help || !command) {
    console.log(HELP);
    process.exit(help ? 0 : 1);
  }
  const cloud = new DevCloud(options.origin);
  await cloud.login(options.token);
  if (command === "seed") {
    if (!options.shape) throw new Error("seed needs --shape");
    await seed(cloud, options.shape, options.concurrency);
  } else if (command === "measure") {
    if (!options.notebook || !options.targets) throw new Error("measure needs --notebook and --targets");
    await measure(cloud, options.notebook, JSON.parse(options.targets) as Targets, options.runs);
  } else {
    console.log(HELP);
    process.exit(1);
  }
}
