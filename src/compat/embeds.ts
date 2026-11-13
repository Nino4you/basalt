import { Component } from "./component";
import type { TFile } from "./files";
import type { MetadataCache } from "./metadata-cache";

export type EmbedFactory = (
  context: { containerEl: HTMLElement },
  file: TFile,
  subpath: string,
) => Component & { loadFile(): unknown };

export interface PluginEmbed {
  factory: EmbedFactory;
  file: TFile;
  subpath: string;
}

/** Private Obsidian hook used by file plugins such as spreadsheet viewers. */
export class EmbedRegistry {
  private readonly extensions = new Map<string, EmbedFactory>();

  constructor(private readonly metadata: MetadataCache) {}

  registerExtension(extension: string, factory: EmbedFactory): void {
    this.extensions.set(extension.toLowerCase(), factory);
  }

  unregisterExtension(extension: string): void {
    this.extensions.delete(extension.toLowerCase());
  }

  resolve(target: string, sourcePath: string): PluginEmbed | null {
    const hash = target.indexOf("#");
    const linkpath = hash < 0 ? target : target.slice(0, hash);
    const file = this.metadata.getFirstLinkpathDest(linkpath, sourcePath);
    const factory = file && this.extensions.get(file.extension.toLowerCase());
    return file && factory
      ? { factory, file, subpath: hash < 0 ? "" : target.slice(hash) }
      : null;
  }
}

export async function mountPluginEmbed(
  embed: PluginEmbed,
  containerEl: HTMLElement,
  owner: Component,
): Promise<void> {
  const child = embed.factory({ containerEl }, embed.file, embed.subpath);
  try {
    owner.addChild(child);
    await child.loadFile();
  } catch (error) {
    await child.unloadAsync();
    throw error;
  }
}
