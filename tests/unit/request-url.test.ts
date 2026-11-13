import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createObsidianApi,
  type RequestUrlParam,
  type RequestUrlResponse,
  type RequestUrlResponsePromise,
} from "../../src/compat/obsidian-api";
import { nativeRequestUrl, type RequestUrl } from "../../src/compat/request";

function api(transport?: RequestUrl) {
  return createObsidianApi({ app: {}, requestUrl: transport }).requestUrl as (
    request: RequestUrlParam | string,
  ) => RequestUrlResponsePromise;
}

afterEach(() => vi.unstubAllGlobals());

describe("requestUrl compatibility", () => {
  it("accepts a URL string and shares one response across lazy body shortcuts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response('{"value":42}', {
          headers: { "X-Result": "yes" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const request = api()("https://example.test/data");
    expect(await request.json).toEqual({ value: 42 });
    expect(await request.text).toBe('{"value":42}');
    const response = await request;
    expect(await request.arrayBuffer).toBe(response.arrayBuffer);
    expect(response.headers["x-result"]).toBe("yes");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://example.test/data");
  });

  it("forwards method, binary body, content type and headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("ok"),
    );
    vi.stubGlobal("fetch", fetch);
    const body = new Uint8Array([0, 255]).buffer;
    const request = {
      url: "https://example.test/data",
      method: "POST",
      body,
      contentType: "application/octet-stream",
      headers: { "X-Test": "kept" },
    };
    const response = await api()(request);
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).not.toBe(body);
    expect(init.body).toEqual(new Uint8Array([0, 255]));
    new Uint8Array(body).fill(1);
    expect(init.body).toEqual(new Uint8Array([0, 255]));
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Headers(init.headers).get("x-test")).toBe("kept");
    expect(request.headers).toEqual({ "X-Test": "kept" });
    expect(response.text).toBe("ok");
    expect(() => response.json).toThrow(SyntaxError);
  });

  it.each([400, 503])(
    "rejects HTTP %s by default without unused shortcut rejections",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("error", { status })),
      );
      await expect(api()({ url: "https://example.test/data" })).rejects.toThrow(
        String(status),
      );
    },
  );

  it("returns error bodies when throw is explicitly false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    const response = await api()({
      url: "https://example.test/data",
      throw: false,
    });
    expect(response).toMatchObject({ status: 404, text: "missing" });
  });

  it("rejects body shortcuts when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(api()("https://example.test/data").text).rejects.toThrow(
      "offline",
    );
  });

  it("preserves injected transports and applies the same response contract", async () => {
    const transport = vi.fn(async (): Promise<RequestUrlResponse> => ({
      status: 404,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: null,
      text: "missing",
    }));
    const request = api(transport)("https://example.test/data");
    await expect(request).rejects.toThrow("404");
    expect(transport).toHaveBeenCalledWith({
      url: "https://example.test/data",
    });
  });

  it("keeps lazy body shortcuts when using the native transport", async () => {
    const run = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: btoa("not json"),
    }));
    const request = api(nativeRequestUrl(run))("https://example.test/data");
    expect(await request.text).toBe("not json");
    const response = await request;
    expect(await request.arrayBuffer).toBe(response.arrayBuffer);
    await expect(request.json).rejects.toThrow(SyntaxError);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("plugin_request_url", {
      request: {
        url: "https://example.test/data",
        method: "GET",
        headers: {},
        body: null,
      },
    });
  });
});
