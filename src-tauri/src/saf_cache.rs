//! Remembers SAF document URIs so that a lookup does not list the parent folder again.
//!
//! Listing a folder through the Storage Access Framework costs one provider query that returns
//! every child, so resolving each file by listing its parent makes reading a folder quadratic.
//! This cache keeps only the name -> document URI mapping from recent listings. Stats and content
//! are always fetched fresh for the single document, and the fetched name is checked against the
//! requested one; any mismatch or failure drops the cached folder and falls back to a new listing.
//! Mutations and their safety checks never use the cache (see `android.rs`).

use std::collections::HashMap;
use std::io;
use std::time::{Duration, Instant};

/// How long a folder listing may answer lookups. It bounds how long an external move under
/// providers with opaque document IDs can go unnoticed; snapshots refill the cache anyway.
pub(crate) const LISTING_TTL: Duration = Duration::from_secs(10);

pub(crate) trait SafEntry {
    type Uri: Clone;
    fn name(&self) -> &str;
    fn uri(&self) -> &Self::Uri;
    fn is_file(&self) -> bool;
    fn is_dir(&self) -> bool;
}

/// The provider queries a lookup needs; `android.rs` implements it over `tauri-plugin-android-fs`.
pub(crate) trait SafProvider {
    type Entry: SafEntry;
    /// Resolve a folder below the vault root (`""` is the root) without the cache.
    fn resolve_dir(&self, path: &str) -> io::Result<<Self::Entry as SafEntry>::Uri>;
    fn list(&self, dir: &<Self::Entry as SafEntry>::Uri) -> io::Result<Vec<Self::Entry>>;
    /// Fresh metadata for one document.
    fn metadata(&self, uri: &<Self::Entry as SafEntry>::Uri) -> io::Result<Self::Entry>;
}

#[derive(Clone)]
enum Child<U> {
    File(U),
    Dir(U),
    /// The provider listed this name more than once; lookups must list again and fail.
    Ambiguous,
}

struct Listing<U> {
    at: Instant,
    children: HashMap<String, Child<U>>,
}

pub(crate) struct DocCache<U> {
    listings: HashMap<String, Listing<U>>,
}

impl<U: Clone> Default for DocCache<U> {
    fn default() -> Self {
        Self {
            listings: HashMap::new(),
        }
    }
}

impl<U: Clone> DocCache<U> {
    /// Record a complete listing of `dir` (vault-relative, `""` for the root).
    pub(crate) fn record<E: SafEntry<Uri = U>>(&mut self, dir: &str, entries: &[E], now: Instant) {
        let mut children = HashMap::with_capacity(entries.len());
        for entry in entries {
            let child = if entry.is_file() {
                Child::File(entry.uri().clone())
            } else if entry.is_dir() {
                Child::Dir(entry.uri().clone())
            } else {
                continue;
            };
            children
                .entry(entry.name().to_owned())
                .and_modify(|existing| *existing = Child::Ambiguous)
                .or_insert(child);
        }
        self.listings
            .insert(dir.to_owned(), Listing { at: now, children });
    }

    /// Forget one folder, e.g. after this app created or removed a child in it.
    pub(crate) fn forget(&mut self, dir: &str) {
        self.listings.remove(dir);
    }

    fn child(&mut self, dir: &str, name: &str, now: Instant) -> Option<Child<U>> {
        let listing = self.listings.get(dir)?;
        if now.saturating_duration_since(listing.at) >= LISTING_TTL {
            self.listings.remove(dir);
            return None;
        }
        listing.children.get(name).cloned()
    }

    fn file_uri(&mut self, path: &str, now: Instant) -> Option<U> {
        let (dir, name) = split(path);
        match self.child(dir, name, now)? {
            Child::File(uri) => Some(uri),
            _ => None,
        }
    }

    fn dir_uri(&mut self, path: &str, now: Instant) -> Option<U> {
        let (parent, name) = split(path);
        match self.child(parent, name, now)? {
            Child::Dir(uri) => Some(uri),
            _ => None,
        }
    }
}

/// Split a vault path into its parent folder (`""` for the root) and its final name.
pub(crate) fn split(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

/// Pick the single entry called `name`, as an uncached listing lookup would.
pub(crate) fn pick<E: SafEntry>(entries: Vec<E>, name: &str) -> io::Result<E> {
    let mut matches = entries.into_iter().filter(|entry| entry.name() == name);
    let entry = matches
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "vault entry not found"))?;
    if matches.next().is_some() {
        return Err(io::Error::other(
            "Provider returned ambiguous duplicate names",
        ));
    }
    Ok(entry)
}

