//! Development-only loopback API for the structured Developer log.
//!
//! This is intentionally separate from stdout/stderr: it exposes only entries
//! already admitted by the DeveloperLogController's user-configured categories.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const DEFAULT_ADDRESS: &str = "127.0.0.1:17342";
const MAX_ENTRIES: usize = 10_000;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_PROJECT_FILES: usize = 50_000;
const LOG_CATEGORIES: [&str; 8] = [
    "preview",
    "inverseSync",
    "forwardSync",
    "performance",
    "memory",
    "lsp",
    "spellcheck",
    "general",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevLogInput {
    pub kind: String,
    pub source: String,
    pub message: String,
    #[serde(default)]
    pub file_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevLogEntry {
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub kind: String,
    pub source: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevLogSnapshot {
    entries: Vec<DevLogEntry>,
    next_sequence: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DevLogSettingsPatch {
    developer_mode: Option<bool>,
    developer_logs: Option<BTreeMap<String, bool>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevLogSettings {
    developer_mode: bool,
    developer_logs: BTreeMap<String, bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectPathRequest {
    path: String,
}

#[derive(Clone, Debug)]
struct DevProjectContext {
    root: PathBuf,
    main_file: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevProjectFile {
    path: String,
    kind: &'static str,
    is_main: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevProjectFiles {
    root: String,
    main_file: Option<String>,
    files: Vec<DevProjectFile>,
    truncated: bool,
}

#[derive(Default)]
pub struct DevProjectState {
    context: Mutex<Option<DevProjectContext>>,
}

impl DevProjectState {
    pub fn update(&self, root: Option<&str>, main_file: Option<&str>) -> Result<(), String> {
        let Some(root) = root else {
            *self
                .context
                .lock()
                .map_err(|_| "Project state is unavailable".to_string())? = None;
            return Ok(());
        };
        let root = dunce::canonicalize(root)
            .map_err(|error| format!("Could not resolve project folder: {error}"))?;
        if !root.is_dir() {
            return Err("The project path must be an existing folder.".into());
        }
        let main_file = main_file
            .map(|path| validate_main_file(&root, Path::new(path)))
            .transpose()?;
        *self
            .context
            .lock()
            .map_err(|_| "Project state is unavailable".to_string())? =
            Some(DevProjectContext { root, main_file });
        Ok(())
    }

    fn files(&self) -> Result<DevProjectFiles, String> {
        let context = self
            .context
            .lock()
            .map_err(|_| "Project state is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "No project is currently open.".to_string())?;
        list_project_files(&context)
    }

    fn validate_main(&self, path: &str) -> Result<PathBuf, String> {
        let context = self
            .context
            .lock()
            .map_err(|_| "Project state is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "No project is currently open.".to_string())?;
        validate_main_file(&context.root, Path::new(path))
    }
}

#[derive(Default)]
pub struct DevLogBuffer {
    next_sequence: Mutex<u64>,
    entries: Mutex<VecDeque<DevLogEntry>>,
}

impl DevLogBuffer {
    pub fn push(&self, mut entry: DevLogInput) {
        truncate_utf8(&mut entry.kind, 32);
        truncate_utf8(&mut entry.source, 256);
        truncate_utf8(&mut entry.message, MAX_MESSAGE_BYTES);
        if let Some(path) = &mut entry.file_path {
            truncate_utf8(path, 4096);
        }

        let Ok(mut next_sequence) = self.next_sequence.lock() else {
            return;
        };
        let sequence = *next_sequence;
        *next_sequence = next_sequence.saturating_add(1);
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or_default();
        let entry = DevLogEntry {
            sequence,
            timestamp_ms,
            kind: entry.kind,
            source: entry.source,
            message: entry.message,
            file_path: entry.file_path,
        };

        if let Ok(mut entries) = self.entries.lock() {
            entries.push_back(entry);
            while entries.len() > MAX_ENTRIES {
                entries.pop_front();
            }
        }
    }

    fn snapshot(&self, after: Option<u64>) -> DevLogSnapshot {
        let entries = self
            .entries
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| after.is_none_or(|sequence| entry.sequence > sequence))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let next_sequence = self
            .next_sequence
            .lock()
            .map(|next| *next)
            .unwrap_or_default();
        DevLogSnapshot {
            entries,
            next_sequence,
        }
    }
}

/// Starts the local JSON API. The socket is loopback-only; requests from a
/// browser origin are additionally restricted to Typsastra's local dev origins.
pub async fn serve(
    buffer: std::sync::Arc<DevLogBuffer>,
    app: tauri::AppHandle,
    project_state: std::sync::Arc<DevProjectState>,
) -> Result<(), String> {
    let address =
        std::env::var("TYPSASTRA_DEV_LOG_API_ADDR").unwrap_or_else(|_| DEFAULT_ADDRESS.to_string());
    let socket_address = address
        .parse::<std::net::SocketAddr>()
        .map_err(|error| format!("Invalid developer log API address {address}: {error}"))?;
    if !socket_address.ip().is_loopback() {
        return Err("The developer log API address must be a loopback address.".into());
    }
    let listener = TcpListener::bind(socket_address)
        .await
        .map_err(|error| format!("Could not bind the developer log API at {address}: {error}"))?;
    eprintln!("Typsastra developer log API listening at http://{address}/logs");
    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|error| format!("Developer log API accept failed: {error}"))?;
        let buffer = buffer.clone();
        let app = app.clone();
        let project_state = project_state.clone();
        tokio::spawn(async move {
            let _ = handle_connection(stream, buffer, app, project_state).await;
        });
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    buffer: std::sync::Arc<DevLogBuffer>,
    app: tauri::AppHandle,
    project_state: std::sync::Arc<DevProjectState>,
) -> Result<(), String> {
    let request = read_http_request(&mut stream).await?;
    let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
        return write_response(
            &mut stream,
            400,
            "Bad Request",
            "text/plain",
            b"bad request",
            None,
        )
        .await;
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let mut lines = headers.lines();
    let Some(request_line) = lines.next() else {
        return write_response(
            &mut stream,
            400,
            "Bad Request",
            "text/plain",
            b"bad request",
            None,
        )
        .await;
    };
    let mut fields = request_line.split_whitespace();
    let method = fields.next().unwrap_or_default();
    let target = fields.next().unwrap_or_default();
    let host = lines
        .clone()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim());
    let origin = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("origin"))
        .map(|(_, value)| value.trim());

    if host.is_some_and(|host| !is_loopback_host(host)) {
        return write_response(
            &mut stream,
            403,
            "Forbidden",
            "text/plain",
            b"forbidden",
            None,
        )
        .await;
    }
    if origin.is_some_and(|origin| !is_allowed_origin(origin)) {
        return write_response(
            &mut stream,
            403,
            "Forbidden",
            "text/plain",
            b"forbidden",
            None,
        )
        .await;
    }
    if method == "OPTIONS" {
        return write_response(
            &mut stream,
            204,
            "No Content",
            "application/json",
            b"",
            origin,
        )
        .await;
    }

    let path = target.split('?').next().unwrap_or_default();
    let (status, reason, content_type, body) = match (method, path) {
        ("GET", "/health") => (200, "OK", "application/json", br#"{"ok":true}"#.to_vec()),
        ("GET", "/logs") => {
            let after = parse_query_value(target, "after").and_then(|value| value.parse::<u64>().ok());
            match serde_json::to_vec(&buffer.snapshot(after)) {
                Ok(body) => (200, "OK", "application/json; charset=utf-8", body),
                Err(error) => (500, "Internal Server Error", "text/plain", error.to_string().into_bytes()),
            }
        }
        ("GET", "/project/files") => match project_state.files() {
            Ok(files) => match serde_json::to_vec(&files) {
                Ok(body) => (200, "OK", "application/json; charset=utf-8", body),
                Err(error) => (500, "Internal Server Error", "text/plain", error.to_string().into_bytes()),
            },
            Err(error) => (409, "Conflict", "text/plain", error.into_bytes()),
        },
        ("POST", "/project/open") => {
            match serde_json::from_slice::<ProjectPathRequest>(&request[header_end + 4..]) {
                Ok(payload) => match validate_project_path(&payload.path) {
                    Ok(path) => {
                        app.state::<crate::PendingLaunchRequests>().push(path);
                        match app.emit("typsastra-project-open-requested", ()) {
                            Ok(()) => (202, "Accepted", "application/json", br#"{"accepted":true}"#.to_vec()),
                            Err(error) => (500, "Internal Server Error", "text/plain", error.to_string().into_bytes()),
                        }
                    }
                    Err(error) => (422, "Unprocessable Content", "text/plain", error.into_bytes()),
                },
                Err(error) => (400, "Bad Request", "text/plain", error.to_string().into_bytes()),
            }
        }
        ("PUT", "/project/main") => {
            match serde_json::from_slice::<ProjectPathRequest>(&request[header_end + 4..]) {
                Ok(payload) => match project_state.validate_main(&payload.path) {
                    Ok(path) => {
                        let path = path.to_string_lossy().to_string();
                        match app.emit("typsastra-dev-api-set-main", &path) {
                            Ok(()) => (202, "Accepted", "application/json", br#"{"accepted":true}"#.to_vec()),
                            Err(error) => (500, "Internal Server Error", "text/plain", error.to_string().into_bytes()),
                        }
                    }
                    Err(error) => (422, "Unprocessable Content", "text/plain", error.into_bytes()),
                },
                Err(error) => (400, "Bad Request", "text/plain", error.to_string().into_bytes()),
            }
        }
        ("GET", "/settings") => match read_dev_log_settings(&app) {
            Ok(settings) => match serde_json::to_vec(&settings) {
                Ok(body) => (200, "OK", "application/json; charset=utf-8", body),
                Err(error) => (500, "Internal Server Error", "text/plain", error.to_string().into_bytes()),
            },
            Err(error) => (500, "Internal Server Error", "text/plain", error.into_bytes()),
        },
        ("PATCH", "/settings") | ("PUT", "/settings") => {
            let body_start = header_end + 4;
            let body = &request[body_start..];
            match update_dev_log_settings(&app, body) {
                Ok(settings) => {
                    let _ = app.emit("typsastra-dev-log-settings-updated", &settings);
                    match serde_json::to_vec(&settings) {
                        Ok(body) => (200, "OK", "application/json; charset=utf-8", body),
                        Err(error) => (500, "Internal Server Error", "text/plain", error.to_string().into_bytes()),
                    }
                }
                Err((status, message)) => (status, status_reason(status), "text/plain", message.into_bytes()),
            }
        }
        ("GET", "/") => (
            200,
            "OK",
            "text/plain; charset=utf-8",
            b"Typsastra developer API. GET /logs?after=<sequence>, GET /settings, PATCH /settings, GET /project/files, POST /project/open, PUT /project/main, GET /health.\n".to_vec(),
        ),
        (_, "/logs" | "/settings" | "/health" | "/project/files" | "/project/open" | "/project/main") => (
            405,
            "Method Not Allowed",
            "text/plain",
            b"method not allowed".to_vec(),
        ),
        _ => (404, "Not Found", "text/plain", b"not found".to_vec()),
    };
    write_response(&mut stream, status, reason, content_type, &body, origin).await
}

async fn read_http_request(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut request = Vec::new();
    let mut chunk = [0_u8; 2048];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("Developer API read failed: {error}"))?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.len() > MAX_REQUEST_BYTES {
            return Err("Developer API request exceeded the size limit.".into());
        }
        let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if header_end + 4 + content_length > MAX_REQUEST_BYTES {
            return Err("Developer API request exceeded the size limit.".into());
        }
        if request.len() >= header_end + 4 + content_length {
            break;
        }
    }
    Ok(request)
}

fn validate_project_path(path: &str) -> Result<PathBuf, String> {
    let path = dunce::canonicalize(path)
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    if !path.is_dir() {
        return Err("The project path must be an existing folder.".into());
    }
    Ok(path)
}

fn validate_main_file(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let path = dunce::canonicalize(path)
        .map_err(|error| format!("Could not resolve Typst document: {error}"))?;
    if !path.starts_with(root) {
        return Err("The main document must be inside the open project.".into());
    }
    if !path.is_file() || path.extension().and_then(|extension| extension.to_str()) != Some("typ") {
        return Err("The main document must be an existing .typ file.".into());
    }
    Ok(path)
}

fn list_project_files(context: &DevProjectContext) -> Result<DevProjectFiles, String> {
    fn visit(directory: &Path, files: &mut Vec<PathBuf>, truncated: &mut bool) {
        if files.len() >= MAX_PROJECT_FILES {
            *truncated = true;
            return;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            if files.len() >= MAX_PROJECT_FILES {
                *truncated = true;
                return;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                let name = entry.file_name();
                if matches!(
                    name.to_str(),
                    Some(".git" | "node_modules" | "target" | ".typsastra")
                ) {
                    continue;
                }
                visit(&path, files, truncated);
            } else if file_type.is_file() {
                files.push(path);
            }
        }
    }

    let mut paths = Vec::new();
    let mut truncated = false;
    visit(&context.root, &mut paths, &mut truncated);
    paths.sort();
    let files = paths
        .into_iter()
        .map(|path| {
            let relative = path.strip_prefix(&context.root).unwrap_or(&path);
            DevProjectFile {
                path: relative.to_string_lossy().replace('\\', "/"),
                kind: "file",
                is_main: context.main_file.as_deref() == Some(path.as_path()),
            }
        })
        .collect();
    let main_file = context.main_file.as_ref().and_then(|path| {
        path.strip_prefix(&context.root)
            .ok()
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
    });
    Ok(DevProjectFiles {
        root: context.root.to_string_lossy().to_string(),
        main_file,
        files,
        truncated,
    })
}

fn read_dev_log_settings(app: &tauri::AppHandle) -> Result<DevLogSettings, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not locate settings: {error}"))?
        .join("settings.json");
    if !path.exists() {
        return Ok(default_dev_log_settings());
    }
    let bytes =
        std::fs::read(&path).map_err(|error| format!("Could not read settings: {error}"))?;
    let settings: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not parse settings: {error}"))?;
    Ok(dev_log_settings_from_value(&settings))
}

fn update_dev_log_settings(
    app: &tauri::AppHandle,
    body: &[u8],
) -> Result<DevLogSettings, (u16, String)> {
    let patch: DevLogSettingsPatch = serde_json::from_slice(body)
        .map_err(|error| (400, format!("Invalid settings JSON: {error}")))?;
    if let Some(categories) = &patch.developer_logs {
        if let Some(key) = categories
            .keys()
            .find(|key| !LOG_CATEGORIES.contains(&key.as_str()))
        {
            return Err((422, format!("Unknown developer log category: {key}")));
        }
    }

    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| (500, format!("Could not locate settings: {error}")))?
        .join("settings.json");
    let mut settings = if path.exists() {
        let bytes = std::fs::read(&path)
            .map_err(|error| (500, format!("Could not read settings: {error}")))?;
        serde_json::from_slice::<Value>(&bytes)
            .map_err(|error| (500, format!("Could not parse settings: {error}")))?
    } else {
        json!({})
    };
    if !settings.is_object() {
        settings = json!({});
    }
    let object = settings.as_object_mut().expect("settings is an object");
    if let Some(enabled) = patch.developer_mode {
        object.insert("developerMode".into(), Value::Bool(enabled));
    }
    if let Some(categories) = patch.developer_logs {
        let developer_logs = object
            .entry("developerLogs")
            .or_insert_with(|| Value::Object(Default::default()));
        if !developer_logs.is_object() {
            *developer_logs = Value::Object(Default::default());
        }
        let developer_logs = developer_logs
            .as_object_mut()
            .expect("developerLogs is an object");
        for (key, enabled) in categories {
            developer_logs.insert(key, Value::Bool(enabled));
        }
    }

    let parent = path
        .parent()
        .ok_or_else(|| (500, "Settings path has no parent.".to_string()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| (500, format!("Could not create settings directory: {error}")))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| (500, format!("Could not stage settings: {error}")))?;
    serde_json::to_writer_pretty(&mut temporary, &settings)
        .map_err(|error| (500, format!("Could not serialize settings: {error}")))?;
    std::io::Write::write_all(&mut temporary, b"\n")
        .map_err(|error| (500, format!("Could not stage settings: {error}")))?;
    temporary
        .persist(&path)
        .map_err(|error| (500, format!("Could not save settings: {}", error.error)))?;
    Ok(dev_log_settings_from_value(&settings))
}

fn default_dev_log_settings() -> DevLogSettings {
    DevLogSettings {
        developer_mode: false,
        developer_logs: LOG_CATEGORIES
            .iter()
            .map(|key| ((*key).to_string(), true))
            .collect(),
    }
}

fn dev_log_settings_from_value(settings: &Value) -> DevLogSettings {
    let defaults = default_dev_log_settings();
    let developer_mode = settings
        .get("developerMode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let stored = settings.get("developerLogs");
    let developer_logs = LOG_CATEGORIES
        .iter()
        .map(|key| {
            let value = stored
                .and_then(|categories| categories.get(*key))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| defaults.developer_logs.get(*key).copied().unwrap_or(true));
            ((*key).to_string(), value)
        })
        .collect();
    DevLogSettings {
        developer_mode,
        developer_logs,
    }
}

fn status_reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        422 => "Unprocessable Content",
        _ => "Internal Server Error",
    }
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
    origin: Option<&str>,
) -> Result<(), String> {
    let mut headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n",
        body.len()
    );
    if let Some(origin) = origin {
        headers.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"
        ));
        headers.push_str("Access-Control-Allow-Methods: GET, PATCH, PUT, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n");
    }
    headers.push_str("\r\n");
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|error| format!("Developer log API write failed: {error}"))?;
    stream
        .write_all(body)
        .await
        .map_err(|error| format!("Developer log API write failed: {error}"))?;
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    let name = if let Some(ipv6) = host.strip_prefix('[') {
        ipv6.split_once(']')
            .map(|(address, _)| address)
            .unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or_default()
    };
    name.eq_ignore_ascii_case("localhost")
        || name
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn is_allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "http://127.0.0.1:1420"
            | "http://localhost:1420"
            | "tauri://localhost"
            | "http://tauri.localhost"
    )
}

