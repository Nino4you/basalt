//! `requestUrl` for plugins. Obsidian performs these requests outside the
//! renderer, so plugins rely on them ignoring CORS (self-hosted sync servers,
//! model downloads). Running them here keeps the WebView CSP unchanged.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;
use ureq::http;

/// Same cap as the binary vault bridge, in both directions.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Deserialize)]
pub struct PluginRequest {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Base64, or absent for requests without a body.
    pub body: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct PluginResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    /// Base64.
    pub body: String,
}

fn validate(request: &PluginRequest) -> Result<(http::Method, http::Uri), String> {
    let uri: http::Uri = request
        .url
        .parse()
        .map_err(|_| "requestUrl needs an absolute URL".to_string())?;
    match uri.scheme_str() {
        Some("http") | Some("https") => {}
        _ => return Err("requestUrl only supports http and https URLs".into()),
    }
    if uri.host().is_none_or(str::is_empty) {
        return Err("requestUrl needs a host".into());
    }
    let method = http::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "requestUrl method is invalid".to_string())?;
    Ok((method, uri))
}

pub fn perform(request: PluginRequest) -> Result<PluginResponse, String> {
    let (method, uri) = validate(&request)?;
    let body = match &request.body {
        Some(data) => STANDARD
            .decode(data)
            .map_err(|_| "requestUrl body is not valid base64".to_string())?,
        None => Vec::new(),
    };
    if body.len() > MAX_REQUEST_BYTES {
        return Err("requestUrl body exceeds the 64 MiB limit".into());
    }
    let mut builder = http::Request::builder().method(method).uri(uri);
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let prepared = builder
        .body(body)
        .map_err(|error| format!("requestUrl header is invalid: {error}"))?;

    let agent: ureq::Agent = ureq::Agent::config_builder()
        // Status codes are the caller's business (`throw: false`).
        .http_status_as_error(false)
        .allow_non_standard_methods(true)
        .timeout_global(Some(TIMEOUT))
        .build()
        .into();
    let mut response = agent
        .run(prepared)
        .map_err(|error| format!("Request failed: {error}"))?;

    let mut headers = BTreeMap::new();
    for (name, value) in response.headers() {
        let Ok(value) = value.to_str() else { continue };
        headers
            .entry(name.as_str().to_string())
            .and_modify(|existing: &mut String| {
                existing.push_str(", ");
                existing.push_str(value);
            })
            .or_insert_with(|| value.to_string());
    }
    let status = response.status().as_u16();
    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_REQUEST_BYTES as u64)
        .read_to_vec()
        .map_err(|error| format!("Response could not be read: {error}"))?;
    Ok(PluginResponse {
        status,
        headers,
        body: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn request(url: &str, method: &str, body: Option<&[u8]>) -> PluginRequest {
        PluginRequest {
            url: url.into(),
            method: method.into(),
            headers: BTreeMap::from([("X-Test".into(), "1".into())]),
            body: body.map(|bytes| STANDARD.encode(bytes)),
        }
    }

    /// Answers one request and returns what the client sent.
    fn serve_once(reply: &'static str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                seen.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&seen);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if seen.len() >= end + 4 + length {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&seen).into_owned()
        });
        (url, handle)
    }

    #[test]
    fn sends_method_headers_and_body_and_returns_any_status() {
        let (url, server) = serve_once(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nX-Reply: a\r\nX-Reply: b\r\nConnection: close\r\n\r\nno",
        );
        let response = perform(request(&url, "PUT", Some(b"payload"))).unwrap();
        let seen = server.join().unwrap();
        assert!(seen.starts_with("PUT /api HTTP/1.1"));
        assert!(seen.to_ascii_lowercase().contains("x-test: 1"));
        assert!(seen.ends_with("payload"));
        assert_eq!(response.status, 404);
        assert_eq!(response.headers.get("x-reply").unwrap(), "a, b");
        assert_eq!(STANDARD.decode(response.body).unwrap(), b"no");
    }

    #[test]
    fn rejects_non_http_urls_and_bad_input() {
        for url in [
            "file:///etc/passwd",
            "ipc://localhost/x",
            "relative/path",
            "http://",
        ] {
            assert!(perform(request(url, "GET", None)).is_err(), "{url}");
        }
        assert!(perform(request("http://127.0.0.1:9/", "G T", None)).is_err());
        let mut broken = request("http://127.0.0.1:9/", "POST", None);
        broken.body = Some("***".into());
        assert!(perform(broken).is_err());
    }
}