/// List `dir` without trusting the cache, and remember the result.
pub(crate) fn list_fresh<P: SafProvider>(
    provider: &P,
    cache: &mut DocCache<<P::Entry as SafEntry>::Uri>,
    dir: &str,
    now: Instant,
) -> io::Result<Vec<P::Entry>> {
    let uri = provider.resolve_dir(dir)?;
    let entries = provider.list(&uri)?;
    cache.record(dir, &entries, now);
    Ok(entries)
}

/// List `dir`, resolving its URI from the parent's cached listing when possible.
fn list_cached<P: SafProvider>(
    provider: &P,
    cache: &mut DocCache<<P::Entry as SafEntry>::Uri>,
    dir: &str,
    now: Instant,
) -> io::Result<Vec<P::Entry>> {
    if !dir.is_empty()
        && let Some(uri) = cache.dir_uri(dir, now)
    {
        if let Ok(entries) = provider.list(&uri) {
            cache.record(dir, &entries, now);
            return Ok(entries);
        }
        // The folder moved or vanished: resolve it again from the root.
        cache.forget(split(dir).0);
    }
    list_fresh(provider, cache, dir, now)
}

/// Look up one vault entry for reading. A cache hit costs one single-document query instead of a
/// folder resolution plus a full listing; a miss lists the folder once and caches its children.
pub(crate) fn lookup<P: SafProvider>(
    provider: &P,
    cache: &mut DocCache<<P::Entry as SafEntry>::Uri>,
    path: &str,
    now: Instant,
) -> io::Result<P::Entry> {
    let (dir, name) = split(path);
    if let Some(uri) = cache.file_uri(path, now) {
        match provider.metadata(&uri) {
            // Re-check the name: the document may have been renamed since the listing.
            Ok(entry) if entry.is_file() && entry.name() == name => return Ok(entry),
            _ => cache.forget(dir),
        }
    }
    pick(list_cached(provider, cache, dir, now)?, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;

    #[derive(Clone, Debug, PartialEq)]
    struct FakeEntry {
        uri: u64,
        name: String,
        dir: bool,
        len: u64,
    }

    impl SafEntry for FakeEntry {
        type Uri = u64;
        fn name(&self) -> &str {
            &self.name
        }
        fn uri(&self) -> &u64 {
            &self.uri
        }
        fn is_file(&self) -> bool {
            !self.dir
        }
        fn is_dir(&self) -> bool {
            self.dir
        }
    }

    /// An opaque-ID provider: document IDs survive moves, so only the name check and the
    /// listing TTL protect against a stale mapping.
    #[derive(Default)]
    struct FakeProvider {
        /// uri -> (parent uri, entry). The root has uri 0 and no entry.
        docs: RefCell<BTreeMap<u64, (u64, FakeEntry)>>,
        next: Cell<u64>,
        lists: Cell<usize>,
        listed_entries: Cell<usize>,
        resolves: Cell<usize>,
        metadata: Cell<usize>,
    }

    impl FakeProvider {
        fn add(&self, parent: u64, name: &str, dir: bool, len: u64) -> u64 {
            let uri = self.next.get() + 1;
            self.next.set(uri);
            let entry = FakeEntry {
                uri,
                name: name.into(),
                dir,
                len,
            };
            self.docs.borrow_mut().insert(uri, (parent, entry));
            uri
        }

        fn children(&self, dir: u64) -> Vec<FakeEntry> {
            self.docs
                .borrow()
                .values()
                .filter(|(parent, _)| *parent == dir)
                .map(|(_, entry)| entry.clone())
                .collect()
        }

        fn queries(&self) -> usize {
            self.lists.get() + self.resolves.get() + self.metadata.get()
        }

        fn reset(&self) {
            self.lists.set(0);
            self.listed_entries.set(0);
            self.resolves.set(0);
            self.metadata.set(0);
        }

        /// The lookup `AndroidVault::entry` did before this cache: resolve + full listing.
        fn uncached(&self, path: &str) -> io::Result<FakeEntry> {
            let (dir, name) = split(path);
            let uri = self.resolve_dir(dir)?;
            pick(self.list(&uri)?, name)
        }
    }

    impl SafProvider for FakeProvider {
        type Entry = FakeEntry;

        fn resolve_dir(&self, path: &str) -> io::Result<u64> {
            self.resolves.set(self.resolves.get() + 1);
            let mut uri = 0;
            for part in path.split('/').filter(|part| !part.is_empty()) {
                uri = self
                    .children(uri)
                    .into_iter()
                    .find(|entry| entry.dir && entry.name == part)
                    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no folder"))?
                    .uri;
            }
            Ok(uri)
        }

        fn list(&self, dir: &u64) -> io::Result<Vec<FakeEntry>> {
            if *dir != 0 && !self.docs.borrow().contains_key(dir) {
                return Err(io::Error::new(io::ErrorKind::NotFound, "no folder"));
            }
            let entries = self.children(*dir);
            self.lists.set(self.lists.get() + 1);
            self.listed_entries
                .set(self.listed_entries.get() + entries.len());
            Ok(entries)
        }

        fn metadata(&self, uri: &u64) -> io::Result<FakeEntry> {
            self.metadata.set(self.metadata.get() + 1);
            self.docs
                .borrow()
                .get(uri)
                .map(|(_, entry)| entry.clone())
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no document"))
        }
    }

    fn folder(provider: &FakeProvider, files: usize) -> (u64, Vec<String>) {
        let notes = provider.add(0, "Notes", true, 0);
        let paths = (0..files)
            .map(|i| {
                provider.add(notes, &format!("{i}.md"), false, i as u64);
                format!("Notes/{i}.md")
            })
            .collect();
        (notes, paths)
    }

    /// `plugin_read_bytes` resolves every file three times: stat, read, stat.
    const LOOKUPS_PER_READ: usize = 3;

    #[test]
    fn reading_a_folder_lists_it_once_instead_of_three_times_per_file() {
        let provider = FakeProvider::default();
        let (_, paths) = folder(&provider, 500);

        for path in &paths {
            for _ in 0..LOOKUPS_PER_READ {
                provider.uncached(path).unwrap();
            }
        }
        let (old_lists, old_scanned) = (provider.lists.get(), provider.listed_entries.get());
        provider.reset();

        let mut cache = DocCache::default();
        let now = Instant::now();
        for path in &paths {
            for _ in 0..LOOKUPS_PER_READ {
                let entry = lookup(&provider, &mut cache, path, now).unwrap();
                assert_eq!(format!("Notes/{}", entry.name), *path);
            }
        }
        eprintln!(
            "500 files: before {old_lists} listings / {old_scanned} listed entries, \
             after {} listings / {} listed entries, {} single-document queries",
            provider.lists.get(),
            provider.listed_entries.get(),
            provider.metadata.get()
        );
        assert_eq!(old_lists, 1500);
        assert_eq!(old_scanned, 750_000);
        assert_eq!(provider.lists.get(), 1);
        assert_eq!(provider.listed_entries.get(), 500);
        // One miss lists the folder, every other lookup is a single-document query.
        assert_eq!(provider.metadata.get(), 1499);
    }

    #[test]
    fn a_recorded_snapshot_listing_answers_the_first_read_too() {
        let provider = FakeProvider::default();
        let (notes, _) = folder(&provider, 20);
        let mut cache = DocCache::default();
        let now = Instant::now();
        cache.record("", &provider.children(0), now);
        cache.record("Notes", &provider.children(notes), now);
        provider.reset();

        lookup(&provider, &mut cache, "Notes/7.md", now).unwrap();
        assert_eq!(provider.queries(), 1);
        assert_eq!(provider.metadata.get(), 1);
    }

    #[test]
    fn stats_are_always_fresh() {
        let provider = FakeProvider::default();
        let (_, _) = folder(&provider, 3);
        let mut cache = DocCache::default();
        let now = Instant::now();
        let first = lookup(&provider, &mut cache, "Notes/1.md", now).unwrap();
        provider
            .docs
            .borrow_mut()
            .get_mut(&first.uri)
            .unwrap()
            .1
            .len = 99;
        assert_eq!(
            lookup(&provider, &mut cache, "Notes/1.md", now)
                .unwrap()
                .len,
            99
        );
    }

    #[test]
    fn external_delete_rename_and_create_are_seen() {
        let provider = FakeProvider::default();
        let (notes, _) = folder(&provider, 3);
        let mut cache = DocCache::default();
        let now = Instant::now();
        let one = lookup(&provider, &mut cache, "Notes/1.md", now).unwrap();
        let two = lookup(&provider, &mut cache, "Notes/2.md", now).unwrap();

        provider.docs.borrow_mut().remove(&one.uri);
        let missing = lookup(&provider, &mut cache, "Notes/1.md", now).unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);

        provider.docs.borrow_mut().get_mut(&two.uri).unwrap().1.name = "renamed.md".into();
        let renamed = lookup(&provider, &mut cache, "Notes/2.md", now).unwrap_err();
        assert_eq!(renamed.kind(), io::ErrorKind::NotFound);
        assert_eq!(
            lookup(&provider, &mut cache, "Notes/renamed.md", now)
                .unwrap()
                .uri,
            two.uri
        );

        // A file that a sync app recreated under the old name gets a new document.
        let recreated = provider.add(notes, "1.md", false, 5);
        assert_eq!(
            lookup(&provider, &mut cache, "Notes/1.md", now)
                .unwrap()
                .uri,
            recreated
        );
    }

    #[test]
    fn a_document_moved_to_another_folder_is_not_served_from_its_old_path() {
        let provider = FakeProvider::default();
        let (_, _) = folder(&provider, 2);
        let other = provider.add(0, "Other", true, 0);
        let mut cache = DocCache::default();
        let now = Instant::now();
        let moved = lookup(&provider, &mut cache, "Notes/0.md", now).unwrap();
        // Opaque IDs keep the document and its name, so only the TTL limits this window.
        provider.docs.borrow_mut().get_mut(&moved.uri).unwrap().0 = other;
        let later = now + LISTING_TTL;
        let error = lookup(&provider, &mut cache, "Notes/0.md", later).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn duplicate_names_stay_an_error() {
        let provider = FakeProvider::default();
        let (notes, _) = folder(&provider, 1);
        provider.add(notes, "0.md", false, 1);
        let mut cache = DocCache::default();
        let now = Instant::now();
        for _ in 0..2 {
            let error = lookup(&provider, &mut cache, "Notes/0.md", now).unwrap_err();
            assert!(error.to_string().contains("ambiguous"));
        }
    }

    #[test]
    fn cached_folder_uris_avoid_resolving_nested_folders() {
        let provider = FakeProvider::default();
        let a = provider.add(0, "a", true, 0);
        let b = provider.add(a, "b", true, 0);
        provider.add(b, "note.md", false, 1);
        let mut cache = DocCache::default();
        let now = Instant::now();
        cache.record("", &provider.children(0), now);
        cache.record("a", &provider.children(a), now);
        provider.reset();

        lookup(&provider, &mut cache, "a/b/note.md", now).unwrap();
        assert_eq!(provider.resolves.get(), 0);
        assert_eq!(provider.lists.get(), 1);
    }

    #[test]
    fn a_vanished_cached_folder_is_resolved_again() {
        let provider = FakeProvider::default();
        let (notes, _) = folder(&provider, 1);
        let mut cache = DocCache::default();
        let now = Instant::now();
        cache.record("", &provider.children(0), now);
        // The folder was replaced: same name, new document, new child.
        provider
            .docs
            .borrow_mut()
            .retain(|uri, (parent, _)| *uri != notes && *parent != notes);
        let replacement = provider.add(0, "Notes", true, 0);
        let note = provider.add(replacement, "0.md", false, 3);
        assert_eq!(
            lookup(&provider, &mut cache, "Notes/0.md", now)
                .unwrap()
                .uri,
            note
        );
    }

    #[test]
    fn forget_drops_only_that_folder() {
        let provider = FakeProvider::default();
        let (notes, _) = folder(&provider, 1);
        let mut cache = DocCache::default();
        let now = Instant::now();
        cache.record("", &provider.children(0), now);
        cache.record("Notes", &provider.children(notes), now);
        cache.forget("Notes");
        provider.reset();
        lookup(&provider, &mut cache, "Notes/0.md", now).unwrap();
        assert_eq!((provider.resolves.get(), provider.lists.get()), (0, 1));
        cache = DocCache::default();
        provider.reset();
        lookup(&provider, &mut cache, "Notes/0.md", now).unwrap();
        assert_eq!((provider.resolves.get(), provider.lists.get()), (1, 1));
    }
}