fn parse_query_value<'a>(target: &'a str, key: &str) -> Option<&'a str> {
    target.split_once('?')?.1.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
}

fn truncate_utf8(value: &mut String, max_bytes: usize) {
    if value.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}

#[cfg(test)]
mod tests {
    use super::{
        default_dev_log_settings, dev_log_settings_from_value, is_allowed_origin, is_loopback_host,
        parse_query_value, DevLogBuffer, DevLogInput, DevProjectState,
    };

    #[test]
    fn bounds_the_ring_buffer_and_supports_sequence_polling() {
        let buffer = DevLogBuffer::default();
        buffer.push(DevLogInput {
            kind: "info".into(),
            source: "test".into(),
            message: "one".into(),
            file_path: None,
        });
        buffer.push(DevLogInput {
            kind: "warning".into(),
            source: "test".into(),
            message: "two".into(),
            file_path: None,
        });
        let all = buffer.snapshot(None);
        assert_eq!(all.entries.len(), 2);
        assert_eq!(all.entries[0].sequence, 0);
        assert_eq!(buffer.snapshot(Some(0)).entries[0].message, "two");
        assert_eq!(all.next_sequence, 2);
    }

    #[test]
    fn only_accepts_loopback_hosts_and_dev_origins() {
        assert!(is_loopback_host("127.0.0.1:17342"));
        assert!(is_loopback_host("localhost:17342"));
        assert!(!is_loopback_host("example.com:17342"));
        assert!(is_allowed_origin("http://localhost:1420"));
        assert!(!is_allowed_origin("https://example.com"));
    }

