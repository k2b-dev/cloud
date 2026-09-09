import { readFile, writeFile } from "node:fs/promises";
import { arg, type CloudCliContext, type CloudCliFlags, command, defineCliCommands, flag, printStructured } from "@k2b/cloud/cli";
import { encoding, password, crypto as stdCrypto } from "@k2b/stdlib";
import { qr } from "@k2b/stdlib/qr";

type CorrectionLevel = "L" | "M" | "Q" | "H";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const stringFlag = (flags: CloudCliFlags, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.at(-1);
  }
  return undefined;
};

const stringFlags = (flags: CloudCliFlags, name: string): string[] => {
  const value = flags[name];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
};

const booleanFlag = (flags: CloudCliFlags, ...names: string[]): boolean => names.some((name) => flags[name] === true);

const requireArg = (args: string[], index: number, label: string): string => {
  const value = args[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
};

const parsePositiveInt = (value: string | undefined, fallback: number, label: string, max = 10_000): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${label} must be between 1 and ${max}.`);
  return parsed;
};

const outputValue = (ctx: CloudCliContext, value: string | string[], jsonValue?: unknown) => {
  if (ctx.options.output === "json") {
    ctx.json(jsonValue ?? { value });
    return;
  }
  ctx.print(Array.isArray(value) ? value.join("\n") : value);
};

const readInput = async (ctx: CloudCliContext, args: string[], label = "input"): Promise<string> => {
  if (booleanFlag(ctx.flags, "stdin")) {
    if (args.length > 0) throw new Error(`Pass either ${label} arguments or --stdin, not both.`);
    return Bun.stdin.text();
  }
  const value = args.join(" ");
  if (!value) throw new Error(`Missing ${label}. Pass text or --stdin.`);
  return value;
};

const readSecret = async (ctx: CloudCliContext, flag: string, fileFlag: string, label: string): Promise<string> => {
  const literal = stringFlag(ctx.flags, flag);
  const file = stringFlag(ctx.flags, fileFlag);
  if (literal && file) throw new Error(`Pass only one of --${flag} or --${fileFlag}.`);
  if (literal !== undefined) return literal;
  if (file) return (await readFile(file, "utf8")).trim();
  throw new Error(`Missing ${label}. Pass --${flag} or --${fileFlag}.`);
};

const encodeText = (format: "base64" | "hex" | "base32", input: string): string => {
  const bytes = encoder.encode(input);
  if (format === "base64") return encoding.toBase64(bytes);
  if (format === "hex") return encoding.toHex(bytes);
  return encoding.toBase32(bytes);
};

const decodeText = (format: "base64" | "hex" | "base32", input: string): string => {
  if (format === "base64") return decoder.decode(encoding.fromBase64Strict(input));
  if (format === "hex") return decoder.decode(encoding.fromHex(input));
  return decoder.decode(encoding.fromBase32(input));
};

const hashText = async (algorithm: "sha256" | "fnv1a", input: string): Promise<string> =>
  algorithm === "sha256" ? stdCrypto.common.hash(input) : stdCrypto.common.fnv1aHash(input);

const LOREM_WORDS = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "et",
  "dolore",
  "magna",
  "aliqua",
  "enim",
  "ad",
  "minim",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
  "ullamco",
  "laboris",
  "nisi",
  "aliquip",
  "commodo",
  "consequat",
  "duis",
  "aute",
  "irure",
  "reprehenderit",
  "voluptate",
  "velit",
  "esse",
  "cillum",
  "fugiat",
  "nulla",
  "pariatur",
  "excepteur",
  "sint",
  "occaecat",
  "cupidatat",
  "proident",
];

const randomWord = (): string => LOREM_WORDS[Math.floor(Math.random() * LOREM_WORDS.length)]!;
const capitalize = (value: string): string => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

const loremSentence = (): string => {
  const words = Array.from({ length: 5 + Math.floor(Math.random() * 10) }, randomWord);
  words[0] = capitalize(words[0]!);
  return `${words.join(" ")}.`;
};

const loremParagraph = (): string => Array.from({ length: 3 + Math.floor(Math.random() * 5) }, loremSentence).join(" ");

const generateLorem = (ctx: CloudCliContext): { mode: string; count: number; output: string } => {
  const paragraphCount = stringFlag(ctx.flags, "paragraphs");
  const sentenceCount = stringFlag(ctx.flags, "sentences");
  const wordCount = stringFlag(ctx.flags, "words");
  const modes = [paragraphCount !== undefined, sentenceCount !== undefined, wordCount !== undefined].filter(Boolean).length;
  if (modes !== 1) throw new Error("Pass exactly one of --paragraphs <n>, --sentences <n>, or --words <n>.");
  if (paragraphCount !== undefined) {
    const count = parsePositiveInt(paragraphCount, 3, "--paragraphs", 100);
    return { mode: "paragraphs", count, output: Array.from({ length: count }, loremParagraph).join("\n\n") };
  }
  if (sentenceCount !== undefined) {
    const count = parsePositiveInt(sentenceCount, 3, "--sentences", 500);
    return { mode: "sentences", count, output: Array.from({ length: count }, loremSentence).join(" ") };
  }
  const count = parsePositiveInt(wordCount, 20, "--words", 10_000);
  const words = Array.from({ length: count }, randomWord);
  words[0] = capitalize(words[0]!);
  return { mode: "words", count, output: `${words.join(" ")}.` };
};

const hexToRgb = (hex: string): [number, number, number] | null => {
  const match = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return null;
  return [Number.parseInt(match[1]!, 16), Number.parseInt(match[2]!, 16), Number.parseInt(match[3]!, 16)];
};

const rgbToHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b]
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(lightness * 100)];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  if (max === rr) hue = ((gg - bb) / delta + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) hue = ((bb - rr) / delta + 2) / 6;
  else hue = ((rr - gg) / delta + 4) / 6;
  return [Math.round(hue * 360), Math.round(saturation * 100), Math.round(lightness * 100)];
};

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const hue = h / 360;
  const saturation = s / 100;
  const lightness = l / 100;
  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return [value, value, value];
  }
  const hueToRgb = (p: number, q: number, tInput: number) => {
    let t = tInput;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [
    Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, hue) * 255),
    Math.round(hueToRgb(p, q, hue - 1 / 3) * 255),
  ];
};

const parseNumberTriple = (value: string): [number, number, number] | null => {
  const match = value.match(/(\d{1,3})\s*[,\s]\s*(\d{1,3})%?\s*[,\s]\s*(\d{1,3})%?/);
  if (!match) return null;
  return [Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10), Number.parseInt(match[3]!, 10)];
};

const convertColor = (value: string) => {
  const trimmed = value.trim();
  let rgb: [number, number, number] | null = null;
  if (trimmed.startsWith("#") || /^[0-9a-f]{6}$/i.test(trimmed)) {
    rgb = hexToRgb(trimmed);
  } else if (/^hsl/i.test(trimmed) || trimmed.includes("%")) {
    const hsl = parseNumberTriple(trimmed);
    if (hsl && hsl[0] <= 360 && hsl[1] <= 100 && hsl[2] <= 100) rgb = hslToRgb(...hsl);
  } else {
    const parsed = parseNumberTriple(trimmed);
    if (parsed && parsed.every((part) => part <= 255)) rgb = parsed;
  }
  if (!rgb) throw new Error("Color must be #RRGGBB, R G B, R,G,B, or H S% L%.");
  const hsl = rgbToHsl(...rgb);
  return {
    hex: rgbToHex(...rgb),
    rgb: `rgb(${rgb.join(", ")})`,
    hsl: `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`,
    channels: { r: rgb[0], g: rgb[1], b: rgb[2], h: hsl[0], s: hsl[1], l: hsl[2] },
  };
};

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const buildMailto = (ctx: CloudCliContext) => {
  const to = stringFlag(ctx.flags, "to");
  if (!to?.trim()) throw new Error("Missing recipient. Pass --to <email>.");
  const cc = stringFlags(ctx.flags, "cc");
  const bcc = stringFlags(ctx.flags, "bcc");
  const subject = stringFlag(ctx.flags, "subject") ?? "";
  const body = stringFlag(ctx.flags, "body") ?? "";
  const params: string[] = [];
  if (cc.length > 0) params.push(`cc=${encodeURIComponent(cc.join(","))}`);
  if (bcc.length > 0) params.push(`bcc=${encodeURIComponent(bcc.join(","))}`);
  if (subject.trim()) params.push(`subject=${encodeURIComponent(subject.trim())}`);
  if (body.trim()) params.push(`body=${encodeURIComponent(body.trim())}`);
  const link = `mailto:${encodeURIComponent(to.trim())}${params.length > 0 ? `?${params.join("&")}` : ""}`;
  const label = subject.trim() || `Email ${to.trim()}`;
  const markdown = `[${label}](${link})`;
  const html = `<a href="${escapeHtml(link)}">${escapeHtml(label)}</a>`;
  return { link, markdown, html };
};

const parseCorrectionLevel = (value: string | undefined): CorrectionLevel => {
  const next = value ?? "M";
  if (next === "L" || next === "M" || next === "Q" || next === "H") return next;
  throw new Error("--correction must be L, M, Q, or H.");
};

const outputQr = async (ctx: CloudCliContext, payload: string) => {
  const svg = qr.toSvg(payload, { correctionLevel: parseCorrectionLevel(stringFlag(ctx.flags, "correction")) });
  const out = stringFlag(ctx.flags, "out", "output");
  if (out) {
    await writeFile(out, svg);
    if (!printStructured(ctx, { out, bytes: svg.length })) ctx.print(`Wrote ${out}.`);
    return;
  }
  outputValue(ctx, svg, { payload, svg });
};

const normalizeServer = (server: string): string => server.replace(/\/+$/, "");
const joinUrl = (server: string, path: string): string => `${normalizeServer(server)}${path.startsWith("/") ? path : `/${path}`}`;

const fillRandom = (buf: Uint8Array): Uint8Array => {
  const chunk = 64 * 1024;
  for (let offset = 0; offset < buf.byteLength; offset += chunk) {
    globalThis.crypto.getRandomValues(buf.subarray(offset, Math.min(offset + chunk, buf.byteLength)));
  }
  return buf;
};

const stddev = (samples: number[]): number => {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return Math.sqrt(samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length);
};

const round = (value: number): number => Math.round(value * 100) / 100;

const runSpeedtest = async (ctx: CloudCliContext) => {
  const server = stringFlag(ctx.flags, "server") ?? ctx.options.server;
  if (!server) throw new Error("Speedtest needs a Cloud server. Pass global --server <url> or configure a profile.");
  const base = joinUrl(server, "/tools/api/speedtest");
  const pingSamples: number[] = [];
  for (let i = 0; i < 1; i += 1) await fetch(`${base}/ping`, { cache: "no-store" });
  for (let i = 0; i < 10; i += 1) {
    const start = performance.now();
    const response = await fetch(`${base}/ping`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Ping failed: HTTP ${response.status}`);
    pingSamples.push(performance.now() - start);
  }

  const downloadParallel = 4;
  const downloadPerStream = 25 * 1024 * 1024;
  let downloaded = 0;
  const downloadStart = performance.now();
  await Promise.all(
    Array.from({ length: downloadParallel }, async () => {
      const response = await fetch(`${base}/download?size=${downloadPerStream}`, { cache: "no-store" });
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          downloaded += value?.byteLength ?? 0;
        }
      } finally {
        reader.releaseLock();
      }
    }),
  );
  const downloadMbps = (downloaded * 8) / ((performance.now() - downloadStart) / 1000) / 1e6;

  const uploadParallel = 4;
  const uploadPerStream = 12 * 1024 * 1024;
  const payload = fillRandom(new Uint8Array(uploadPerStream));
  const uploadStart = performance.now();
  await Promise.all(
    Array.from({ length: uploadParallel }, async () => {
      const response = await fetch(`${base}/upload`, {
        method: "POST",
        body: payload as unknown as BodyInit,
        headers: { "content-type": "application/octet-stream" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Upload failed: HTTP ${response.status}`);
    }),
  );
  const uploadMbps = (uploadPerStream * uploadParallel * 8) / ((performance.now() - uploadStart) / 1000) / 1e6;

  const result = {
    server: base,
    timestamp: new Date().toISOString(),
    ping_ms: round(Math.min(...pingSamples)),
    jitter_ms: round(stddev(pingSamples)),
    download_mbps: round(downloadMbps),
    upload_mbps: round(uploadMbps),
  };
  if (!printStructured(ctx, result)) {
    ctx.print(
      [
        `Server:   ${result.server}`,
        `Ping:     ${result.ping_ms} ms`,
        `Jitter:   ${result.jitter_ms} ms`,
        `Download: ${result.download_mbps} Mbps`,
        `Upload:   ${result.upload_mbps} Mbps`,
      ].join("\n"),
    );
  }
};

const runPasswordCommand = async (ctx: CloudCliContext, args: string[]) => {
  const command = requireArg(args, 0, "password command");
  if (command === "strength") {
    const value = await readInput(ctx, args.slice(1), "password");
    const result = password.strength(value);
    if (!printStructured(ctx, result)) {
      const feedback = result.feedback.length > 0 ? `\n${result.feedback.map((item) => `- ${item}`).join("\n")}` : "";
      ctx.print(`${result.label} (${result.entropy.toFixed(1)} bits, ${result.crackTime})${feedback}`);
    }
    return;
  }

  const count = parsePositiveInt(stringFlag(ctx.flags, "count"), 1, "--count", 1_000);
  const values = Array.from({ length: count }, () => {
    if (command === "random") {
      return password.random({
        length: parsePositiveInt(stringFlag(ctx.flags, "length"), 20, "--length", 64),
        uppercase: !booleanFlag(ctx.flags, "no-uppercase"),
        numbers: !booleanFlag(ctx.flags, "no-numbers"),
        symbols: booleanFlag(ctx.flags, "symbols"),
      });
    }
    if (command === "memorable") {
      return password.memorable({
        words: parsePositiveInt(stringFlag(ctx.flags, "words"), 4, "--words", 10),
        capitalize: booleanFlag(ctx.flags, "capitalize"),
        fullWords: !booleanFlag(ctx.flags, "short-words"),
        separator: stringFlag(ctx.flags, "separator") ?? "-",
        addNumber: booleanFlag(ctx.flags, "number"),
        addSymbol: booleanFlag(ctx.flags, "symbol"),
      });
    }
    if (command === "pin") {
      return password.pin({ length: parsePositiveInt(stringFlag(ctx.flags, "length"), 6, "--length", 12) });
    }
    throw new Error(`Unknown password command "${command}".`);
  });
  outputValue(ctx, count === 1 ? values[0]! : values, { values });
};

const runEncryptionCommand = async (ctx: CloudCliContext, kind: "encrypt" | "decrypt", args: string[]) => {
  const mode = requireArg(args, 0, "encryption mode");
  if (kind === "encrypt" && mode === "keypair") {
    const keys = await stdCrypto.asymmetric.generate();
    if (!printStructured(ctx, keys)) ctx.print(`publicKey: ${keys.publicKey}\nprivateKey: ${keys.privateKey}`);
    return;
  }

  if (mode === "symmetric") {
    const key = await readSecret(ctx, "key", "key-file", "key");
    const input = await readInput(ctx, args.slice(1), kind === "encrypt" ? "text" : "ciphertext");
    const payload = kind === "encrypt" ? input : input.trim();
    const value =
      kind === "encrypt"
        ? await stdCrypto.symmetric.encrypt({ payload, key, stretched: !booleanFlag(ctx.flags, "fast") })
        : await stdCrypto.symmetric.decrypt({ payload, key });
    outputValue(ctx, value, { value });
    return;
  }

  if (mode === "asymmetric") {
    const input = await readInput(ctx, args.slice(1), kind === "encrypt" ? "text" : "ciphertext");
    const payload = kind === "encrypt" ? input : input.trim();
    const value =
      kind === "encrypt"
        ? await stdCrypto.asymmetric.encrypt({
            payload,
            publicKey: await readSecret(ctx, "public-key", "public-key-file", "public key"),
          })
        : await stdCrypto.asymmetric.decrypt({
            payload,
            privateKey: await readSecret(ctx, "private-key", "private-key-file", "private key"),
          });
    outputValue(ctx, value, { value });
    return;
  }

  throw new Error('Encryption mode must be "symmetric", "asymmetric", or "keypair".');
};

const textArgs = {
  input: arg.rest({ valueLabel: "text", description: "Text input. Use --stdin to read from stdin." }),
};

const stdinFlag = {
  stdin: flag.boolean({ description: "Read input from stdin" }),
};

const countFlag = {
  count: flag.int({ min: 1, max: 10_000, description: "Number of values to generate" }),
};

const qrFlags = {
  out: flag.string({ aliases: ["output"], description: "Write SVG output to this path" }),
  correction: flag.enum(["L", "M", "Q", "H"], { default: "M", description: "QR correction level" }),
};

export default defineCliCommands({
  name: "tools",
  summary: "Run local utilities such as passwords, encoding, hashes, QR codes, encryption, and speedtests.",
  requiresCloud: false,
  groupSummaries: {
    decode: "Decode base32, base64, or hexadecimal text",
    decrypt: "Decrypt text with symmetric or asymmetric keys",
    encode: "Encode text as base32, base64, or hexadecimal",
    encrypt: "Encrypt text or generate an asymmetric keypair",
    hash: "Hash text with supported digest algorithms",
    password: "Generate passwords and estimate password strength",
    qr: "Generate text and WiFi QR codes",
  },
  commands: [
    command("password random", {
      summary: "Generate random passwords",
      flags: {
        length: flag.int({ min: 1, max: 64, description: "Password length" }),
        count: countFlag.count,
        noUppercase: flag.boolean({ name: "no-uppercase", description: "Disable uppercase characters" }),
        noNumbers: flag.boolean({ name: "no-numbers", description: "Disable numbers" }),
        symbols: flag.boolean({ description: "Include symbols" }),
      },
      run: async ({ ctx }) => {
        await runPasswordCommand(ctx, ["random"]);
      },
    }),
    command("password memorable", {
      summary: "Generate memorable passwords",
      flags: {
        words: flag.int({ min: 1, max: 10, description: "Number of words" }),
        count: countFlag.count,
        capitalize: flag.boolean({ description: "Capitalize words" }),
        shortWords: flag.boolean({ name: "short-words", description: "Use short words" }),
        number: flag.boolean({ description: "Append a number" }),
        symbol: flag.boolean({ description: "Append a symbol" }),
        separator: flag.string({ description: "Word separator" }),
      },
      run: async ({ ctx }) => {
        await runPasswordCommand(ctx, ["memorable"]);
      },
    }),
    command("password pin", {
      summary: "Generate PIN codes",
      flags: {
        length: flag.int({ min: 1, max: 12, description: "PIN length" }),
        count: countFlag.count,
      },
      run: async ({ ctx }) => {
        await runPasswordCommand(ctx, ["pin"]);
      },
    }),
    command("password strength", {
      summary: "Estimate password strength",
      args: textArgs,
      flags: stdinFlag,
      run: async ({ ctx, args }) => {
        await runPasswordCommand(ctx, ["strength", ...args.input]);
      },
    }),
    command("uuid", {
      summary: "Generate UUIDs",
      flags: countFlag,
      run: ({ ctx }) => {
        const count = parsePositiveInt(stringFlag(ctx.flags, "count"), 1, "--count", 10_000);
        const values = Array.from({ length: count }, () => stdCrypto.common.uuid());
        outputValue(ctx, count === 1 ? values[0]! : values, { values });
      },
    }),
    ...(["base64", "hex", "base32"] as const).flatMap((format) => [
      command(`encode ${format}`, {
        summary: `Encode text as ${format}`,
        args: textArgs,
        flags: stdinFlag,
        run: async ({ ctx, args }) => {
          const input = await readInput(ctx, args.input);
          const value = encodeText(format, input);
          outputValue(ctx, value, { format, value });
        },
      }),
      command(`decode ${format}`, {
        summary: `Decode ${format} text`,
        args: textArgs,
        flags: stdinFlag,
        run: async ({ ctx, args }) => {
          const input = await readInput(ctx, args.input);
          const value = decodeText(format, input);
          outputValue(ctx, value, { format, value });
        },
      }),
    ]),
    ...(["sha256", "fnv1a"] as const).map((algorithm) =>
      command(`hash ${algorithm}`, {
        summary: `Hash text with ${algorithm}`,
        args: textArgs,
        flags: stdinFlag,
        run: async ({ ctx, args }) => {
          const input = await readInput(ctx, args.input);
          const value = await hashText(algorithm, input);
          outputValue(ctx, value, { algorithm, value });
        },
      }),
    ),
    command("lorem", {
      summary: "Generate placeholder text",
      flags: {
        paragraphs: flag.int({ min: 1, max: 100, description: "Generate paragraphs" }),
        sentences: flag.int({ min: 1, max: 500, description: "Generate sentences" }),
        words: flag.int({ min: 1, max: 10_000, description: "Generate words" }),
      },
      run: ({ ctx }) => {
        const result = generateLorem(ctx);
        outputValue(ctx, result.output, result);
      },
    }),
    command("color", {
      summary: "Convert colors between hex, RGB, and HSL",
      args: {
        color: arg.required({ valueLabel: "hex|rgb|hsl", description: "Color value" }),
      },
      run: ({ ctx, args }) => {
        const result = convertColor(args.color);
        if (!printStructured(ctx, result)) ctx.print(`${result.hex}\n${result.rgb}\n${result.hsl}`);
      },
    }),
    command("mailto", {
      summary: "Build mailto links",
      flags: {
        to: flag.string({ required: true, description: "Recipient email address" }),
        cc: flag.stringList({ description: "CC recipient. Repeatable." }),
        bcc: flag.stringList({ description: "BCC recipient. Repeatable." }),
        subject: flag.string({ description: "Email subject" }),
        body: flag.string({ description: "Email body" }),
        format: flag.enum(["link", "markdown", "html", "all"], { default: "link", description: "Output format" }),
      },
      run: ({ ctx }) => {
        const result = buildMailto(ctx);
        const format = stringFlag(ctx.flags, "format") ?? "link";
        if (ctx.options.output === "json" || format === "all") {
          if (!printStructured(ctx, result)) ctx.print(`${result.link}\n${result.markdown}\n${result.html}`);
          return 0;
        }
        if (format === "link" || format === "markdown" || format === "html") {
          outputValue(ctx, result[format], result);
          return 0;
        }
        throw new Error("--format must be link, markdown, html, or all.");
      },
    }),
    command("qr text", {
      summary: "Generate a QR code from text",
      args: {
        input: arg.rest({ valueLabel: "text", description: "QR payload. Use --stdin to read from stdin." }),
      },
      flags: { ...stdinFlag, ...qrFlags },
      run: async ({ ctx, args }) => {
        await outputQr(ctx, await readInput(ctx, args.input, "QR text"));
      },
    }),
    command("qr wifi", {
      summary: "Generate a WiFi QR code",
      flags: {
        ssid: flag.string({ required: true, description: "WiFi SSID" }),
        password: flag.string({ description: "WiFi password" }),
        encryption: flag.enum(["WPA", "WEP", "nopass"], { default: "WPA", description: "WiFi encryption mode" }),
        hidden: flag.boolean({ description: "Mark network as hidden" }),
        ...qrFlags,
      },
      run: async ({ ctx }) => {
        const ssid = stringFlag(ctx.flags, "ssid");
        if (!ssid) throw new Error("Missing WiFi SSID. Pass --ssid <name>.");
        const encryptionMode = stringFlag(ctx.flags, "encryption") ?? "WPA";
        if (encryptionMode !== "WPA" && encryptionMode !== "WEP" && encryptionMode !== "nopass") {
          throw new Error("--encryption must be WPA, WEP, or nopass.");
        }
        await outputQr(
          ctx,
          qr.wifi({
            ssid,
            password: stringFlag(ctx.flags, "password"),
            encryption: encryptionMode,
            hidden: booleanFlag(ctx.flags, "hidden"),
          }),
        );
      },
    }),
    command("encrypt symmetric", {
      summary: "Encrypt text with a symmetric key",
      args: textArgs,
      flags: {
        ...stdinFlag,
        key: flag.string({ description: "Symmetric key" }),
        keyFile: flag.string({ name: "key-file", description: "Read symmetric key from file" }),
        fast: flag.boolean({ description: "Skip slow key stretching" }),
      },
      run: async ({ ctx, args }) => {
        await runEncryptionCommand(ctx, "encrypt", ["symmetric", ...args.input]);
      },
    }),
    command("decrypt symmetric", {
      summary: "Decrypt text with a symmetric key",
      args: textArgs,
      flags: {
        ...stdinFlag,
        key: flag.string({ description: "Symmetric key" }),
        keyFile: flag.string({ name: "key-file", description: "Read symmetric key from file" }),
      },
      run: async ({ ctx, args }) => {
        await runEncryptionCommand(ctx, "decrypt", ["symmetric", ...args.input]);
      },
    }),
    command("encrypt keypair", {
      summary: "Generate an asymmetric encryption keypair",
      run: async ({ ctx }) => {
        await runEncryptionCommand(ctx, "encrypt", ["keypair"]);
      },
    }),
    command("encrypt asymmetric", {
      summary: "Encrypt text with a public key",
      args: textArgs,
      flags: {
        ...stdinFlag,
        publicKey: flag.string({ name: "public-key", description: "Public key" }),
        publicKeyFile: flag.string({ name: "public-key-file", description: "Read public key from file" }),
      },
      run: async ({ ctx, args }) => {
        await runEncryptionCommand(ctx, "encrypt", ["asymmetric", ...args.input]);
      },
    }),
    command("decrypt asymmetric", {
      summary: "Decrypt text with a private key",
      args: textArgs,
      flags: {
        ...stdinFlag,
        privateKey: flag.string({ name: "private-key", description: "Private key" }),
        privateKeyFile: flag.string({ name: "private-key-file", description: "Read private key from file" }),
      },
      run: async ({ ctx, args }) => {
        await runEncryptionCommand(ctx, "decrypt", ["asymmetric", ...args.input]);
      },
    }),
    command("speedtest", {
      summary: "Run a Cloud speedtest",
      flags: {
        server: flag.string({ description: "Cloud server URL" }),
      },
      run: async ({ ctx }) => {
        await runSpeedtest(ctx);
      },
    }),
  ],
});
