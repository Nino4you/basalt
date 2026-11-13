use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use vault_core::{
    BinaryVaultStorage, DirectoryVault, EntryKind, MetadataVaultStorage, VaultPath, VaultStorage,
    search,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "basalt-test-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn vault(&self) -> DirectoryVault {
        DirectoryVault::open(&self.0).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Only remove this test's uniquely-created directory, never a user-provided path.
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn path(value: &str) -> VaultPath {
    VaultPath::parse(value).unwrap()
}

#[test]
fn rejects_ambiguous_and_escaping_paths() {
    for value in [
        "",
        "/etc/passwd",
        "../note.md",
        "a/../b",
        "./a",
        "a//b",
        "a/",
        "a\\b",
        "x\0y",
        "new\nline.md",
        "tab\tname.md",
    ] {
        assert!(VaultPath::parse(value).is_err(), "accepted {value:?}");
    }
    assert_eq!(path("Notizen/Grüße.md").as_str(), "Notizen/Grüße.md");
}

#[test]
fn rejects_excessive_directory_depth() {
    let f = Fixture::new();
    let mut current = f.0.clone();
    for _ in 0..66 {
        current.push("nested");
        fs::create_dir(&current).unwrap();
    }
    assert!(f.vault().document_files().is_err());
    assert!(f.vault().snapshot().is_err());
}

#[test]
fn snapshot_includes_visible_attachments_and_empty_folders_with_stats() {
    let f = Fixture::new();
    let vault = f.vault();
    vault.create_folder(&path("Attachments")).unwrap();
    vault.create_folder(&path("Empty")).unwrap();
    vault.create_folder(&path(".obsidian")).unwrap();
    vault
        .create_binary(&path("Attachments/drawing.ink"), &[0, 255, 128])
        .unwrap();
    vault.create_binary(&path("sheet.xlsx"), &[1, 2]).unwrap();
    vault.create_text(&path("note.md"), "hello").unwrap();
    vault
        .create_text(&path(".obsidian/secrets.md"), "secret")
        .unwrap();
    vault
        .create_binary(&path("Attachments/.hidden"), b"secret")
        .unwrap();
    let entries = vault.snapshot().unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.kind))
            .collect::<Vec<_>>(),
        vec![
            ("Attachments", EntryKind::Folder),
            ("Attachments/drawing.ink", EntryKind::File),
            ("Empty", EntryKind::Folder),
            ("note.md", EntryKind::File),
            ("sheet.xlsx", EntryKind::File),
        ]
    );
    let ink = &entries[1];
    assert_eq!(
        ink.stat,
        vault.stat(&path("Attachments/drawing.ink")).unwrap()
    );
    assert_eq!(ink.stat.size, 3);
    assert!(ink.stat.ctime > 0);
    assert!(ink.stat.mtime > 0);
    assert_eq!(entries[4].stat.size, 2);
}

#[test]
fn remove_file_checks_expected_bytes_before_backup_and_refuses_folders() {
    let f = Fixture::new();
    let vault = f.vault();
    vault.create_text(&path("note.md"), "important").unwrap();

    // A stale expected version must neither delete the file nor leave trash.
    let stale = vault.remove_file(&path("note.md"), b"stale").unwrap_err();
    assert_eq!(stale.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(
        fs::read_to_string(f.0.join("note.md")).unwrap(),
        "important"
    );
    assert!(!f.0.join(".basalt").exists());

    vault.remove_file(&path("note.md"), b"important").unwrap();
    assert!(!f.0.join("note.md").exists());

    fn find_note(root: &std::path::Path) -> Option<PathBuf> {
        for entry in fs::read_dir(root).ok()? {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = find_note(&path) {
                    return Some(found);
                }
            } else if path.file_name().is_some_and(|name| name == "note.md") {
                return Some(path);
            }
        }
        None
    }
    let backup = find_note(&f.0.join(".basalt/trash")).expect("backup file");
    assert_eq!(fs::read_to_string(backup).unwrap(), "important");

    vault.create_folder(&path("folder")).unwrap();
    assert!(vault.remove_file(&path("folder"), b"").is_err());
    assert!(vault.remove_file(&path("missing.md"), b"").is_err());
}

