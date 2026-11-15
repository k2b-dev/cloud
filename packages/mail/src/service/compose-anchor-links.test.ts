import { expect, test } from "bun:test";
import { composeAnchorLinks } from "./compose-anchor-links";

const previousLinks = (body: string) =>
  [...body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gis)].map((match) => ({
    label: match[2]!.replace(/<[^>]+>/g, "").trim(),
    destination: match[1]!,
  }));

test("preserves anchor and href recognition", () => {
  const examples = [
    '<A HREF="https://example.org"> <b>https://example.org</b> </A>',
    "<a href=\"https://first.example\" data-href='https://last.example'>www.example.org</a>",
    "<a href=\"https://example.org'>mixed quotes</a>",
    '<a href="https://example.org/>">address</a>',
    '<a href="">empty</a><abbr href="bad">bad</abbr>',
    "<a href=\"first href='second'>nested attribute</a>",
    '<a <a href="https://example.org">nested opening</a>',
    '<a href="https://example.org"><>kept<<>removed</a>',
    '<a href="https://example.org">unterminated',
    '<a href="https://example.org">line\nbreak</a>',
  ];
  for (const body of examples) expect(composeAnchorLinks(body), body).toEqual(previousLinks(body));
  // Fixed seed: malformed inputs compare semantics without an unbounded old matcher.
  let seed = 17;
  const tokens = ["<a ", "<A", ">", "</a>", " href=", "data-href=", '"', "'", "x", " ", "\n", "<b>", "</b>", "<>"];
  for (let sample = 0; sample < 10000; sample++) {
    let body = "";
    for (let i = 0; i < 20; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      body += tokens[seed % tokens.length];
    }
    expect(composeAnchorLinks(body), body).toEqual(previousLinks(body));
  }
});

test("scans long attribute and label fragments", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
      const { composeAnchorLinks } = await import(${JSON.stringify(import.meta.dir + "/compose-anchor-links.ts")});
      const results = [];
      for (const body of [('<a href="x" '.repeat(10000)) + '>label</a>', '<a href="https://example.org">' + '<'.repeat(190000) + '</a>']) {
        const started = performance.now();
        const links = composeAnchorLinks(body);
        results.push({ count: links.length, elapsed: performance.now() - started });
      }
      console.log(JSON.stringify(results));
    `,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, errors).toBe(0);
    for (const result of JSON.parse(output)) {
      expect(result.count).toBe(1);
      expect(result.elapsed).toBeLessThan(500);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}, 20000);
