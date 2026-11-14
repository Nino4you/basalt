import { beforeEach, expect, it, vi } from "vitest";
import type { RequestUrl } from "../../src/compat/request";
import {
  CHECK_INTERVAL,
  checkForUpdate,
  findUpdate,
  latestRelease,
  RELEASE_API,
  RELEASE_PAGE,
  updateCheckDue,
} from "../../src/app/update-check";

beforeEach(() => localStorage.clear());

function github(json: unknown): { request: RequestUrl; urls: string[] } {
  const urls: string[] = [];
  const request: RequestUrl = async (param) => {
    urls.push(typeof param === "string" ? param : param.url);
    return {
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json,
      text: JSON.stringify(json),
    };
  };
  return { request, urls };
}

it("reads the latest release and compares versions", async () => {
  const { request, urls } = github({
    tag_name: "v0.3.0",
    html_url: "https://github.com/Nino4you/basalt/releases/tag/v0.3.0",
    body: "Neu",
  });
  expect(await latestRelease(request)).toEqual({
    version: "0.3.0",
    url: "https://github.com/Nino4you/basalt/releases/tag/v0.3.0",
    notes: "Neu",
  });
  expect(urls).toEqual([RELEASE_API]);
  expect((await checkForUpdate(request, "0.2.0"))?.version).toBe("0.3.0");
  expect(await checkForUpdate(request, "0.3.0")).toBeNull();
  expect(await checkForUpdate(request, "0.4.0")).toBeNull();
});

it("never links anywhere but GitHub and rejects odd tags", async () => {
  expect(
    (
      await latestRelease(
        github({ tag_name: "v1.0.0", html_url: "https://evil.example/" })
          .request,
      )
    ).url,
  ).toBe(RELEASE_PAGE);
  await expect(
    latestRelease(github({ tag_name: "nightly" }).request),
  ).rejects.toThrow();
  await expect(latestRelease(github(null).request)).rejects.toThrow();
});

it("checks automatically at most once a day", () => {
  const now = Date.UTC(2026, 10, 14);
  expect(updateCheckDue(now)).toBe(true);
  expect(updateCheckDue(now + 1000)).toBe(false);
  expect(updateCheckDue(now + CHECK_INTERVAL)).toBe(true);
});

it("prefers the signed updater and falls back to the release page", async () => {
  const release = {
    tag_name: "v9.0.0",
    html_url: "https://github.com/Nino4you/basalt/releases/tag/v9.0.0",
    body: "",
  };
  const signed = {
    version: "9.0.0",
    notes: "Neu",
    url: RELEASE_PAGE,
    installable: true,
  };

  const first = github(release);
  expect(await findUpdate(first.request, "0.3.0", async () => signed)).toBe(
    signed,
  );
  expect(first.urls).toEqual([]);

  const upToDate = github(release);
  expect(await findUpdate(upToDate.request, "0.3.0", async () => null)).toBe(
    null,
  );
  expect(upToDate.urls).toEqual([]);

  // A release without latest.json: still announce it, but only as a download.
  const fallback = github(release);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    await findUpdate(fallback.request, "0.3.0", async () => {
      throw new Error("Could not fetch a valid release JSON from the remote");
    }),
  ).toEqual({
    version: "9.0.0",
    url: "https://github.com/Nino4you/basalt/releases/tag/v9.0.0",
    notes: "",
    installable: false,
  });
  expect(fallback.urls).toEqual([RELEASE_API]);
  warn.mockRestore();

  // Android and the browser demo have no signed updater.
  const announce = github(release);
  expect((await findUpdate(announce.request, "0.3.0", null))?.installable).toBe(
    false,
  );
});
