import { delimiter } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pluginDirectories } from "../helpers/plugin-fixtures";

afterEach(() => vi.unstubAllEnvs());

it("reads platform-separated absolute fixture paths", () => {
  const paths =
    delimiter === ";"
      ? ["C:\\Plugins\\SampleSync", "D:\\Plugins with spaces\\SampleSheet"]
      : ["/plugins/sample-sync", "/plugins with spaces/sample-sheet"];
  vi.stubEnv("BASALT_PLUGIN_DIRS", paths.join(delimiter));
  expect(pluginDirectories()).toEqual(paths);
});

it("ignores empty fixture entries", () => {
  vi.stubEnv(
    "BASALT_PLUGIN_DIRS",
    `${delimiter}plugins${delimiter}${delimiter}`,
  );
  expect(pluginDirectories()).toEqual(["plugins"]);
  vi.stubEnv("BASALT_PLUGIN_DIRS", "");
  expect(pluginDirectories()).toEqual([]);
});