#[test]
fn folder_creation_is_exclusive_and_never_creates_parents() {
    let f = Fixture::new();
    let vault = f.vault();
    assert!(vault.create_folder(&path("missing/child")).is_err());
    assert!(!f.0.join("missing").exists());
    vault.create_folder(&path("folder")).unwrap();
    assert_eq!(
        vault.create_folder(&path("folder")).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    vault.create_folder(&path("folder/child")).unwrap();
    vault.create_binary(&path("file.ink"), &[128]).unwrap();
    assert!(vault.create_folder(&path("file.ink")).is_err());
    assert!(vault.create_folder(&path("file.ink/child")).is_err());
    assert!(vault.create_binary(&path("folder"), b"overwrite").is_err());
    assert!(
        vault
            .create_binary(&path("missing/file.xlsx"), b"data")
            .is_err()
    );
    assert!(vault.stat(&path("missing")).is_err());
    assert_eq!(vault.read_binary(&path("file.ink")).unwrap(), [128]);
}

#[test]
fn snapshot_allows_exactly_sixty_four_nested_folders() {
    let f = Fixture::new();
    let mut current = f.0.clone();
    for _ in 0..64 {
        current.push("d");
        fs::create_dir(&current).unwrap();
    }
    fs::write(current.join("attachment.xlsx"), [0, 255]).unwrap();
    assert_eq!(f.vault().snapshot().unwrap().len(), 65);
    fs::create_dir(current.join("too-deep")).unwrap();
    assert!(f.vault().snapshot().is_err());
}

#[test]
fn lists_only_visible_documents_in_sorted_order() {
    let f = Fixture::new();
    fs::create_dir(f.0.join("Notizen")).unwrap();
    fs::create_dir(f.0.join(".obsidian")).unwrap();
    for name in [
        "z.md",
        "Notizen/ä.MD",
        "image.png",
        "Board.canvas",
        "Notizen/Board.CANVAS",
        "data.json",
        ".hidden.md",
        ".obsidian/config.md",
    ] {
        fs::write(f.0.join(name), "test").unwrap();
    }
    assert_eq!(
        f.vault().document_files().unwrap(),
        vec![
            path("Board.canvas"),
            path("Notizen/Board.CANVAS"),
            path("Notizen/ä.MD"),
            path("z.md")
        ]
    );
}

#[test]
fn canvases_are_documents_but_not_searched_as_markdown() {
    let f = Fixture::new();
    fs::write(f.0.join("Board.canvas"), r#"{"nodes":[{"text":"Basalt"}]}"#).unwrap();
    fs::write(f.0.join("note.md"), "Basalt").unwrap();
    assert!(path("Board.CANVAS").is_canvas());
    assert!(path("Board.canvas").is_document());
    assert!(!path("Board.canvas").is_markdown());
    let hits = search(&f.vault(), "basalt").unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, path("note.md"));
}

#[test]
fn reads_utf8_and_preserves_markdown_exactly() {
    let f = Fixture::new();
    let text = "# Grüße\r\n\r\n![[Tabelle.xlsx]]\n```ink\nabc\n```\n";
    fs::write(f.0.join("note.md"), text).unwrap();
    assert_eq!(f.vault().read_text(&path("note.md")).unwrap(), text);
}

#[test]
fn creates_without_overwriting_existing_content() {
    let f = Fixture::new();
    let vault = f.vault();
    vault.create_text(&path("note.md"), "original").unwrap();
    let err = vault
        .create_text(&path("note.md"), "replacement")
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(vault.read_text(&path("note.md")).unwrap(), "original");
}

#[test]
fn missing_parent_or_file_is_an_error() {
    let f = Fixture::new();
    assert!(
        f.vault()
            .create_text(&path("missing/note.md"), "x")
            .is_err()
    );
    assert!(f.vault().read_text(&path("missing.md")).is_err());
}

#[test]
fn saves_atomically_with_a_previous_version_backup() {
    let f = Fixture::new();
    let vault = f.vault();
    vault.create_text(&path("note.md"), "before").unwrap();
    vault
        .save_text(&path("note.md"), "after", "before")
        .unwrap();
    assert_eq!(vault.read_text(&path("note.md")).unwrap(), "after");
    let backups: Vec<_> = fs::read_dir(f.0.join(".basalt/history/note.md"))
        .unwrap()
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        fs::read_to_string(backups[0].as_ref().unwrap().path()).unwrap(),
        "before"
    );
    assert_eq!(vault.document_files().unwrap(), vec![path("note.md")]);
}

#[test]
fn conflicting_save_leaves_external_changes_untouched() {
    let f = Fixture::new();
    let vault = f.vault();
    vault
        .create_text(&path("note.md"), "external change")
        .unwrap();
    assert!(
        vault
            .save_text(&path("note.md"), "my changes", "old version")
            .is_err()
    );
    assert_eq!(
        vault.read_text(&path("note.md")).unwrap(),
        "external change"
    );
}

#[test]
fn unchanged_save_does_not_create_a_backup() {
    let f = Fixture::new();
    let vault = f.vault();
    vault.create_text(&path("note.md"), "same").unwrap();
    vault.save_text(&path("note.md"), "same", "same").unwrap();
    assert!(!f.0.join(".basalt").exists());
}

#[test]
fn binary_roundtrip_preserves_non_utf8_data_and_empty_files() {
    let f = Fixture::new();
    let vault = f.vault();
    let original = [0, 255, 128, 42, 13, 10];
    vault
        .create_binary(&path("attachment.dat"), &original)
        .unwrap();
    assert_eq!(
        vault.read_binary(&path("attachment.dat")).unwrap(),
        original
    );
    assert!(vault.read_text(&path("attachment.dat")).is_err());
    vault.create_binary(&path("empty.dat"), &[]).unwrap();
    assert!(vault.read_binary(&path("empty.dat")).unwrap().is_empty());
    assert!(vault.document_files().unwrap().is_empty());
}

