use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use vault_core::{
    Backup, BackupKind, BinaryVaultStorage, DirectoryVault, EntryKind, MetadataVaultStorage,
    VaultPath, VaultStorage, list_backups, read_backup, remove_backup, search,
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
        "Bücher.base",
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
            path("Bücher.base"),
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
    assert!(path("Books.BASE").is_base());
    assert!(path("Books.base").is_document());
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

#[test]
fn backups_are_listed_newest_first_and_read_back_exactly() {
    let fixture = Fixture::new();
    let vault = fixture.vault();
    assert!(list_backups(&vault).unwrap().is_empty());
    fs::create_dir(fixture.0.join("Notes")).unwrap();
    let note = path("Notes/a.md");
    vault.create_text(&note, "one").unwrap();
    vault.save_text(&note, "two", "one").unwrap();
    vault.save_text(&note, "three", "two").unwrap();
    let doomed = path("gone.canvas");
    vault.create_text(&doomed, "{}").unwrap();
    vault.remove_file(&doomed, b"{}").unwrap();

    let backups = list_backups(&vault).unwrap();
    assert_eq!(backups.len(), 3);
    assert!(backups.windows(2).all(|pair| pair[0].time >= pair[1].time));
    assert!(backups.iter().all(|backup| backup.time > 1_600_000_000_000));
    let versions: Vec<_> = backups
        .iter()
        .filter(|backup| backup.kind == BackupKind::Version)
        .collect();
    assert_eq!(versions.len(), 2);
    assert!(versions.iter().all(|backup| backup.original == note));
    let texts: Vec<_> = versions
        .iter()
        .map(|backup| read_backup(&vault, &backup.location).unwrap())
        .collect();
    assert_eq!(texts, ["two", "one"]);
    assert_eq!(versions[0].size, 3);

    let deleted = backups
        .iter()
        .find(|backup| backup.kind == BackupKind::Deleted)
        .unwrap();
    assert_eq!(deleted.original, doomed);
    assert_eq!(read_backup(&vault, &deleted.location).unwrap(), "{}");
}

#[test]
fn only_backup_locations_of_documents_can_be_read() {
    let fixture = Fixture::new();
    let vault = fixture.vault();
    vault.create_text(&path("note.md"), "secret").unwrap();
    let binary = path("drawing.ink");
    vault.create_binary(&binary, b"a").unwrap();
    vault.save_binary(&binary, b"b", b"a").unwrap();
    fs::create_dir_all(fixture.0.join(".basalt/history/.hidden.md")).unwrap();
    fs::write(fixture.0.join(".basalt/history/.hidden.md/1-0.md"), "x").unwrap();

    let backups = list_backups(&vault).unwrap();
    assert_eq!(backups.len(), 1, "hidden originals are not backups");
    assert_eq!(backups[0].original, binary);
    for location in [
        "note.md",
        ".basalt/history/.hidden.md/1-0.md",
        ".basalt/other/note.md",
        backups[0].location.as_str(),
    ] {
        let error = read_backup(&vault, &path(location)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{location}");
    }
}

#[test]
fn backup_locations_parse_both_layouts() {
    let version = Backup::parse(
        &path(".basalt/history/A/b.md/1700000000123456789-42-0.md"),
        7,
    )
    .unwrap();
    assert_eq!(version.kind, BackupKind::Version);
    assert_eq!(version.original, path("A/b.md"));
    assert_eq!(version.time, 1_700_000_000_123);
    assert_eq!(version.size, 7);
    let deleted =
        Backup::parse(&path(".basalt/trash/1700000000000000000-3/A/c.canvas"), 0).unwrap();
    assert_eq!(deleted.kind, BackupKind::Deleted);
    assert_eq!(deleted.original, path("A/c.canvas"));
    assert_eq!(deleted.time, 1_700_000_000_000);
    let unknown_id = Backup::parse(&path(".basalt/trash/some-uuid/n.md"), 0).unwrap();
    assert_eq!(unknown_id.time, 0);
    for location in [
        ".basalt/history/a.md",
        ".basalt/history/a.md/1.txt",
        ".basalt/trash/1",
        ".basalt/history2/a.md/1.md",
        "notes/a.md",
    ] {
        assert!(Backup::parse(&path(location), 0).is_none(), "{location}");
    }
}

#[cfg(unix)]
#[test]
fn backup_listing_ignores_symlinks() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    fs::create_dir_all(outside.0.join("a.md")).unwrap();
    fs::write(outside.0.join("a.md/1-0.md"), "outside").unwrap();
    fs::create_dir(fixture.0.join(".basalt")).unwrap();
    std::os::unix::fs::symlink(&outside.0, fixture.0.join(".basalt/history")).unwrap();
    assert!(list_backups(&fixture.vault()).unwrap().is_empty());

    fs::remove_file(fixture.0.join(".basalt/history")).unwrap();
    fs::create_dir_all(fixture.0.join(".basalt/history/b.md")).unwrap();
    std::os::unix::fs::symlink(
        outside.0.join("a.md/1-0.md"),
        fixture.0.join(".basalt/history/b.md/2-0.md"),
    )
    .unwrap();
    assert!(list_backups(&fixture.vault()).unwrap().is_empty());
    let error = read_backup(&fixture.vault(), &path(".basalt/history/b.md/2-0.md")).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn unbacked_saves_keep_the_conflict_check_but_skip_the_history() {
    let fixture = Fixture::new();
    let vault = fixture.vault();
    let note = path("note.md");
    vault.create_text(&note, "one").unwrap();
    vault.save_text_unbacked(&note, "two", "one").unwrap();
    assert_eq!(vault.read_text(&note).unwrap(), "two");
    assert!(!fixture.0.join(".basalt").exists());
    let error = vault.save_text_unbacked(&note, "three", "one").unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(vault.read_text(&note).unwrap(), "two");
    vault.save_text(&note, "three", "two").unwrap();
    assert_eq!(list_backups(&vault).unwrap().len(), 1);
}

#[test]
fn removing_backups_deletes_only_backups_and_tidies_empty_folders() {
    let fixture = Fixture::new();
    let vault = fixture.vault();
    fs::create_dir(fixture.0.join("Notes")).unwrap();
    let note = path("Notes/a.md");
    vault.create_text(&note, "one").unwrap();
    vault.save_text(&note, "two", "one").unwrap();
    vault.save_text(&note, "three", "two").unwrap();
    let doomed = path("Notes/gone.md");
    vault.create_text(&doomed, "bye").unwrap();
    vault.remove_file(&doomed, b"bye").unwrap();

    for refused in [
        "Notes/a.md",
        ".basalt/other/x.md",
        ".basalt/history/.hidden/1-0.md",
    ] {
        let error = remove_backup(&vault, &path(refused)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{refused}");
    }
    assert_eq!(vault.read_text(&note).unwrap(), "three");

    let backups = list_backups(&vault).unwrap();
    assert_eq!(backups.len(), 3);
    for backup in &backups {
        remove_backup(&vault, &backup.location).unwrap();
    }
    assert!(list_backups(&vault).unwrap().is_empty());
    assert_eq!(vault.read_text(&note).unwrap(), "three");
    // Empty per-file and per-deletion folders go; the backup roots stay.
    assert!(!fixture.0.join(".basalt/history/Notes").exists());
    assert!(fixture.0.join(".basalt/history").is_dir());
    assert_eq!(
        fs::read_dir(fixture.0.join(".basalt/trash"))
            .unwrap()
            .count(),
        0
    );
    let error = remove_backup(&vault, &backups[0].location).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
}

#[cfg(unix)]
#[test]
fn removing_backups_refuses_symlinked_folders() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("Notes/a.md")).unwrap();
    fs::write(fixture.0.join("Notes/a.md/1-0.md"), "content").unwrap();
    fs::create_dir_all(fixture.0.join(".basalt/history")).unwrap();
    std::os::unix::fs::symlink(
        fixture.0.join("Notes/a.md"),
        fixture.0.join(".basalt/history/a.md"),
    )
    .unwrap();
    let error = remove_backup(&fixture.vault(), &path(".basalt/history/a.md/1-0.md")).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert!(fixture.0.join("Notes/a.md/1-0.md").exists());
}
