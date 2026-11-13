//! Read-only resource URLs for files in an activated plugin's own folder.
//!
//! Some plugins hand `adapter.getResourcePath(...)` URLs to code
//! that can only fetch by URL (tesseract.js loads its language data from a
//! `langPath` folder inside a worker). Obsidian serves the whole vault through
//! `app://`; Basalt deliberately serves far less:
//!
//! - only `Basalt/Plugins/<id>/…` of a plugin the frontend activated in the
//!   current vault session, through a random per-plugin grant token;
//! - grants live in the session, so choosing another vault drops all of them,
//!   and disabling a plugin revokes its token;
//! - `GET`/`HEAD` only, no listings, no hidden paths, the same `VaultPath`,
//!   symlink and 64 MiB rules as `plugin_vault_read`;
//! - bytes are always `application/octet-stream` with `nosniff` and a
//!   `sandbox` CSP, and the WebView CSP lists this scheme only in
//!   `connect-src`, so these URLs cannot become scripts, images or frames.

use std::collections::HashMap;
use tauri::http::{Method, Request, Response, StatusCode, header};

pub const SCHEME: &str = "basalt-resource";

/// Tauri maps custom schemes to `http://<scheme>.localhost` where the WebView
/// cannot register real schemes (Windows, Android).
#[cfg(any(windows, target_os = "android"))]
const ORIGIN: &str = "http://basalt-resource.localhost";
#[cfg(not(any(windows, target_os = "android")))]
const ORIGIN: &str = "basalt-resource://localhost";

/// Origins of Basalt's own pages, the only ones allowed to read responses
/// cross-origin. The dev server origin is only accepted in debug builds.
const APP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    #[cfg(debug_assertions)]
    "http://localhost:1420",
];

const PLUGIN_ROOT: &str = "Basalt/Plugins";

/// Grant tokens of the current vault session: token -> plugin id.
#[derive(Default)]
pub struct Grants {
    tokens: HashMap<String, String>,
}

