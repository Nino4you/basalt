//! Shared vault primitives. No UI, JavaScript runtime or Android framework dependencies.

use cap_std::fs::{Dir, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

/// A normalized, vault-relative path. Construct through `parse`, never from raw IPC input.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct VaultPath(String);

impl VaultPath {
    pub fn parse(value: &str) -> io::Result<Self> {
        if value.is_empty()
            || value.contains(['\\', '\0'])
            || value.chars().any(char::is_control)
            || value.split('/').any(|part| matches!(part, "" | "." | ".."))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected a relative vault path without empty, dot or parent components",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_markdown(&self) -> bool {
        self.has_extension("md")
    }

    /// JSON Canvas boards (`.canvas`), stored as UTF-8 text like notes.
    pub fn is_canvas(&self) -> bool {
        self.has_extension("canvas")
    }

    /// Text documents the app opens and edits: Markdown notes and canvases.
    pub fn is_document(&self) -> bool {
        self.is_markdown() || self.is_canvas()
    }

    fn has_extension(&self, wanted: &str) -> bool {
        Path::new(&self.0)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case(wanted))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchHit {
    pub path: VaultPath,
    /// One-based line number; previews never include HTML markup.
    pub line: usize,
    pub preview: String,
}

/// Backend contract for local directories and, later, Android's Storage Access Framework.
pub trait VaultStorage {
    /// Markdown notes and JSON canvases (see [`VaultPath::is_document`]), sorted.
    fn document_files(&self) -> io::Result<Vec<VaultPath>>;
    fn read_text(&self, path: &VaultPath) -> io::Result<String>;
    /// Must fail rather than overwrite an existing file. Parent folders must exist.
    fn create_text(&self, path: &VaultPath, text: &str) -> io::Result<()>;
    fn save_text(&self, path: &VaultPath, text: &str, expected: &str) -> io::Result<()>;
}

/// Optional attachment storage. Native IPC and Android SAF adapters must opt in explicitly.
pub trait BinaryVaultStorage: VaultStorage {
    fn read_binary(&self, path: &VaultPath) -> io::Result<Vec<u8>>;
    fn create_binary(&self, path: &VaultPath, data: &[u8]) -> io::Result<()>;
    fn save_binary(&self, path: &VaultPath, data: &[u8], expected: &[u8]) -> io::Result<()>;
}

/// Milliseconds since Unix epoch; `ctime` is creation time, falling back to modification time.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileStats {
    pub ctime: u64,
    pub mtime: u64,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntryKind {
    File,
    Folder,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileEntry {
    pub path: VaultPath,
    pub kind: EntryKind,
    pub stat: FileStats,
}

/// Metadata and exclusive single-folder creation within the selected vault capability.
pub trait MetadataVaultStorage: VaultStorage {
    /// Visible files (including attachments) and folders, never the root or symlinks.
    fn snapshot(&self) -> io::Result<Vec<FileEntry>>;
    fn stat(&self, path: &VaultPath) -> io::Result<FileStats>;
    /// Parent must already exist; an existing file or folder is an error.
    fn create_folder(&self, path: &VaultPath) -> io::Result<()>;
    /// Remove one file after backing up its observed bytes below `.basalt/trash`.
    ///
    /// The removal is refused unless the stored bytes equal `expected`, and is
    /// only attempted after that exact content has been durably backed up.
    /// Folders and symlinks are refused.
    fn remove_file(&self, _path: &VaultPath, _expected: &[u8]) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "removing files is not supported by this vault",
        ))
    }
}

pub fn timestamp_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn file_stats(metadata: &cap_std::fs::Metadata) -> io::Result<FileStats> {
    let modified = metadata.modified()?.into_std();
    Ok(FileStats {
        ctime: timestamp_millis(metadata.created().map(|t| t.into_std()).unwrap_or(modified)),
        mtime: timestamp_millis(modified),
        size: metadata.len(),
    })
}

/// Capability-scoped directory access. Paths cannot resolve outside the selected directory.
/// This is not a sandbox for plugin JavaScript; that requires a separate host policy.
pub struct DirectoryVault {
    directory: Dir,
}

impl DirectoryVault {
    /// Opening the user-selected root is the only ambient filesystem operation.
    pub fn open(root: impl AsRef<Path>) -> io::Result<Self> {
        Ok(Self {
            directory: Dir::open_ambient_dir(root, cap_std::ambient_authority())?,
        })
    }

