import { t } from "../i18n";
import {
  attachmentFolder,
  attachmentLink,
  attachmentName,
  availablePath,
  MAX_ATTACHMENT_BYTES,
} from "../attachments";
import { TFile } from "../compat/files";
import type { Vault } from "../compat/vault";
import { notify } from "../ui/notice";

/** Creates `folder` and its missing parents in the vault. */
async function ensureVaultFolder(vault: Vault, folder: string): Promise<void> {
  const parts = folder ? folder.split("/") : [];
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join("/");
    if (!vault.getAbstractFileByPath(path)) await vault.createFolder(path);
  }
}

/**
 * Stores pasted or dropped files next to `sourcePath` according to the
 * attachment folder setting and returns the Markdown that links them, one
 * per line. Files are created exclusively and never replace anything; a file
 * that fails is reported and skipped. Returns null when none was stored.
 */
export async function importAttachments(
  vault: Vault | null,
  files: File[],
  options: { sourcePath: string; folderSetting: string; pasted: boolean },
): Promise<string | null> {
  if (!vault) {
    notify(t("Anhänge können nur in der nativen App eingefügt werden."), true);
    return null;
  }
  const folder = attachmentFolder(options.folderSetting, options.sourcePath);
  const links: string[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      notify(
        t("{name} ist größer als 64 MiB und wurde nicht eingefügt.", {
          name: file.name || t("Datei"),
        }),
        true,
      );
      continue;
    }
    try {
      await ensureVaultFolder(vault, folder);
      const name = attachmentName(file.name, file.type, options.pasted);
      const path = availablePath(
        folder,
        name,
        (candidate) => !!vault.getAbstractFileByPath(candidate),
      );
      await vault.createBinary(path, await file.arrayBuffer());
      const all = vault
        .getAllLoadedFiles()
        .filter((entry): entry is TFile => entry instanceof TFile)
        .map((entry) => entry.path);
      links.push(attachmentLink(path, all));
    } catch (error) {
      notify(
        t("{name} konnte nicht eingefügt werden: {error}", {
          name: file.name || t("Datei"),
          error: error instanceof Error ? error.message : String(error),
        }),
        true,
      );
    }
  }
  return links.length ? links.join("\n") : null;
}
