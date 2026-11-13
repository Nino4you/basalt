// Pure string helpers for plugins that only import Node's path module. No filesystem access.
export const pluginPath = Object.freeze({
  sep: "/",
  delimiter: ":",

  normalize(value: string): string {
    const absolute = value.startsWith("/");
    const parts: string[] = [];
    for (const part of value.split("/")) {
      if (!part || part === ".") continue;
      if (part === ".." && parts.length && parts[parts.length - 1] !== "..")
        parts.pop();
      else if (!absolute || parts.length) parts.push(part);
    }
    const result = parts.join("/");
    return absolute ? `/${result}` : result || ".";
  },

  join(...values: string[]): string {
    return this.normalize(values.filter(Boolean).join("/"));
  },

  basename(value: string, suffix?: string): string {
    const clean = value.replace(/\/+$/, "");
    const name = clean.slice(clean.lastIndexOf("/") + 1);
    return suffix && name !== suffix && name.endsWith(suffix)
      ? name.slice(0, -suffix.length)
      : name;
  },

  dirname(value: string): string {
    const normalized = this.normalize(value);
    if (normalized === "/") return "/";
    const clean = normalized.replace(/\/+$/, "");
    if (!clean || clean === ".") return ".";
    const index = clean.lastIndexOf("/");
    if (index < 0) return ".";
    return index === 0 ? "/" : clean.slice(0, index);
  },

  extname(value: string): string {
    const name = this.basename(value);
    const index = name.lastIndexOf(".");
    return index <= 0 ? "" : name.slice(index);
  },

  isAbsolute(value: string): boolean {
    return value.startsWith("/");
  },
});