    #[test]
    fn parses_after_cursor_from_query() {
        assert_eq!(parse_query_value("/logs?after=17", "after"), Some("17"));
        assert_eq!(parse_query_value("/logs?x=1&after=29", "after"), Some("29"));
    }

    #[test]
    fn exposes_all_settings_categories_and_defaults() {
        let settings = dev_log_settings_from_value(&serde_json::json!({
            "developerMode": true,
            "developerLogs": { "preview": false }
        }));
        assert!(settings.developer_mode);
        assert_eq!(settings.developer_logs.get("preview"), Some(&false));
        assert_eq!(settings.developer_logs.get("spellcheck"), Some(&true));
        assert_eq!(default_dev_log_settings().developer_logs.len(), 8);
    }

    #[test]
    fn lists_project_files_and_rejects_main_files_outside_the_root() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("chapters")).unwrap();
        std::fs::write(root.path().join("main.typ"), "= Main").unwrap();
        std::fs::write(root.path().join("chapters/intro.typ"), "= Intro").unwrap();
        std::fs::write(root.path().join("cover.png"), []).unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::write(root.path().join(".git/config"), "ignored").unwrap();

        let state = DevProjectState::default();
        state
            .update(
                Some(root.path().to_str().unwrap()),
                Some(root.path().join("main.typ").to_str().unwrap()),
            )
            .unwrap();
        let listing = state.files().unwrap();
        assert_eq!(listing.main_file.as_deref(), Some("main.typ"));
        assert!(listing
            .files
            .iter()
            .any(|file| file.path == "chapters/intro.typ"));
        assert!(listing.files.iter().any(|file| file.path == "cover.png"));
        assert!(!listing
            .files
            .iter()
            .any(|file| file.path.starts_with(".git/")));
        assert!(state.validate_main("../outside.typ").is_err());
    }
}
