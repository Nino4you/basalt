import { invoke } from "@tauri-apps/api/core";
import {
  base64ToBytes,
  bytesToBase64,
  type NativeVaultInvoke,
} from "./native-port";
import { MAX_VAULT_BINARY_BYTES } from "./storage-port";

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  /** Throw for status 400 and above. Obsidian's default is `true`. */
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export type RequestUrl = (
  request: RequestUrlParam | string,
) => Promise<RequestUrlResponse>;

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

function normalize(request: RequestUrlParam | string): RequestUrlParam {
  const param = typeof request === "string" ? { url: request } : request;
  if (!param || typeof param.url !== "string")
    throw new TypeError("requestUrl requires a URL");
  return param;
}

function requestHeaders(param: RequestUrlParam): Record<string, string> {
  const headers: Record<string, string> = { ...(param.headers ?? {}) };
  if (
    param.contentType &&
    !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")
  )
    headers["Content-Type"] = param.contentType;
  return headers;
}

function bodyBytes(body: RequestUrlParam["body"]): Uint8Array | null {
  if (body === undefined || body === null) return null;
  // Always copy into this realm's Uint8Array: plugins may pass buffers or
  // views created elsewhere, and the caller must not mutate what is sent.
  if (typeof body === "string")
    return new Uint8Array(new TextEncoder().encode(body));
  const value: unknown = body;
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]")
    return new Uint8Array(new Uint8Array(value as ArrayBuffer));
  throw new TypeError("requestUrl body must be a string or an ArrayBuffer");
}

/** Obsidian semantics: decoded text, lazily parsed JSON, throw on 400+. */
function respond(param: RequestUrlParam, raw: RawResponse): RequestUrlResponse {
  if (param.throw !== false && raw.status >= 400)
    throw new Error(`Request failed with status ${raw.status}`);
  const copy = raw.body.slice();
  const arrayBuffer = copy.buffer;
  const text = new TextDecoder().decode(copy);
  return {
    status: raw.status,
    headers: raw.headers,
    arrayBuffer,
    text,
    get json(): unknown {
      return JSON.parse(text);
    },
  };
}

/**
 * Browser transport. It is subject to CORS and the CSP, so it only serves the
 * browser demo and tests; the native app uses `nativeRequestUrl`.
 */
export const fetchRequestUrl: RequestUrl = async (request) => {
  const param = normalize(request);
  const body = bodyBytes(param.body);
  const response = await fetch(param.url, {
    method: param.method ?? "GET",
    headers: requestHeaders(param),
    body: body as BodyInit | null,
  });
  return respond(param, {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: new Uint8Array(await response.arrayBuffer()),
  });
};

/**
 * Native transport through the `plugin_request_url` command. Like Obsidian's
 * own `requestUrl`, it runs outside the WebView, so self-hosted servers
 * (attachment stores, model downloads) need no CORS headers.
 */
export function nativeRequestUrl(
  run: NativeVaultInvoke = invoke as NativeVaultInvoke,
): RequestUrl {
  return async (request) => {
    const param = normalize(request);
    const body = bodyBytes(param.body);
    if (body && body.byteLength > MAX_VAULT_BINARY_BYTES)
      throw new Error("requestUrl body exceeds the 64 MiB limit");
    let result: { status?: unknown; headers?: unknown; body?: unknown } | null;
    try {
      result = (await run("plugin_request_url", {
        request: {
          url: param.url,
          method: (param.method ?? "GET").toUpperCase(),
          headers: requestHeaders(param),
          body: body ? bytesToBase64(body) : null,
        },
      })) as typeof result;
    } catch (error) {
      // Commands reject with a plain string; plugins read `error.message`,
      // as they would for Obsidian's own requestUrl.
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (
      !result ||
      typeof result.status !== "number" ||
      typeof result.body !== "string" ||
      !result.headers ||
      typeof result.headers !== "object"
    )
      throw new Error("Native request returned an invalid response");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(result.headers))
      if (typeof value === "string") headers[name] = value;
    return respond(param, {
      status: result.status,
      headers,
      body: base64ToBytes(result.body),
    });
  };
}
