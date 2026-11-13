import { delimiter } from "node:path";

export function pluginDirectories(): string[] {
  return (process.env.BASALT_PLUGIN_DIRS ?? "")
    .split(delimiter)
    .filter(Boolean);
}