pub fn valid_plugin_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    matches!(bytes.next(), Some(b) if b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

impl Grants {
    /// Returns the base URL (ending in `/`) for the plugin's folder. Granting
    /// again keeps the existing token so URLs stay stable while it is active.
    pub fn grant(&mut self, plugin_id: &str) -> Result<String, String> {
        if !valid_plugin_id(plugin_id) {
            return Err("Invalid plugin id".into());
        }
        let token = match self.tokens.iter().find(|(_, id)| *id == plugin_id) {
            Some((token, _)) => token.clone(),
            None => {
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
                let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                self.tokens.insert(token.clone(), plugin_id.to_owned());
                token
            }
        };
        Ok(format!("{ORIGIN}/{token}/"))
    }

    pub fn revoke(&mut self, plugin_id: &str) {
        self.tokens.retain(|_, id| id != plugin_id);
    }

    /// Maps a request path (`/<token>/<encoded segments…>`) to the vault path
    /// it may read, or `None` for anything not covered by a grant.
    pub fn resolve(&self, request_path: &str) -> Option<String> {
        let rest = request_path.strip_prefix('/')?;
        let (token, encoded) = rest.split_once('/')?;
        let plugin_id = self.tokens.get(token)?;
        if encoded.is_empty() {
            return None;
        }
        let mut path = format!("{PLUGIN_ROOT}/{plugin_id}");
        for segment in encoded.split('/') {
            let segment = percent_decode(segment)?;
            // Empty, relative, hidden or separator-smuggling segments never
            // reach the storage layer, which validates the result again.
            if segment.is_empty() || segment.starts_with('.') || segment.contains(['/', '\\', '\0'])
            {
                return None;
            }
            path.push('/');
            path.push_str(&segment);
        }
        Some(path)
    }
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}

/// Builds the response for one request. `read` performs the checked vault
/// read for a resolved path (and is where vault-session checks happen).
pub fn respond(
    request: &Request<Vec<u8>>,
    resolve: impl FnOnce(&str) -> Option<String>,
    read: impl FnOnce(&str) -> Result<Vec<u8>, String>,
) -> Response<Vec<u8>> {
    let head = match *request.method() {
        Method::GET => false,
        Method::HEAD => true,
        _ => return status(StatusCode::METHOD_NOT_ALLOWED),
    };
    // Unknown tokens, invalid paths and unreadable files all look the same.
    let Some(path) = resolve(request.uri().path()) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(bytes) = read(&path) else {
        return status(StatusCode::NOT_FOUND);
    };
    let length = bytes.len();
    let mut response = Response::new(if head { Vec::new() } else { bytes });
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CONTENT_LENGTH, length.into());
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    if let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|origin| APP_ORIGINS.contains(origin))
    {
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            header::HeaderValue::from_str(origin).expect("origin is a valid header value"),
        );
        headers.insert(header::VARY, header::HeaderValue::from_static("Origin"));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_of(base: &str) -> &str {
        base.strip_prefix(ORIGIN).unwrap().trim_matches('/')
    }

    fn get(path: &str, origin: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::get(format!("{ORIGIN}{path}"));
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        builder.body(Vec::new()).unwrap()
    }

    #[test]
    fn grants_are_random_stable_and_revocable() {
        let mut grants = Grants::default();
        let ink = grants.grant("sample-ink").unwrap();
        assert!(ink.starts_with(ORIGIN) && ink.ends_with('/'));
        assert_eq!(token_of(&ink).len(), 64);
        assert_eq!(grants.grant("sample-ink").unwrap(), ink);
        let other = grants.grant("sample-sheet").unwrap();
        assert_ne!(other, ink);
        for id in ["", "Ink", "../x", ".hidden", "a/b", "-x"] {
            assert!(grants.grant(id).is_err(), "accepted {id}");
        }
        grants.revoke("sample-ink");
        assert_eq!(
            grants.resolve(&format!("/{}/models/a", token_of(&ink))),
            None
        );
        assert!(
            grants
                .resolve(&format!("/{}/main.js", token_of(&other)))
                .is_some()
        );
    }

    #[test]
    fn paths_stay_inside_the_granted_plugin_folder() {
        let mut grants = Grants::default();
        let base = grants.grant("ink").unwrap();
        let token = token_of(&base);
        assert_eq!(
            grants.resolve(&format!("/{token}/models/tesseract/deu.traineddata.gz")),
            Some("Basalt/Plugins/ink/models/tesseract/deu.traineddata.gz".into())
        );
        assert_eq!(
            grants.resolve(&format!("/{token}/Mod%C3%A8le%20A/x.bin")),
            Some("Basalt/Plugins/ink/Modèle A/x.bin".into())
        );
        for rest in [
            "",
            "../sample-sheet/data.json",
            "..%2Fsample-sheet/data.json",
            "a%2F..%2F..%2Fnote.md",
            "%2e%2e/x",
            ".hidden",
            "models/.cache",
            "a//b",
            "a%5Cb",
            "a%00b",
            "bad%zz",
            "bad%e",
            "%ff",
        ] {
            assert_eq!(grants.resolve(&format!("/{token}/{rest}")), None, "{rest}");
        }
        assert_eq!(grants.resolve("/unknown/main.js"), None);
        assert_eq!(grants.resolve(&format!("/{token}")), None);
        assert_eq!(grants.resolve("main.js"), None);
    }

    #[test]
    fn responses_are_inert_bytes_for_app_origins_only() {
        let read = |path: &str| {
            assert_eq!(path, "Basalt/Plugins/ink/a.bin");
            Ok(vec![1, 2, 3])
        };
        let resolve = |_: &str| Some("Basalt/Plugins/ink/a.bin".to_owned());
        let response = respond(&get("/t/a.bin", Some("tauri://localhost")), resolve, read);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), &[1, 2, 3]);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; sandbox"
        );
        assert_eq!(
            headers[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "tauri://localhost"
        );

        let foreign = respond(&get("/t/a.bin", Some("https://example.com")), resolve, read);
        assert!(
            foreign
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none()
        );

        let head = Request::head(format!("{ORIGIN}/t/a.bin"))
            .body(Vec::new())
            .unwrap();
        let head = respond(&head, resolve, read);
        assert!(head.body().is_empty());
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "3");

        let post = Request::post(format!("{ORIGIN}/t/a.bin"))
            .body(Vec::new())
            .unwrap();
        let post = respond(&post, resolve, |_| unreachable!());
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);

        let missing = respond(&get("/t/a.bin", None), |_| None, |_| unreachable!());
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let unreadable = respond(&get("/t/a.bin", None), resolve, |_| Err("gone".into()));
        assert_eq!(unreadable.status(), StatusCode::NOT_FOUND);
    }
}
