import { HttpRequest, HttpResult, SecretReference, HTTP_BYTES } from "../http-contracts";

export function secret(name: string, options: { prefix?: string } = {}): SecretReference {
  const reference = SecretReference.parse({ secret: name, prefix: options.prefix ?? "" });
  Object.defineProperty(reference, Symbol.toPrimitive, {
    value: () => {
      throw new Error('Use secret(name, { prefix: "Bearer " }) directly as a header value; do not concatenate secrets.');
    },
  });
  return Object.freeze(reference);
}
export function createHttp(rpc: (method: string, args: unknown[]) => Promise<unknown>) {
  return {
    async fetch(
      url: string,
      options: {
        method?: string;
        headers?: Record<string, string | SecretReference>;
        body?: string | Blob | ArrayBuffer | Uint8Array;
      } = {},
    ) {
      let body: string | undefined;
      if (options.body !== undefined) {
        const bytes = new Uint8Array(
          await new Blob([options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body]).arrayBuffer(),
        );
        if (bytes.byteLength > HTTP_BYTES) throw new Error("HTTP request body exceeds the 4 MiB budget");
        let text = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        body = btoa(text);
      }
      const request = HttpRequest.parse({ url, ...options, body });
      const result = HttpResult.parse(await rpc("http.fetch", [request]));
      const bytes = Uint8Array.from(atob(result.body), (c) => c.charCodeAt(0));
      return new Response([204, 205, 304].includes(result.status) || request.method === "HEAD" ? null : bytes, {
        status: result.status,
        headers: result.headers,
      });
    },
  };
}