#[test]
fn binary_create_never_overwrites_and_binary_save_keeps_an_exact_backup() {
    let f = Fixture::new();
    let vault = f.vault();
    let original = [255, 0, 128];
    vault.create_binary(&path("data.dat"), &original).unwrap();
    assert!(
        vault
            .create_binary(&path("data.dat"), b"overwrite")
            .is_err()
    );
    vault
        .save_binary(&path("data.dat"), &[42, 0], &original)
        .unwrap();
    assert_eq!(vault.read_binary(&path("data.dat")).unwrap(), [42, 0]);
    let backup = fs::read_dir(f.0.join(".basalt/history/data.dat"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(backup.extension().unwrap(), "bin");
    assert_eq!(fs::read(backup).unwrap(), original);
}

#[test]
fn binary_conflicts_preserve_external_changes() {
    let f = Fixture::new();
    let vault = f.vault();
    vault.create_binary(&path("data.dat"), &[1, 2, 3]).unwrap();
    assert!(
        vault
            .save_binary(&path("data.dat"), &[10], &[0, 0, 0])
            .is_err()
    );
    assert_eq!(vault.read_binary(&path("data.dat")).unwrap(), [1, 2, 3]);
}

#[test]
fn search_returns_unicode_matches_with_one_based_lines() {
    let f = Fixture::new();
    fs::write(
        f.0.join("a.md"),
        "# Hallo\nGrüße aus Android\nLinux und ANDROID\n",
    )
    .unwrap();
    let vault = f.vault();
    let hits = search(&vault, "android").unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].line, 2);
    assert_eq!(hits[1].line, 3);
    assert_eq!(search(&vault, "GRÜẞE").unwrap()[0].line, 2);
    assert!(search(&vault, "  ").is_err());
}

#[test]
fn opening_a_missing_directory_does_not_create_it() {
    let f = Fixture::new();
    assert!(DirectoryVault::open(f.0.join("missing")).is_err());
    assert!(!f.0.join("missing").exists());
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_read_or_create_outside_the_vault() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = Fixture::new();
    fs::write(outside.0.join("secret.md"), "private").unwrap();
    symlink(&outside.0, f.0.join("escape")).unwrap();
    symlink(outside.0.join("secret.md"), f.0.join("linked.md")).unwrap();
    let vault = f.vault();
    assert!(vault.read_text(&path("escape/secret.md")).is_err());
    assert!(vault.read_text(&path("linked.md")).is_err());
    assert!(vault.read_binary(&path("linked.md")).is_err());
    assert!(
        vault
            .save_binary(&path("linked.md"), b"replacement", b"private")
            .is_err()
    );
    assert!(vault.create_text(&path("escape/new.md"), "no").is_err());
    assert!(!outside.0.join("new.md").exists());
    assert_eq!(fs::read(outside.0.join("secret.md")).unwrap(), b"private");
    assert!(vault.document_files().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn listing_does_not_follow_symlink_loops() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    fs::write(f.0.join("note.md"), "hello").unwrap();
    symlink(".", f.0.join("loop")).unwrap();
    assert_eq!(f.vault().document_files().unwrap(), vec![path("note.md")]);
    assert_eq!(f.vault().snapshot().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn binary_and_metadata_apis_reject_symlinks_even_within_the_vault() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = Fixture::new();
    let vault = f.vault();
    vault.create_folder(&path("real")).unwrap();
    vault
        .create_binary(&path("real/file.xlsx"), b"before")
        .unwrap();
    symlink("real", f.0.join("alias")).unwrap();
    symlink("real/file.xlsx", f.0.join("linked.xlsx")).unwrap();
    symlink(&outside.0, f.0.join("escape")).unwrap();
    for target in ["alias/file.xlsx", "linked.xlsx"] {
        assert!(vault.read_binary(&path(target)).is_err());
        assert!(vault.stat(&path(target)).is_err());
        assert!(
            vault
                .save_binary(&path(target), b"after", b"before")
                .is_err()
        );
        assert!(vault.remove_file(&path(target), b"before").is_err());
    }
    assert!(!f.0.join(".basalt").exists());
    assert!(vault.create_binary(&path("alias/new.ink"), b"no").is_err());
    assert!(vault.create_folder(&path("alias/child")).is_err());
    assert!(vault.create_folder(&path("escape/child")).is_err());
    assert!(vault.stat(&path("escape")).is_err());
    assert!(!outside.0.join("child").exists());
    assert!(!f.0.join("real/child").exists());
    assert_eq!(
        vault.read_binary(&path("real/file.xlsx")).unwrap(),
        b"before"
    );
    assert_eq!(
        vault
            .snapshot()
            .unwrap()
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["real", "real/file.xlsx"]
    );
}
