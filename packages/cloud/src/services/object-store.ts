import type { S3ListObjectsResponse, S3Stats } from "bun";
import { objectStoreArea } from "../_internal/object-store-area";
import { objectStoreBackend } from "../_internal/object-store-config";
import { validateObjectKey as validateKey } from "../_internal/object-store-key";
import { publicCloudOrigin } from "../shared/app-url";
import { get } from "./settings";

export type ObjectVisibility = "private" | "public";
export type ObjectWriteData = string | ArrayBuffer | ArrayBufferView | Blob | Request | Response;
export type ObjectWriteOptions = { type?: string };
export type ObjectPresignOptions = { method?: "GET" | "HEAD" | "DELETE"; expiresIn?: number };
export type ObjectListOptions = {
  prefix?: string;
  startAfter?: string;
  continuationToken?: string;
  maxKeys?: number;
};
export type ObjectListResult = Pick<S3ListObjectsResponse, "contents" | "isTruncated" | "nextContinuationToken">;

export interface ObjectStoreFile {
  readonly key: string;
  readonly size: Promise<number>;
  stat(): Promise<S3Stats>;
  write(data: ObjectWriteData, options?: ObjectWriteOptions): Promise<number>;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
  stream(): ReadableStream<Uint8Array>;
  exists(): Promise<boolean>;
  delete(): Promise<void>;
  copy(destinationKey: string): Promise<number>;
  presign(options?: ObjectPresignOptions): Promise<string>;
  readonly url: Promise<string>;
}

const assertSize = (size: number, limit: number): void => {
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new RangeError(`Object exceeds the ${limit}-byte limit.`);
};

/** Pull one chunk at a time, propagate cancellation, and reject before buffering past the budget. */
const boundedStream = (source: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            controller.close();
            return;
          }
          size += next.value.byteLength;
          assertSize(size, limit);
          controller.enqueue(next.value);
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
};

const uploadData = async (data: ObjectWriteData, limit: number): Promise<string | ArrayBuffer | Uint8Array<ArrayBufferLike>> => {
  if (typeof data === "string") {
    assertSize(Buffer.byteLength(data), limit);
    return data;
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    assertSize(data.byteLength, limit);
    return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data;
  }
  if (data instanceof Blob || data instanceof Request || data instanceof Response) {
    if (data instanceof Blob) assertSize(await data.size, limit);
    const stream = data instanceof Blob ? data.stream() : data.body;
    if (!stream) return new Uint8Array();
    return new Response(boundedStream(stream, limit)).bytes();
  }
  throw new TypeError("Unsupported object data.");
};

const file = (key: string, visibility: ObjectVisibility = "private"): ObjectStoreFile => {
  const prefix = objectStoreArea(visibility);
  validateKey(key, prefix);
  const path = prefix + key;
  const stream = () => {
    let reader: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
    const source = () =>
      (reader ??= objectStoreBackend().then(({ client, limit }) => boundedStream(client.file(path).stream(), limit).getReader()));
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const current = await source();
            const next = await current.read();
            if (next.done) {
              current.releaseLock();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            void reader?.then(
              (current) => current.releaseLock(),
              () => {},
            );
            controller.error(error);
          }
        },
        async cancel(reason) {
          if (!reader) return;
          const current = await reader;
          try {
            await current.cancel(reason);
          } finally {
            current.releaseLock();
          }
        },
      },
      { highWaterMark: 0 },
    );
  };
  return Object.freeze({
    key,
    get size() {
      return objectStoreBackend().then(({ client }) => client.size(path));
    },
    async stat() {
      return (await objectStoreBackend()).client.stat(path);
    },
    async write(data: ObjectWriteData, options: ObjectWriteOptions = {}) {
      const { client, limit } = await objectStoreBackend();
      const content = await uploadData(data, limit);
      const inheritedType =
        data instanceof Blob
          ? data.type
          : data instanceof Request || data instanceof Response
            ? data.headers.get("content-type")
            : undefined;
      return client.file(path).write(content, { type: options.type ?? (inheritedType || undefined) });
    },
    text: () => new Response(stream()).text(),
    bytes: () => new Response(stream()).bytes(),
    stream,
    async exists() {
      return (await objectStoreBackend()).client.file(path).exists();
    },
    async delete() {
      return (await objectStoreBackend()).client.file(path).delete();
    },
    async copy(destinationKey: string) {
      validateKey(destinationKey, prefix);
      const { client, limit } = await objectStoreBackend();
      const metadata = await client.stat(path);
      assertSize(metadata.size, limit);
      const content = await new Response(boundedStream(client.file(path).stream(), limit)).bytes();
      return client.file(prefix + destinationKey).write(content, { type: metadata.type });
    },
    presign(options: ObjectPresignOptions = {}) {
      if (visibility !== "private") throw new Error("Use url for public objects.");
      const expiresIn = options.expiresIn ?? 300;
      const method = options.method ?? "GET";
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 900) throw new RangeError("Presign expiry must be 1–900 seconds.");
      if (!["GET", "HEAD", "DELETE"].includes(method))
        throw new TypeError("Presign supports GET, HEAD, and DELETE; upload through write().");
      return objectStoreBackend().then(({ client }) => client.file(path).presign({ method, expiresIn }));
    },
    get url() {
      if (visibility !== "public") throw new Error("Private objects have no public URL.");
      return get<string>("app.url").then(
        (base) => `${publicCloudOrigin(base)}/public/storage/${path.slice("public/".length).split("/").map(encodeURIComponent).join("/")}`,
      );
    },
  });
};

/** App-bound S3 operations. Identity comes from app.start(), never from an API parameter. */
const list = async (options: ObjectListOptions = {}, visibility: ObjectVisibility = "private"): Promise<ObjectListResult> => {
  const prefix = objectStoreArea(visibility);
  const relative = validateKey(options.prefix ?? "", prefix, true);
  const startAfter = options.startAfter === undefined ? undefined : prefix + validateKey(options.startAfter, prefix);
  const maxKeys = options.maxKeys ?? 1000;
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000) throw new RangeError("List maxKeys must be 1–1,000.");
  if (
    options.continuationToken !== undefined &&
    (typeof options.continuationToken !== "string" || options.continuationToken.length > 8192)
  ) {
    throw new TypeError("Invalid S3 continuation token.");
  }
  const { client } = await objectStoreBackend();
  const result = await client.list({ prefix: prefix + relative, startAfter, maxKeys, continuationToken: options.continuationToken });
  const contents = result.contents?.flatMap((object) => {
    if (!object.key.startsWith(prefix + relative)) throw new Error("S3 returned an object outside the requested area.");
    try {
      return [{ ...object, key: validateKey(object.key.slice(prefix.length), prefix) }];
    } catch {
      // Console folder markers and externally written nonconforming names are
      // inaccessible through this API, but must not break paging for valid keys.
      return [];
    }
  });
  return { contents, isTruncated: result.isTruncated, nextContinuationToken: result.nextContinuationToken };
};

export const storage = Object.freeze({
  file: (key: string) => file(key),
  list: (options?: ObjectListOptions) => list(options),
  public: Object.freeze({ file: (key: string) => file(key, "public"), list: (options?: ObjectListOptions) => list(options, "public") }),
});
