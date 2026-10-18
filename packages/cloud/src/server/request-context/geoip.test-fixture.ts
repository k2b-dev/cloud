// Minimal deterministic MMDB writer: 24-bit tree, maps, strings, uint32 and arrays.
type Value = string | number | Buffer<ArrayBuffer> | Value[] | { [key: string]: Value };
const pointer = (offset: number) => {
  const bytes = Buffer.alloc(5);
  bytes[0] = 0x38;
  bytes.writeUInt32BE(offset, 1);
  return bytes;
};
const encode = (value: Value): Buffer<ArrayBuffer> => {
  if (Buffer.isBuffer(value)) return value;
  const header = (type: number, size: number) => {
    const extra = size < 29 ? [] : size < 285 ? [size - 29] : [(size - 285) >> 8, (size - 285) & 255];
    return Buffer.from([
      ((type > 7 ? 0 : type) << 5) | (size < 29 ? size : size < 285 ? 29 : 30),
      ...(type > 7 ? [type - 7] : []),
      ...extra,
    ]);
  };
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([header(2, bytes.length), bytes]);
  }
  if (typeof value === "number") {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return Buffer.concat([header(6, 4), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([header(11, value.length), ...value.map(encode)]);
  const entries = Object.entries(value);
  return Buffer.concat([header(7, entries.length), ...entries.flatMap(([key, item]) => [encode(key), encode(item)])]);
};

export const FIXTURE_EPOCH = 1790812800; // 2026-10-01T00:00:00.000Z
export const mmdbFixture = (
  kind: "city" | "asn",
  options?: {
    databaseType?: string;
    ipVersion?: number;
    corruptData?: boolean;
    buildEpoch?: number | string;
    description?: string;
    cityName?: string;
    repeatedPointerDepth?: number;
    metadataPointerDepth?: number;
    metadataDescriptionPointer?: boolean;
    /** Null leaves out the optional `languages` metadata key. */
    languages?: string[] | null;
  },
): Buffer<ArrayBuffer> => {
  type Node = { children: [Node | number | null, Node | number | null]; index: number };
  const root: Node = { children: [null, null], index: 0 };
  const nodes = [root];
  const data: Buffer[] = [];
  let shared: Buffer | undefined;
  if (options?.repeatedPointerDepth !== undefined) {
    data.push(encode("leaf"));
    let offset = 0;
    for (let depth = 0; depth < options.repeatedPointerDepth; depth++) {
      shared = pointer(offset);
      offset = data.reduce((total, bytes) => total + bytes.length, 0);
      data.push(Buffer.concat([Buffer.from([0x02, 0x04]), shared, shared]));
    }
    shared = pointer(offset);
  }
  const insert = (bits: string, value: Value) => {
    let node = root;
    for (let i = 0; i < bits.length; i++) {
      const side = bits[i] === "1" ? 1 : 0;
      if (i === bits.length - 1) {
        node.children[side] = data.reduce((total, bytes) => total + bytes.length, 0);
        data.push(
          options?.corruptData
            ? Buffer.from([0])
            : shared
              ? Buffer.concat([Buffer.from([0xe2]), encode("value"), encode(value), encode("shared"), shared])
              : encode(value),
        );
      } else {
        let next = node.children[side];
        if (!next || typeof next === "number") {
          next = { children: [null, null], index: nodes.length };
          nodes.push(next);
          node.children[side] = next;
        }
        node = next;
      }
    }
  };
  const city = (names: { [key: string]: Value }, country = "at"): Value => ({ city: { names }, country: { iso_code: country } });
  const network = { autonomous_system_number: 12345, autonomous_system_organization: "Example Net GmbH" };
  // IPv4 lives below ::/96 in the IPv6 search tree.
  insert("0".repeat(96) + "000010000000100000001000", kind === "city" ? city({ de: "Wien", en: options?.cityName ?? "Vienna" }) : network);
  insert("00101010000000010000010011111000", kind === "city" ? city({ en: "Zürich" }, "ch") : network);
  insert(
    "0".repeat(96) + "000000010000000100000001",
    kind === "city"
      ? city({ en: `  \u0000\u202e${"界😀".repeat(40)}  ` }, "ZZ")
      : { autonomous_system_organization: `\u0080Example\u2066  Net\t GmbH ${"界😀".repeat(40)}` },
  );
  const tree = Buffer.alloc(nodes.length * 6);
  for (const node of nodes) {
    node.children.forEach((child, side) => {
      const pointer = child === null ? nodes.length : typeof child === "number" ? nodes.length + 16 + child : child.index;
      tree.writeUIntBE(pointer, node.index * 6 + side * 3, 3);
    });
  }
  const description = options?.description ?? "Synthetic test database";
  const descriptionPointer = pointer(0);
  const sharedPointer = pointer(0);
  const metadata = {
    node_count: nodes.length,
    record_size: 24,
    ip_version: options?.ipVersion ?? 6,
    database_type: options?.databaseType ?? (kind === "city" ? "DBIP-City-Lite" : "DBIP-ASN-Lite (compat=GeoLite2-ASN)"),
    ...(options?.languages === null ? {} : { languages: options?.languages ?? ["en", "de"] }),
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: options?.buildEpoch ?? FIXTURE_EPOCH,
    description: { en: options?.metadataDescriptionPointer ? descriptionPointer : description },
    ...(options?.metadataPointerDepth !== undefined ? { shared: sharedPointer } : {}),
  };
  const extra: Buffer[] = [];
  let offset = encode(metadata).length;
  if (options?.metadataDescriptionPointer) {
    descriptionPointer.writeUInt32BE(offset, 1);
    extra.push(encode(description));
    offset += extra[0]!.length;
  }
  if (options?.metadataPointerDepth !== undefined) {
    extra.push(encode("leaf"));
    let target = offset;
    offset += extra[extra.length - 1]!.length;
    for (let depth = 0; depth < options.metadataPointerDepth; depth++) {
      const next = Buffer.concat([Buffer.from([0x02, 0x04]), pointer(target), pointer(target)]);
      target = offset;
      extra.push(next);
      offset += next.length;
    }
    sharedPointer.writeUInt32BE(target, 1);
  }
  return Buffer.concat([tree, Buffer.alloc(16), ...data, Buffer.from("abcdef4d61784d696e642e636f6d", "hex"), encode(metadata), ...extra]);
};
