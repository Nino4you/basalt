# Syncing a vault

Basalt has no sync service of its own. A vault is a plain folder, so any tool that syncs folders
works: Syncthing, Nextcloud, Dropbox, a Git repository, or a USB stick.

## What Basalt does for you

- **Changes from other programs show up.** The app reloads the vault when it comes back to the
  foreground and, on Linux, when its window gets focus again, at most every few seconds. An open
  note that changed on disk is reloaded; if you were editing it, your draft is kept and the
  note is marked as changed outside the editor instead of being overwritten.
- **Saves never overwrite blindly.** Every save checks that the file still has the content it was
  loaded with. Previous versions go to `.basalt/history/` (see File recovery).
- **Conflict copies are found.** When a sync tool could not merge two edits, it writes a copy
  next to the file. Basalt recognizes the names used by Syncthing
  (`Note.sync-conflict-20261114-093000-ABCDEFG.md`) and by Nextcloud, ownCloud and Dropbox
  (`Note (conflicted copy 2026-11-14 093000).md`), and notes that still contain Git merge
  markers (`<<<<<<<`, `=======`, `>>>>>>>`). A notice and the status bar point them out; the
  command **Show sync conflicts** lists them. There you can compare a copy with the original
  line by line, use the copy (the original is backed up first, the copy goes to the vault trash)
  or delete the copy. Basalt never resolves a conflict on its own.

## Recommendations

- Exclude `.basalt/` from sync if you do not want every device's backups on every other device.
  Each device keeps its own history either way.
- `Basalt/Config/` (themes, snippets, `appearance.json`) and `Basalt/Plugins/` are ordinary
  folders; sync them if all devices should share plugins and the look.
- With Git, commit from outside the app and pull while Basalt is in the background; on return it
  picks up the new files.
