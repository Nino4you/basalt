// Deliberately partial. External bundles are only loaded after explicit opt-in.
export { Events, type EventRef } from "./events";
export { Component } from "./component";
export {
  Editor,
  type EditorPosition,
  type EditorSelectionRange,
  type EditorTransaction,
} from "./editor-adapter";
export { EditorExtensionRegistry } from "./editor-extensions";
export { Vault } from "./vault";
export { VaultAdapter, type AdapterStat } from "./adapter";
export { FileManager } from "./file-manager";
export { MetadataCache } from "./metadata-cache";
export { NativeVaultPort } from "./native-port";
export { type VaultStoragePort } from "./storage-port";
export { CompatibilitySession } from "./session";
export { Workspace, WorkspaceLeaf, MarkdownView } from "./workspace";
export {
  Plugin,
  PluginRegistry,
  type PluginConstructor,
  type PluginManifest,
  type PluginDataStore,
} from "./plugin";
export {
  VaultPluginBundles,
  PLUGIN_DIRECTORY,
  type PluginBundle,
  type PluginBundleListing,
} from "./plugin-bundles";
export {
  VaultPluginDataStore,
  MAX_PLUGIN_DATA_BYTES,
} from "./plugin-data";
export { PluginBundleHost } from "./plugin-host";
export { renderPluginMarkdown, type PluginRenderContext } from "./plugin-markdown";
export {
  loadPluginConstructor,
  parsePluginManifest,
  MAX_PLUGIN_SOURCE_BYTES,
  type PluginModuleHost,
} from "./plugin-module";
export {
  PluginServices,
  type PluginCommand,
  type RegisteredCommand,
} from "./plugin-services";
export {
  createObsidianApi,
  createFragment,
  installDomCompat,
  normalizePath,
  parseLinktext,
  editorInfoField,
  editorInfoEffect,
  type ObsidianApiOptions,
} from "./obsidian-api";
export { debounce, type Debouncer } from "./debounce";
export {
  FileIndex,
  TAbstractFile,
  TFile,
  TFolder,
  type FileEntry,
  type FileStats,
} from "./files";