    // Reject even in-vault symlink aliases, not only cap-std's escaping symlinks.
    // Creation may omit the final component; every parent must already exist.
    fn check_path(&self, path: &VaultPath, creating: bool) -> io::Result<()> {
        let parts: Vec<_> = path.as_str().split('/').collect();
        let mut prefix = String::new();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                prefix.push('/');
            }
            prefix.push_str(part);
            if creating && index + 1 == parts.len() {
                break;
            }
            let metadata = self.directory.symlink_metadata(&prefix)?;
            if metadata.file_type().is_symlink() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "symlink paths are not supported",
                ));
            }
            if index + 1 < parts.len() && !metadata.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::NotADirectory,
                    "parent is not a folder",
                ));
            }
        }
        Ok(())
    }

    /// Atomic replacement with a previous-version backup and optimistic conflict check.
    /// Callers must serialize writes. Uncooperative external writers can still race the final rename.
    pub fn save_text(&self, path: &VaultPath, text: &str, expected: &str) -> io::Result<()> {
        self.save_bytes(path, text.as_bytes(), expected.as_bytes(), true)
    }

    fn create_bytes(&self, path: &VaultPath, data: &[u8]) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = self.directory.open_with(path.as_str(), &options)?;
        file.write_all(data)?;
        file.sync_all()
    }

    fn save_bytes(
        &self,
        path: &VaultPath,
        data: &[u8],
        expected: &[u8],
        text: bool,
    ) -> io::Result<()> {
        if self
            .directory
            .symlink_metadata(path.as_str())?
            .file_type()
            .is_symlink()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot replace a symlink",
            ));
        }
        let current = self.directory.read(path.as_str())?;
        if text {
            std::str::from_utf8(&current)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        }
        if current != expected {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "file changed outside this editor; reload before saving",
            ));
        }
        if current == data {
            return Ok(());
        }
        let id = format!(
            "{}-{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_nanos(),
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        );
        let history = format!(".basalt/history/{}", path.as_str());
        self.directory.create_dir_all(&history)?;
        let extension = if text { "md" } else { "bin" };
        self.create_bytes(
            &VaultPath::parse(&format!("{history}/{id}.{extension}"))?,
            &current,
        )?;
        let parent = Path::new(path.as_str()).parent().unwrap_or(Path::new(""));
        let temp = parent.join(format!(".basalt-{id}.tmp"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut created = false;
        let result = (|| {
            let mut staged = self.directory.open_with(&temp, &options)?;
            created = true;
            staged.set_permissions(self.directory.metadata(path.as_str())?.permissions())?;
            staged.write_all(data)?;
            staged.sync_all()?;
            if self.directory.read(path.as_str())? != expected {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "file changed while saving; original file left untouched",
                ));
            }
            self.directory.rename(&temp, &self.directory, path.as_str())
        })();
        if result.is_err() && created {
            let _ = self.directory.remove_file(&temp);
        }
        result
    }
}

impl VaultStorage for DirectoryVault {
    fn save_text(&self, path: &VaultPath, text: &str, expected: &str) -> io::Result<()> {
        DirectoryVault::save_text(self, path, text, expected)
    }

    fn document_files(&self) -> io::Result<Vec<VaultPath>> {
        let mut files = Vec::new();
        collect_documents(&self.directory, "", &mut files, 0)?;
        files.sort();
        Ok(files)
    }

    fn read_text(&self, path: &VaultPath) -> io::Result<String> {
        self.directory.read_to_string(path.as_str())
    }

    fn create_text(&self, path: &VaultPath, text: &str) -> io::Result<()> {
        self.create_bytes(path, text.as_bytes())
    }
}

impl BinaryVaultStorage for DirectoryVault {
    fn read_binary(&self, path: &VaultPath) -> io::Result<Vec<u8>> {
        self.check_path(path, false)?;
        self.directory.read(path.as_str())
    }

    fn create_binary(&self, path: &VaultPath, data: &[u8]) -> io::Result<()> {
        self.check_path(path, true)?;
        self.create_bytes(path, data)
    }

    fn save_binary(&self, path: &VaultPath, data: &[u8], expected: &[u8]) -> io::Result<()> {
        self.check_path(path, false)?;
        self.save_bytes(path, data, expected, false)
    }
}

