import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { icons } from "lucide";
import { hostIcons } from "../../src/ui/icon-set";
import {
  findIcon,
  iconIds,
  iconLibraryLoaded,
  loadIconLibrary,
} from "../../src/ui/icon-library";

const kebab = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === "compat" ? [] : sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("host icon set", () => {
  it("bundles every Lucide icon the host UI names in a string literal", () => {
    const lucideIds = new Map<string, string>();
    for (const name of Object.keys(icons)) {
      const id = kebab(name);
      lucideIds.set(id, name);
      lucideIds.set(id.replace(/([a-z])(\d)/, "$1-$2"), name);
    }
    const missing = new Set<string>();
    for (const file of sources("src"))
      for (const [, literal] of readFileSync(file, "utf8").matchAll(
        /["`]([a-z][a-z0-9-]*)["`]/g,
      )) {
        const name = lucideIds.get(literal!);
        if (name && !(name in hostIcons)) missing.add(`${literal} (${file})`);
      }
    expect([...missing], "add these to src/ui/icon-set.ts").toEqual([]);
  });

  it("resolves only host icons until the full library is loaded", async () => {
    expect(iconLibraryLoaded()).toBe(false);
    expect(findIcon("trash-2")).toBe(hostIcons.Trash2);
    expect(findIcon("grid-2x2")).toBeUndefined();
    await loadIconLibrary();
    expect(findIcon("grid-2x2")).toBeDefined();
    expect(findIcon("trash2")).toBe(icons.Trash2);
    expect(iconIds().length).toBeGreaterThan(1000);
  });
});
