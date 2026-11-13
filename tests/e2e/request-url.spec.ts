import { expect, test } from "@playwright/test";
import type { RequestUrlResponsePromise } from "../../src/compat/obsidian-api";

test("plugin requestUrl uses the browser transport with compatible body and error handling", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/__compat_request", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["content-type"]).toBe("application/json");
    expect(route.request().postDataJSON()).toEqual({ value: 42 });
    await route.fulfill({ json: { received: true } });
  });
  await page.route("**/__compat_missing", (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/compat/obsidian-api.ts";
    const { createObsidianApi } = (await import(
      path
    )) as typeof import("../../src/compat/obsidian-api");
    const requestUrl = createObsidianApi({ app: {} }).requestUrl as (
      request: unknown,
    ) => RequestUrlResponsePromise;
    const request = requestUrl({
      url: "/__compat_request",
      method: "POST",
      contentType: "application/json",
      body: '{"value":42}',
    });
    const json = await request.json;
    let error = "";
    try {
      await requestUrl("/__compat_missing");
    } catch (failure) {
      error = String(failure);
    }
    const missing = await requestUrl({
      url: "/__compat_missing",
      throw: false,
    });
    return {
      json,
      text: await request.text,
      status: (await request).status,
      error,
      missing: missing.text,
    };
  });
  expect(result).toEqual({
    json: { received: true },
    text: '{"received":true}',
    status: 200,
    error: "Error: Request failed with status 404",
    missing: "missing",
  });
  expect(errors).toEqual([]);
});