impl MetadataVaultStorage for DirectoryVault {
    fn snapshot(&self) -> io::Result<Vec<FileEntry>> {
        let mut entries = Vec::new();
        collect_entries(&self.directory, "", &mut entries, 0)?;
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    fn stat(&self, path: &VaultPath) -> io::Result<FileStats> {
        self.check_path(path, false)?;
        file_stats(&self.directory.symlink_metadata(path.as_str())?)
    }

    fn create_folder(&self, path: &VaultPath) -> io::Result<()> {
        self.check_path(path, true)?;
        self.directory.create_dir(path.as_str())
    }

    fn remove_file(&self, path: &VaultPath, expected: &[u8]) -> io::Result<()> {
        self.check_path(path, false)?;
        let metadata = self.directory.symlink_metadata(path.as_str())?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "only files can be removed",
            ));
        }
        // Verify before any backup exists: a rejected delete must leave the vault
        // untouched, including no trash entry for the bytes it refused.
        let current = self.directory.read(path.as_str())?;
        if current != expected {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "file changed outside this app; reload before deleting",
            ));
        }
        let id = format!(
            "{}-{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_nanos(),
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        );
        let backup = format!(".basalt/trash/{id}/{}", path.as_str());
        let parent = Path::new(&backup).parent().unwrap_or(Path::new(""));
        self.directory.create_dir_all(parent)?;
        self.create_bytes(&VaultPath::parse(&backup)?, &current)?;
        // The backup holds exactly the bytes observed above. An uncooperative
        // writer can still replace the file between this final check and the
        // unlink; like `save_bytes`, that gap is narrowed, not eliminated.
        let latest = self.directory.symlink_metadata(path.as_str())?;
        if !latest.is_file() || self.directory.read(path.as_str())? != current {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "file changed while deleting; original file left untouched",
            ));
        }
        self.directory.remove_file(path.as_str())
    }
}

fn collect_entries(
    dir: &Dir,
    prefix: &str,
    entries: &mut Vec<FileEntry>,
    depth: usize,
) -> io::Result<()> {
    if depth > 64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "vault nesting exceeds 64 folders",
        ));
    }
    for entry in dir.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 vault filename")
        })?;
        if name_text.starts_with('.') {
            continue;
        }
        let metadata = dir.symlink_metadata(&name)?;
        if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
            continue;
        }
        let path = if prefix.is_empty() {
            name_text.to_owned()
        } else {
            format!("{prefix}/{name_text}")
        };
        let parsed = VaultPath::parse(&path)?;
        entries.push(FileEntry {
            path: parsed,
            kind: if metadata.is_dir() {
                EntryKind::Folder
            } else {
                EntryKind::File
            },
            stat: file_stats(&metadata)?,
        });
        if metadata.is_dir() {
            collect_entries(&dir.open_dir(&name)?, &path, entries, depth + 1)?;
        }
    }
    Ok(())
}

fn collect_documents(
    dir: &Dir,
    prefix: &str,
    files: &mut Vec<VaultPath>,
    depth: usize,
) -> io::Result<()> {
    if depth > 64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "vault nesting exceeds 64 folders",
        ));
    }
    for entry in dir.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 vault filename")
        })?;
        if name_text.starts_with('.') {
            continue;
        }
        let path = if prefix.is_empty() {
            name_text.to_owned()
        } else {
            format!("{prefix}/{name_text}")
        };
        let kind = entry.file_type()?;
        // Do not traverse symlink directories or produce duplicate/cyclic listings.
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect_documents(&dir.open_dir(&name)?, &path, files, depth + 1)?;
        } else if kind.is_file() {
            let path = VaultPath::parse(&path)?;
            if path.is_document() {
                files.push(path);
            }
        }
    }
    Ok(())
}

/// Case-insensitive, line-based plain-text search. Not a Markdown parser or full-text index.
pub fn search(storage: &impl VaultStorage, query: &str) -> io::Result<Vec<SearchHit>> {
    if query.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "empty search query",
        ));
    }
    let needle = query.to_lowercase();
    let mut hits = Vec::new();
    for path in storage.document_files()? {
        if !path.is_markdown() {
            continue;
        }
        for (line, text) in storage.read_text(&path)?.lines().enumerate() {
            if text.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: path.clone(),
                    line: line + 1,
                    preview: text.to_owned(),
                });
            }
        }
    }
    Ok(hits)
}
