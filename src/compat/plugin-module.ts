import type { PluginManifest } from "./plugin";
import { Plugin, type PluginConstructor } from "./plugin";

/** Main bundles larger than this are rejected before evaluation. */
export const MAX_PLUGIN_SOURCE_BYTES = 8 * 1024 * 1024;

export interface PluginModuleHost {
  /** The host-owned `obsidian` module. Plugins must share these classes. */
  obsidian: Record<string, unknown>;
  /** Extra modules that the host explicitly exposes, keyed by their require id. */
  modules?: Readonly<Record<string, unknown>>;
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Validate a manifest before it becomes part of the plugin registry. The
 * folder id is authoritative, so a bundle cannot impersonate another plugin.
 */
export function parsePluginManifest(
  value: unknown,
  expectedId?: string,
): Readonly<PluginManifest> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Plugin manifest must be an object");
  const candidate = value as Partial<PluginManifest>;
  if (typeof candidate.id !== "string" || !PLUGIN_ID.test(candidate.id))
    throw new Error("Plugin manifest has an invalid id");
  if (expectedId !== undefined && candidate.id !== expectedId)
    throw new Error(
      `Plugin manifest id "${candidate.id}" does not match its folder "${expectedId}"`,
    );
  if (typeof candidate.name !== "string" || !candidate.name.trim())
    throw new Error("Plugin manifest is missing a name");
  if (typeof candidate.version !== "string" || !candidate.version.trim())
    throw new Error("Plugin manifest is missing a version");
  if (
    candidate.minAppVersion !== undefined &&
    (typeof candidate.minAppVersion !== "string" ||
      !candidate.minAppVersion.trim())
  )
    throw new Error("Plugin manifest has an invalid minAppVersion");
  if (
    candidate.isDesktopOnly !== undefined &&
    typeof candidate.isDesktopOnly !== "boolean"
  )
    throw new Error("Plugin manifest has an invalid isDesktopOnly flag");
  return Object.freeze({
    id: candidate.id,
    name: candidate.name.trim(),
    version: candidate.version.trim(),
    ...(candidate.minAppVersion !== undefined
      ? { minAppVersion: candidate.minAppVersion.trim() }
      : {}),
    ...(candidate.isDesktopOnly !== undefined
      ? { isDesktopOnly: candidate.isDesktopOnly }
      : {}),
  });
}

/**
 * Evaluate one explicitly installed CommonJS bundle. This is deliberately not
 * a generic script runner: the module factory only receives `obsidian`, an
 * opt-in module table and a synthetic CommonJS wrapper. No Node globals or
 * ambient `require` exist inside the wrapper.
 */
export function loadPluginConstructor(
  source: string,
  id: string,
  host: PluginModuleHost,
): PluginConstructor {
  if (!PLUGIN_ID.test(id)) throw new Error("Invalid plugin id");
  if (typeof source !== "string" || !source.trim())
    throw new Error("Plugin bundle is empty");
  if (new TextEncoder().encode(source).byteLength > MAX_PLUGIN_SOURCE_BYTES)
    throw new Error("Plugin bundle exceeds the 8 MiB limit");
  if (!host.obsidian || typeof host.obsidian !== "object")
    throw new Error("Plugin module host is missing the obsidian API");

  const syntheticModule: { exports: unknown } = { exports: {} };
  const require = (specifier: string): unknown => {
    if (specifier === "obsidian") return host.obsidian;
    if (host.modules && Object.hasOwn(host.modules, specifier))
      return host.modules[specifier];
    throw new Error(
      `Plugin "${id}" requested an unavailable module: ${specifier}`,
    );
  };
  let factory: (...args: unknown[]) => unknown;
  try {
    // eslint-disable-next-line no-new-func
    factory = new Function(
      "module",
      "exports",
      "require",
      `${source}\n//# sourceURL=basalt-plugin://${id}/main.js`,
    ) as (...args: unknown[]) => unknown;
  } catch (error) {
    throw new Error(
      `Plugin "${id}" could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    factory.call(
      syntheticModule.exports,
      syntheticModule,
      syntheticModule.exports,
      require,
    );
  } catch (error) {
    throw new Error(
      `Plugin "${id}" failed while loading its module: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const exported = syntheticModule.exports as
    { default?: unknown } | ((...args: unknown[]) => unknown);
  const candidate =
    typeof exported === "function"
      ? exported
      : exported &&
          typeof exported === "object" &&
          typeof (exported as { default?: unknown }).default === "function"
        ? (exported as { default: unknown }).default
        : null;
  if (typeof candidate !== "function")
    throw new Error(
      `Plugin "${id}" does not export a plugin constructor (module.exports)`,
    );
  if (
    !(candidate as { prototype?: object }).prototype ||
    !((candidate as { prototype: object }).prototype instanceof Plugin)
  )
    throw new Error(
      `Plugin "${id}" must extend the host's obsidian.Plugin class`,
    );
  return candidate as PluginConstructor;
}
