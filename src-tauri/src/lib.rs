use futures_util::{SinkExt, StreamExt};
use serde_json::json;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use tokio::net::TcpListener;
use tokio_tungstenite::{
    accept_hdr_async, connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        handshake::server::{Request as WsServerRequest, Response as WsServerResponse},
        protocol::WebSocketConfig,
        Message as WsMessage,
    },
};

mod compatibility;
mod examples;
mod font_store;
mod project_archive;
mod render_prepare;
mod scaled_fonts;
mod segmentation;
mod toolchain;
mod webview_storage;
use compatibility::{get_linux_renderer_compatibility, prepare_linux_renderer_relaunch};
use examples::prepare_examples_workspace;
use render_prepare::{
    cancel_draft_thumbnail_generation, cancel_render_preparation, get_draft_thumbnail_status,
    map_generated_to_source, map_source_to_generated, prepare_render_file, prepare_render_project,
    start_draft_thumbnail_generation, validate_existing_render_cache_owner,
};
use segmentation::{
    analyze_language_ranges, complete_language_word, get_provider_capabilities,
    install_hunspell_dictionary, language_suggestions, list_hunspell_catalog,
    remove_hunspell_dictionary, ProviderCapabilities, SegmentationRegistry,
};
use toolchain::active_tinymist;

fn workspace_font_directories(app_local_data_dir: &Path, start: &Path) -> Vec<std::path::PathBuf> {
    let cache_root = scaled_fonts::global_scaled_font_root(app_local_data_dir);
    for ancestor in start.ancestors() {
        if ancestor.join(".typsastra").is_dir() {
            return scaled_fonts::workspace_font_directories(&cache_root, ancestor);
        }
    }
    Vec::new()
}

fn configured_private_font_directories(app_handle: &tauri::AppHandle) -> Vec<PathBuf> {
    let Ok(path) = settings_file_path(app_handle) else {
        return Vec::new();
    };
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return Vec::new();
    };
    settings
        .pointer("/fonts/privateDirectories")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .take(32)
        .collect()
}

fn is_safe_relative_workspace_font_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.is_relative()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn workspace_private_font_directories(start: &Path) -> Vec<PathBuf> {
    for workspace_root in start.ancestors() {
        let metadata = workspace_root.join(".typsastra");
        if !metadata.is_dir() {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(metadata.join("local.json")) else {
            return Vec::new();
        };
        let Ok(local) = serde_json::from_str::<serde_json::Value>(&contents) else {
            return Vec::new();
        };
        return local
            .pointer("/privateFontDirectories")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .filter_map(|value| {
                let candidate = PathBuf::from(value);
                if candidate.is_absolute() {
                    Some(candidate)
                } else if is_safe_relative_workspace_font_path(&candidate) {
                    Some(workspace_root.join(candidate))
                } else {
                    None
                }
            })
            .filter(|path| path.is_dir())
            .take(32)
            .collect();
    }
    Vec::new()
}

fn private_font_directories(app_handle: &tauri::AppHandle, start: &Path) -> Vec<PathBuf> {
    let mut paths = workspace_private_font_directories(start);
    for private_path in configured_private_font_directories(app_handle) {
        if !paths.iter().any(|path| path == &private_path) {
            paths.push(private_path);
        }
    }
    paths
}

fn compiler_font_directories(
    app_handle: &tauri::AppHandle,
    app_local_data_dir: &Path,
    start: &Path,
) -> Vec<PathBuf> {
    let mut paths = workspace_font_directories(app_local_data_dir, start);
    for private_path in private_font_directories(app_handle, start) {
        if !paths.iter().any(|path| path == &private_path) {
            paths.push(private_path);
        }
    }
    paths
}

fn apply_workspace_font_paths(
    command: &mut std::process::Command,
    app_handle: &tauri::AppHandle,
    app_local_data_dir: &Path,
    start: &Path,
) {
    let paths = compiler_font_directories(app_handle, app_local_data_dir, start);
    if !paths.is_empty() {
        if let Ok(value) = std::env::join_paths(paths) {
            command.env("TYPST_FONT_PATHS", value);
        }
    }
}

fn workspace_font_directory_storage_path(
    workspace_root: &Path,
    path: &Path,
) -> Result<String, String> {
    let absolute = path.canonicalize().map_err(|error| {
        format!(
            "Unable to resolve private font directory '{}': {error}",
            path.display()
        )
    })?;
    let root = workspace_root.canonicalize().map_err(|error| {
        format!(
            "Unable to resolve workspace '{}': {error}",
            workspace_root.display()
        )
    })?;
    if let Ok(relative) = absolute.strip_prefix(&root) {
        if !is_safe_relative_workspace_font_path(relative) {
            return Err(
                "Private font directories inside a workspace must use a safe relative path."
                    .to_string(),
            );
        }
        return Ok(relative.to_string_lossy().replace('\\', "/"));
    }
    Ok(absolute.to_string_lossy().to_string())
}

fn workspace_local_settings_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".typsastra").join("local.json")
}

#[tauri::command]
fn load_workspace_private_font_directories(
    workspace_root_path: String,
) -> Result<Vec<String>, String> {
    let workspace_root = Path::new(&workspace_root_path);
    if !workspace_root.is_dir() {
        return Err("The workspace root does not exist.".to_string());
    }
    let Ok(contents) = std::fs::read_to_string(workspace_local_settings_path(workspace_root))
    else {
        return Ok(Vec::new());
    };
    let local = serde_json::from_str::<serde_json::Value>(&contents)
        .map_err(|error| format!("Invalid workspace local settings: {error}"))?;
    Ok(local
        .pointer("/privateFontDirectories")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect())
}

#[tauri::command]
fn save_workspace_private_font_directories(
    workspace_root_path: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let workspace_root = Path::new(&workspace_root_path);
    if !workspace_root.is_dir() {
        return Err("The workspace root does not exist.".to_string());
    }
    let mut stored = Vec::new();
    for path in paths
        .into_iter()
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
    {
        let candidate = PathBuf::from(&path);
        let absolute = if candidate.is_absolute() {
            candidate
        } else if is_safe_relative_workspace_font_path(&candidate) {
            workspace_root.join(candidate)
        } else {
            return Err(format!("Private font directory does not exist: {path}"));
        };
        if !absolute.is_dir() {
            return Err(format!("Private font directory does not exist: {path}"));
        }
        let value = workspace_font_directory_storage_path(workspace_root, &absolute)?;
        if !stored
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&value))
        {
            stored.push(value);
        }
    }
    let metadata = workspace_root.join(".typsastra");
    std::fs::create_dir_all(&metadata)
        .map_err(|error| format!("Failed to create {}: {error}", metadata.display()))?;
    write_json_atomically(
        &workspace_local_settings_path(workspace_root),
        &serde_json::json!({ "schemaVersion": 1, "privateFontDirectories": stored }),
    )?;
    let ignore = metadata.join(".gitignore");
    let mut ignored = std::fs::read_to_string(&ignore).unwrap_or_default();
    if !ignored.lines().any(|line| line.trim() == "local.json") {
        if !ignored.is_empty() && !ignored.ends_with('\n') {
            ignored.push('\n');
        }
        ignored.push_str("local.json\n");
        std::fs::write(&ignore, ignored)
            .map_err(|error| format!("Failed to write {}: {error}", ignore.display()))?;
    }
    Ok(stored)
}

#[tauri::command]
fn list_system_fonts(
    app_handle: tauri::AppHandle,
    workspace_root_path: Option<String>,
) -> font_store::SystemFontCatalog {
    let mut private = workspace_root_path
        .as_deref()
        .map(|path| private_font_directories(&app_handle, Path::new(path)))
        .unwrap_or_else(|| configured_private_font_directories(&app_handle));
    if let (Some(workspace_root), Ok(data_dir)) = (
        workspace_root_path.as_deref(),
        app_handle.path().app_local_data_dir(),
    ) {
        private.extend(scaled_fonts::workspace_font_directories(
            &scaled_fonts::global_scaled_font_root(&data_dir),
            Path::new(workspace_root),
        ));
    }
    font_store::list_system_fonts(&private)
}

#[tauri::command]
fn font_families_supporting_text(
    app_handle: tauri::AppHandle,
    families: Vec<String>,
    characters: String,
    workspace_root_path: Option<String>,
) -> Vec<String> {
    let private = workspace_root_path
        .as_deref()
        .map(|path| private_font_directories(&app_handle, Path::new(path)))
        .unwrap_or_else(|| configured_private_font_directories(&app_handle));
    font_store::font_families_supporting_text(&families, &characters, &private)
}

#[tauri::command]
fn inspect_private_font_directory(
    app_handle: tauri::AppHandle,
    path: String,
    workspace_root_path: Option<String>,
) -> Result<font_store::PrivateFontDirectoryInspection, String> {
    let private = workspace_root_path
        .as_deref()
        .map(|workspace| private_font_directories(&app_handle, Path::new(workspace)))
        .unwrap_or_else(|| configured_private_font_directories(&app_handle));
    font_store::inspect_private_font_directory(Path::new(&path), &private)
}

#[tauri::command]
async fn prepare_scaled_workspace_font(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    workspace_root_path: String,
    family: String,
    scale: f32,
) -> Result<scaled_fonts::ScaledFontResult, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let cache_root = scaled_fonts::global_scaled_font_root(&data_dir);
    if scaled_fonts::scaled_workspace_font_update_required(
        &cache_root,
        Path::new(&workspace_root_path),
        &family,
        scale,
    )? {
        stop_lsp_process(&state).await;
    }
    scaled_fonts::prepare_scaled_workspace_font(
        &cache_root,
        Path::new(&workspace_root_path),
        &family,
        scale,
        &private_font_directories(&app_handle, Path::new(&workspace_root_path)),
    )
}

#[tauri::command]
async fn prepare_named_workspace_font(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    workspace_root_path: String,
    request: scaled_fonts::PreparedFontRequest,
) -> Result<scaled_fonts::ScaledFontResult, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let cache_root = scaled_fonts::global_scaled_font_root(&data_dir);
    let scale = request.percent as f32 / 100.0;
    if request.percent != 100
        && scaled_fonts::scaled_workspace_font_update_required(
            &cache_root,
            Path::new(&workspace_root_path),
            &request.family,
            scale,
        )?
    {
        stop_lsp_process(&state).await;
    }
    scaled_fonts::prepare_named_workspace_font(
        &cache_root,
        Path::new(&workspace_root_path),
        &request,
        &private_font_directories(&app_handle, Path::new(&workspace_root_path)),
    )
}

#[tauri::command]
fn prepared_font_library(
    app_handle: tauri::AppHandle,
    workspace_root_path: String,
) -> Result<Vec<scaled_fonts::PreparedFontRecord>, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(scaled_fonts::prepared_font_library(
        &scaled_fonts::global_scaled_font_root(&data_dir),
        Path::new(&workspace_root_path),
    ))
}

#[tauri::command]
fn compile_font_specimen(
    app_handle: tauri::AppHandle,
    workspace_root_path: String,
    family: String,
    content: String,
) -> Result<String, String> {
    if content.encode_utf16().count() > 4000 {
        return Err("The font specimen is limited to 4,000 UTF-16 code units.".into());
    }
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let tinymist_cmd = active_tinymist(&data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;
    let directory =
        tempfile::tempdir().map_err(|error| format!("Failed to stage font specimen: {error}"))?;
    let input = directory.path().join("specimen.typ");
    let output = directory.path().join("specimen.svg");
    let escaped = family.replace('\\', "\\\\").replace('"', "\\\"");
    let source = format!(
        "#set page(width: 420pt, height: 220pt, margin: 18pt)\n#set text(font: \"{escaped}\", size: 34pt)\n#block(width: 100%, height: 100%)[{content}]\n"
    );
    std::fs::write(&input, source)
        .map_err(|error| format!("Failed to write font specimen: {error}"))?;
    let mut command = std::process::Command::new(tinymist_cmd);
    command.current_dir(directory.path());
    let cache_root = scaled_fonts::global_scaled_font_root(&data_dir);
    let mut paths =
        compiler_font_directories(&app_handle, &data_dir, Path::new(&workspace_root_path));
    if let Some(path) = scaled_fonts::prepared_font_directory(&cache_root, &family) {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    if !paths.is_empty() {
        if let Ok(value) = std::env::join_paths(paths) {
            command.env("TYPST_FONT_PATHS", value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let result = command
        .arg("compile")
        .arg("--root")
        .arg(directory.path())
        .arg("--format")
        .arg("svg")
        .arg(&input)
        .arg(&output)
        .output()
        .map_err(|error| format!("Font specimen compiler failed to start: {error}"))?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).trim().to_string());
    }
    std::fs::read_to_string(output)
        .map_err(|error| format!("Failed to read font specimen: {error}"))
}

#[tauri::command]
fn scaled_workspace_font_update_required(
    app_handle: tauri::AppHandle,
    workspace_root_path: String,
    family: String,
    scale: f32,
) -> Result<bool, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    scaled_fonts::scaled_workspace_font_update_required(
        &scaled_fonts::global_scaled_font_root(&data_dir),
        Path::new(&workspace_root_path),
        &family,
        scale,
    )
}

#[tauri::command]
fn scaled_workspace_font_set_update_required(
    app_handle: tauri::AppHandle,
    workspace_root_path: String,
    fonts: Vec<scaled_fonts::ScaledFontRequest>,
) -> Result<bool, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    scaled_fonts::scaled_workspace_font_set_update_required(
        &scaled_fonts::global_scaled_font_root(&data_dir),
        Path::new(&workspace_root_path),
        &fonts,
    )
}

#[tauri::command]
fn scaled_workspace_font_set_status(
    app_handle: tauri::AppHandle,
    workspace_root_path: String,
    fonts: Vec<scaled_fonts::ScaledFontRequest>,
) -> Result<scaled_fonts::ScaledFontSetStatus, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    scaled_fonts::scaled_workspace_font_set_status(
        &scaled_fonts::global_scaled_font_root(&data_dir),
        Path::new(&workspace_root_path),
        &fonts,
    )
}

#[tauri::command]
async fn activate_scaled_workspace_fonts(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    workspace_root_path: String,
    fonts: Vec<scaled_fonts::ScaledFontRequest>,
) -> Result<bool, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let changed = scaled_fonts::activate_scaled_workspace_fonts(
        &scaled_fonts::global_scaled_font_root(&data_dir),
        Path::new(&workspace_root_path),
        &fonts,
    )?;
    if changed {
        stop_lsp_process(&state).await;
    }
    Ok(changed)
}

#[tauri::command]
async fn clear_scaled_workspace_fonts(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    workspace_root_path: String,
) -> Result<bool, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let changed = scaled_fonts::clear_scaled_workspace_fonts(
        &scaled_fonts::global_scaled_font_root(&data_dir),
        Path::new(&workspace_root_path),
    )?;
    if changed {
        stop_lsp_process(&state).await;
    }
    Ok(changed)
}

#[tauri::command]
fn inspect_scaled_font_cache(
    app_handle: tauri::AppHandle,
) -> Result<scaled_fonts::ScaledFontCacheReport, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(scaled_fonts::inspect_scaled_font_cache(
        &scaled_fonts::global_scaled_font_root(&data_dir),
    ))
}

#[tauri::command]
async fn delete_scaled_font_variants(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    variants: Vec<scaled_fonts::ScaledFontVariantIdentity>,
) -> Result<usize, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    stop_lsp_process(&state).await;
    scaled_fonts::delete_scaled_font_variants(
        &scaled_fonts::global_scaled_font_root(&data_dir),
        &variants,
    )
}

#[tauri::command]
fn delete_unused_scaled_font_variants(app_handle: tauri::AppHandle) -> Result<usize, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    scaled_fonts::delete_unused_scaled_font_variants(&scaled_fonts::global_scaled_font_root(
        &data_dir,
    ))
}

#[tauri::command]
async fn renew_scaled_font_variant(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    family: String,
    scale: f32,
) -> Result<scaled_fonts::ScaledFontResult, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    stop_lsp_process(&state).await;
    scaled_fonts::renew_scaled_font_variant(
        &scaled_fonts::global_scaled_font_root(&data_dir),
        &data_dir,
        &family,
        scale,
        &configured_private_font_directories(&app_handle),
    )
}

#[tauri::command]
#[cfg(debug_assertions)]
fn open_devtools(window: tauri::WebviewWindow) {
    let _ = window.open_devtools();
}

#[tauri::command]
#[cfg(not(debug_assertions))]
fn open_devtools(_window: tauri::WebviewWindow) {}

#[tauri::command]
async fn install_unicode_font(font_id: String) -> Result<font_store::InstalledFont, String> {
    font_store::install_unicode_font(&font_id).await
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn background_compiler_worker_limit(available: usize) -> Option<usize> {
    (available > 2).then_some(available - 1)
}

fn configure_background_compiler(command: &mut tokio::process::Command) {
    if let Ok(available) = std::thread::available_parallelism() {
        if let Some(limit) = background_compiler_worker_limit(available.get()) {
            // Typst uses Rayon for parallel compilation. Reserve one logical
            // processor for the WebView compositor and input thread.
            command.env("RAYON_NUM_THREADS", limit.to_string());
        }
    }
}

#[cfg(windows)]
fn lower_background_process_priority(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
    };

    let process = unsafe { OpenProcess(PROCESS_SET_INFORMATION, 0, pid) };
    if process.is_null() {
        return;
    }
    unsafe {
        SetPriorityClass(process, BELOW_NORMAL_PRIORITY_CLASS);
        CloseHandle(process);
    }
}

#[cfg(unix)]
fn lower_background_process_priority(pid: u32) {
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, pid, 5);
    }
}

#[cfg(not(any(windows, unix)))]
fn lower_background_process_priority(_pid: u32) {}

#[cfg(test)]
mod background_compiler_tests {
    use super::background_compiler_worker_limit;

    #[test]
    fn reserves_one_logical_processor_without_throttling_small_devices() {
        assert_eq!(background_compiler_worker_limit(1), None);
        assert_eq!(background_compiler_worker_limit(2), None);
        assert_eq!(background_compiler_worker_limit(4), Some(3));
        assert_eq!(background_compiler_worker_limit(16), Some(15));
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFilePayload {
    path: String,
    settings: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectImportPreflight {
    manifest: project_archive::ProjectManifest,
    manifest_sha256: String,
    entry_count: usize,
    total_uncompressed_bytes: u64,
    suggested_folder_name: String,
    toolchain_state: toolchain::ProjectToolchainState,
    active_typst_version: Option<String>,
    active_tinymist_version: Option<String>,
}

fn settings_file_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app_handle
        .path()
        .app_config_dir()
        .map(|directory| directory.join("settings.json"))
        .map_err(|error| format!("Failed to resolve settings directory: {}", error))
}

#[tauri::command]
fn load_app_settings(app_handle: tauri::AppHandle) -> Result<SettingsFilePayload, String> {
    let path = settings_file_path(&app_handle)?;
    let settings = if path.exists() {
        let contents = std::fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read settings.json: {}", error))?;
        Some(
            serde_json::from_str(&contents)
                .map_err(|error| format!("Invalid settings.json: {}", error))?,
        )
    } else {
        None
    };

    Ok(SettingsFilePayload {
        path: path.to_string_lossy().to_string(),
        settings,
    })
}

#[tauri::command]
fn save_app_settings(
    app_handle: tauri::AppHandle,
    settings: serde_json::Value,
) -> Result<String, String> {
    let path = settings_file_path(&app_handle)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings directory: {}", error))?;
    }
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("Failed to serialize settings: {}", error))?;
    std::fs::write(&path, format!("{}\n", contents))
        .map_err(|error| format!("Failed to write settings.json: {}", error))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_webview_storage_status(
    app_handle: tauri::AppHandle,
) -> Result<webview_storage::WebviewStorageReport, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let profile = webview_storage::profile_path(&data_dir);
    webview_storage::load_status(
        profile.as_deref(),
        &webview_storage::history_path(&config_dir),
        &app_handle.package_info().version.to_string(),
    )
}

#[tauri::command]
async fn scan_webview_storage(
    app_handle: tauri::AppHandle,
    full: bool,
) -> Result<webview_storage::WebviewStorageReport, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let profile = webview_storage::profile_path(&data_dir);
    let history = webview_storage::history_path(&config_dir);
    let version = app_handle.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        webview_storage::scan(profile.as_deref(), &history, &version, full)
    })
    .await
    .map_err(|error| format!("WebView storage scan task failed: {error}"))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMetadataPayload {
    project: Option<serde_json::Value>,
    workspace: Option<serde_json::Value>,
}

fn read_optional_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Invalid {}: {error}", path.display()))
}

fn write_json_atomically(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Workspace metadata path has no parent.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to stage {}: {error}", path.display()))?;
    serde_json::to_writer_pretty(&mut temporary, value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    std::io::Write::write_all(&mut temporary, b"\n")
        .map_err(|error| format!("Failed to stage {}: {error}", path.display()))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Failed to replace {}: {}", path.display(), error.error))?;
    Ok(())
}

#[tauri::command]
fn load_workspace_metadata(
    workspace_root_path: String,
) -> Result<WorkspaceMetadataPayload, String> {
    let root = Path::new(&workspace_root_path);
    if !root.is_dir() {
        return Err("The workspace root does not exist.".into());
    }
    let metadata = root.join(".typsastra");
    let config = read_optional_json(&metadata.join("config.json"))?;
    let project = if config.is_some() {
        config
    } else {
        read_optional_json(&metadata.join("project.json"))?.and_then(|manifest| {
            let main_file = manifest.pointer("/project/main")?.as_str()?;
            let tinymist_version = manifest.pointer("/toolchain/tinymistVersion")?.as_str()?;
            let typst_version = manifest.pointer("/toolchain/typstVersion")?.as_str()?;
            Some(serde_json::json!({
                "schemaVersion": 1,
                "mainFile": main_file,
                "recommendedToolchain": {
                    "tinymistVersion": tinymist_version,
                    "typstVersion": typst_version
                }
            }))
        })
    };
    Ok(WorkspaceMetadataPayload {
        project,
        workspace: read_optional_json(&metadata.join("workspace.json"))?,
    })
}

#[tauri::command]
fn save_workspace_metadata(
    workspace_root_path: String,
    project: serde_json::Value,
    workspace: serde_json::Value,
) -> Result<(), String> {
    let root = Path::new(&workspace_root_path);
    if !root.is_dir() {
        return Err("The workspace root does not exist.".into());
    }
    let metadata = root.join(".typsastra");
    write_json_atomically(&metadata.join("config.json"), &project)?;
    write_json_atomically(&metadata.join("workspace.json"), &workspace)?;
    scaled_fonts::remove_legacy_workspace_fonts(root)?;
    let ignore = metadata.join(".gitignore");
    let mut ignored = std::fs::read_to_string(&ignore)
        .unwrap_or_default()
        .lines()
        .filter(|line| line.trim() != "fonts/generated/")
        .collect::<Vec<_>>()
        .join("\n");
    for entry in ["workspace.json", "cache/"] {
        if !ignored.lines().any(|line| line.trim() == entry) {
            if !ignored.is_empty() && !ignored.ends_with('\n') {
                ignored.push('\n');
            }
            ignored.push_str(entry);
            ignored.push('\n');
        }
    }
    std::fs::write(&ignore, ignored)
        .map_err(|error| format!("Failed to write {}: {error}", ignore.display()))?;
    Ok(())
}

#[cfg(test)]
mod workspace_metadata_tests {
    use std::path::Path;

    use super::{
        load_workspace_metadata, save_workspace_metadata, save_workspace_private_font_directories,
        workspace_private_font_directories,
    };

    #[test]
    fn persists_project_and_session_metadata_inside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().to_string_lossy().to_string();
        save_workspace_metadata(
            root.clone(),
            serde_json::json!({ "schemaVersion": 1, "mainFile": "main.typ" }),
            serde_json::json!({ "schemaVersion": 1, "activeFile": "chapter.typ" }),
        )
        .unwrap();
        let loaded = load_workspace_metadata(root.clone()).unwrap();
        assert_eq!(loaded.project.unwrap()["mainFile"], "main.typ");
        assert_eq!(loaded.workspace.unwrap()["activeFile"], "chapter.typ");
        assert!(workspace.path().join(".typsastra/config.json").is_file());
        assert!(workspace.path().join(".typsastra/workspace.json").is_file());
        assert!(
            std::fs::read_to_string(workspace.path().join(".typsastra/.gitignore"))
                .unwrap()
                .contains("workspace.json")
        );

        save_workspace_metadata(
            root,
            serde_json::json!({ "schemaVersion": 1, "mainFile": "moved.typ" }),
            serde_json::json!({ "schemaVersion": 1 }),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &std::fs::read(workspace.path().join(".typsastra/config.json")).unwrap()
            )
            .unwrap()["mainFile"],
            "moved.typ"
        );
    }

    #[test]
    fn stores_inside_workspace_font_folders_relatively_and_external_folders_absolutely() {
        let workspace = tempfile::tempdir().unwrap();
        let local_fonts = workspace.path().join("fonts").join("private");
        std::fs::create_dir_all(&local_fonts).unwrap();
        let external = tempfile::tempdir().unwrap();
        let root = workspace.path().to_string_lossy().to_string();

        let stored = save_workspace_private_font_directories(
            root,
            vec![
                local_fonts.to_string_lossy().to_string(),
                external.path().to_string_lossy().to_string(),
            ],
        )
        .unwrap();

        assert!(stored.contains(&"fonts/private".to_string()));
        assert!(stored.iter().any(|path| Path::new(path).is_absolute()));
        assert_eq!(
            workspace_private_font_directories(workspace.path()).len(),
            2
        );
        let local_settings =
            std::fs::read_to_string(workspace.path().join(".typsastra/local.json")).unwrap();
        assert!(local_settings.contains("fonts/private"));
        assert!(
            std::fs::read_to_string(workspace.path().join(".typsastra/.gitignore"))
                .unwrap()
                .contains("local.json")
        );
    }

    #[test]
    fn seeds_config_from_bound_project_manifest_without_overwriting_it() {
        let workspace = tempfile::tempdir().unwrap();
        let metadata = workspace.path().join(".typsastra");
        std::fs::create_dir_all(&metadata).unwrap();
        let manifest = serde_json::json!({
            "format": "com.typsastra.project",
            "project": { "main": "book/main.typ" },
            "toolchain": { "tinymistVersion": "0.15.2", "typstVersion": "0.13.1" }
        });
        std::fs::write(
            metadata.join("project.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let root = workspace.path().to_string_lossy().to_string();
        let loaded = load_workspace_metadata(root.clone())
            .unwrap()
            .project
            .unwrap();
        assert_eq!(loaded["mainFile"], "book/main.typ");
        save_workspace_metadata(root, loaded, serde_json::json!({ "schemaVersion": 1 })).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &std::fs::read(metadata.join("project.json")).unwrap()
            )
            .unwrap(),
            manifest
        );
        assert!(metadata.join("config.json").is_file());
    }
}

#[tauri::command]
fn read_workspace_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

fn is_probably_plain_text_bytes(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    if text.contains('\0') {
        return false;
    }
    let disallowed_controls = text
        .chars()
        .filter(|character| {
            character.is_control() && !matches!(*character, '\n' | '\r' | '\t' | '\u{000C}')
        })
        .count();
    disallowed_controls <= (text.chars().count() / 100).max(1)
}

#[tauri::command]
fn is_probably_plain_text_file(path: String) -> Result<bool, String> {
    use std::io::Read;

    const PROBE_BYTES: u64 = 64 * 1024;
    let file =
        std::fs::File::open(&path).map_err(|error| format!("Failed to inspect file: {error}"))?;
    let mut bytes = Vec::with_capacity(PROBE_BYTES as usize);
    file.take(PROBE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to inspect file: {error}"))?;
    Ok(is_probably_plain_text_bytes(&bytes))
}

#[cfg(test)]
mod plain_text_detection_tests {
    use super::is_probably_plain_text_bytes;

    #[test]
    fn accepts_utf8_source_text_and_empty_files() {
        assert!(is_probably_plain_text_bytes(
            b"function y = example(x)\n  y = x + 1;\nend\n"
        ));
        assert!(is_probably_plain_text_bytes("កំណត់សម្គាល់\n".as_bytes()));
        assert!(is_probably_plain_text_bytes(b""));
    }

    #[test]
    fn rejects_binary_and_invalid_utf8_data() {
        assert!(!is_probably_plain_text_bytes(b"text\0with\0nulls"));
        assert!(!is_probably_plain_text_bytes(&[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]));
    }
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    // `canonicalize` retains Windows' extended-length prefix, allowing Draft
    // Preview hover images to be read from workspace paths longer than
    // MAX_PATH. Other platforms receive an ordinary canonical path.
    let io_path = std::fs::canonicalize(&path).unwrap_or_else(|_| std::path::PathBuf::from(&path));
    let bytes = std::fs::read(&io_path).map_err(|error| format!("Failed to read file: {error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Default)]
struct PdfRangeSources {
    next_id: AtomicU64,
    sources: Mutex<HashMap<u64, PdfRangeSource>>,
}

struct PdfRangeSource {
    file: std::fs::File,
    length: u64,
    path: PathBuf,
    delete_on_close: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfRangeSourceInfo {
    source_id: u64,
    length: u64,
}

#[tauri::command]
fn open_pdf_range_source(
    state: tauri::State<'_, PdfRangeSources>,
    path: String,
    delete_on_close: Option<bool>,
) -> Result<PdfRangeSourceInfo, String> {
    let io_path = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let file = std::fs::File::open(&io_path)
        .map_err(|error| format!("Failed to open PDF range source: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect PDF range source: {error}"))?;
    if !metadata.is_file() {
        return Err("The PDF range source is not a file.".to_string());
    }
    let length = metadata.len();
    let source_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state
        .sources
        .lock()
        .map_err(|_| "The PDF range source registry is unavailable.".to_string())?
        .insert(
            source_id,
            PdfRangeSource {
                file,
                length,
                path: io_path,
                delete_on_close: delete_on_close.unwrap_or(false),
            },
        );
    Ok(PdfRangeSourceInfo { source_id, length })
}

#[tauri::command]
fn read_pdf_range(
    state: tauri::State<'_, PdfRangeSources>,
    source_id: u64,
    begin: u64,
    end: u64,
) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};

    const MAX_RANGE_BYTES: u64 = 8 * 1024 * 1024;
    let (mut file, length) = {
        let sources = state
            .sources
            .lock()
            .map_err(|_| "The PDF range source registry is unavailable.".to_string())?;
        let source = sources
            .get(&source_id)
            .ok_or_else(|| "The PDF range source is no longer available.".to_string())?;
        let file = source
            .file
            .try_clone()
            .map_err(|error| format!("Failed to access PDF range source: {error}"))?;
        (file, source.length)
    };
    if begin >= end || end > length {
        return Err(format!(
            "Invalid PDF byte range {begin}..{end} for a {length}-byte document."
        ));
    }
    let requested = end - begin;
    if requested > MAX_RANGE_BYTES {
        return Err(format!(
            "PDF byte range request exceeds the {MAX_RANGE_BYTES}-byte safety limit."
        ));
    }
    let requested = usize::try_from(requested)
        .map_err(|_| "The requested PDF byte range is too large.".to_string())?;
    let mut bytes = vec![0; requested];
    file.seek(SeekFrom::Start(begin))
        .map_err(|error| format!("Failed to seek PDF range source: {error}"))?;
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Failed to read PDF byte range: {error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn close_pdf_range_source(state: tauri::State<'_, PdfRangeSources>, source_id: u64) {
    let source = state
        .sources
        .lock()
        .ok()
        .and_then(|mut sources| sources.remove(&source_id));
    if let Some(source) = source {
        let path = source.path.clone();
        let delete_on_close = source.delete_on_close;
        drop(source);
        if delete_on_close {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn is_preview_generation_path(path: &Path) -> bool {
    let Some(generations) = path.parent() else {
        return false;
    };
    let Some(preview) = generations.parent() else {
        return false;
    };
    let Some(cache) = preview.parent() else {
        return false;
    };
    let Some(typsastra) = cache.parent() else {
        return false;
    };
    generations.file_name().and_then(|name| name.to_str()) == Some("generations")
        && preview.file_name().and_then(|name| name.to_str()) == Some("preview")
        && cache.file_name().and_then(|name| name.to_str()) == Some("cache")
        && typsastra.file_name().and_then(|name| name.to_str()) == Some(".typsastra")
}

const MAX_RETAINED_PREVIEW_GENERATIONS: usize = 3;
const MAX_RETAINED_PREVIEW_GENERATION_BYTES: u64 = 512 * 1024 * 1024;

fn prune_preview_generation_cache(
    generations: &Path,
    protected: Option<&Path>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(generations) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect preview generation cache: {error}"
            ));
        }
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file()
                || path.extension().and_then(|extension| extension.to_str()) != Some("pdf")
            {
                return None;
            }
            let modified = metadata
                .modified()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            Some((path, modified, metadata.len()))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.1.cmp(&left.1));

    let protected_length = protected.and_then(|protected| {
        files
            .iter()
            .find(|(path, _, _)| path == protected)
            .map(|(_, _, length)| *length)
    });
    let mut retained_count = usize::from(protected_length.is_some());
    let mut retained_bytes = protected_length.unwrap_or(0);
    for (path, _, length) in files {
        let is_protected = protected.is_some_and(|protected| path == protected);
        if is_protected {
            continue;
        }
        let within_count = retained_count < MAX_RETAINED_PREVIEW_GENERATIONS;
        let within_bytes = retained_count == 0
            || retained_bytes.saturating_add(length) <= MAX_RETAINED_PREVIEW_GENERATION_BYTES;
        if within_count && within_bytes {
            retained_count += 1;
            retained_bytes = retained_bytes.saturating_add(length);
            continue;
        }
        // An older generation may still be open briefly in PDF.js. Failure is
        // harmless and will be retried on the next stage or workspace open.
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[tauri::command]
fn stage_pdf_preview_generation(path: String, generation: u64) -> Result<String, String> {
    let source = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let parent = source
        .parent()
        .ok_or_else(|| "The generated PDF has no parent directory.".to_string())?;
    let cache = parent.parent();
    let typsastra = cache.and_then(Path::parent);
    if parent.file_name().and_then(|name| name.to_str()) != Some("preview")
        || cache
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("cache")
        || typsastra
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some(".typsastra")
    {
        return Err("Only generated PDFs in .typsastra/cache/preview can be staged.".to_string());
    }
    let generations = parent.join("generations");
    std::fs::create_dir_all(&generations)
        .map_err(|error| format!("Failed to create preview generation cache: {error}"))?;
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("preview");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let target = generations.join(format!(
        "{stem}-{}-{generation}-{timestamp}.pdf",
        std::process::id()
    ));
    std::fs::rename(&source, &target)
        .map_err(|error| format!("Failed to stage compiled PDF preview: {error}"))?;
    let _ = prune_preview_generation_cache(&generations, Some(&target));
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn remove_preview_generation_file(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !is_preview_generation_path(&path) {
        return Err("Only staged PDF preview generations can be removed.".to_string());
    }
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove staged PDF preview: {error}")),
    }
}

#[cfg(test)]
mod pdf_preview_generation_tests {
    use super::{
        is_preview_generation_path, prune_preview_generation_cache, remove_preview_generation_file,
        stage_pdf_preview_generation, MAX_RETAINED_PREVIEW_GENERATIONS,
    };

    #[test]
    fn stages_and_removes_compiled_pdf_inside_preview_cache() {
        let workspace = tempfile::tempdir().unwrap();
        let preview = workspace.path().join(".typsastra/cache/preview");
        std::fs::create_dir_all(&preview).unwrap();
        let compiled = preview.join("main.pdf");
        std::fs::write(&compiled, b"%PDF-1.7\n").unwrap();

        let staged = stage_pdf_preview_generation(compiled.to_string_lossy().into_owned(), 7)
            .expect("stage compiled preview");
        let staged = std::path::PathBuf::from(staged);

        assert!(!compiled.exists());
        assert!(staged.is_file());
        assert!(is_preview_generation_path(&staged));
        assert_eq!(
            std::fs::canonicalize(staged.parent().unwrap()).unwrap(),
            std::fs::canonicalize(preview.join("generations")).unwrap()
        );

        remove_preview_generation_file(staged.to_string_lossy().into_owned())
            .expect("remove staged preview");
        assert!(!staged.exists());
    }

    #[test]
    fn rejects_staging_and_removal_outside_preview_generation_cache() {
        let workspace = tempfile::tempdir().unwrap();
        let external = workspace.path().join("document.pdf");
        std::fs::write(&external, b"%PDF-1.7\n").unwrap();

        assert!(stage_pdf_preview_generation(external.to_string_lossy().into_owned(), 1).is_err());
        assert!(remove_preview_generation_file(external.to_string_lossy().into_owned()).is_err());
        assert!(external.exists());
    }

    #[test]
    fn bounds_orphaned_preview_generations() {
        let workspace = tempfile::tempdir().unwrap();
        let generations = workspace
            .path()
            .join(".typsastra/cache/preview/generations");
        std::fs::create_dir_all(&generations).unwrap();
        for index in 0..12 {
            std::fs::write(
                generations.join(format!("main-1-{index}-{index}.pdf")),
                format!("%PDF-1.7\n{index}"),
            )
            .unwrap();
        }

        prune_preview_generation_cache(&generations, None).unwrap();

        let retained = std::fs::read_dir(generations)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("pdf")
            })
            .count();
        assert_eq!(retained, MAX_RETAINED_PREVIEW_GENERATIONS);
    }
}

#[tauri::command]
fn read_workspace_text_prefix(path: String, max_bytes: usize) -> Result<String, String> {
    use std::io::Read;
    let limit = max_bytes.clamp(1, 256 * 1024);
    let file =
        std::fs::File::open(&path).map_err(|error| format!("Failed to open file: {error}"))?;
    let mut bytes = Vec::with_capacity(limit);
    file.take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read file prefix: {error}"))?;
    while !bytes.is_empty() && std::str::from_utf8(&bytes).is_err() {
        bytes.pop();
    }
    String::from_utf8(bytes).map_err(|error| format!("File prefix is not UTF-8: {error}"))
}

#[tauri::command]
fn workspace_file_size(path: String) -> Result<u64, String> {
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("Failed to inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    Ok(metadata.len())
}

#[tauri::command]
fn workspace_text_line_count(path: String) -> Result<u64, String> {
    use std::io::BufRead;

    let file = std::fs::File::open(&path)
        .map_err(|error| format!("Failed to inspect text file: {error}"))?;
    let mut reader = std::io::BufReader::new(file);
    let mut buffer = Vec::with_capacity(8 * 1024);
    let mut line_count = 0_u64;
    loop {
        buffer.clear();
        let bytes = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|error| format!("Failed to inspect text file: {error}"))?;
        if bytes == 0 {
            break;
        }
        line_count += 1;
    }
    Ok(line_count)
}

#[tauri::command]
fn open_file_externally(path: String) -> Result<(), String> {
    let file_path = std::path::Path::new(&path);
    if !file_path.is_file() {
        return Err("The selected file does not exist or is not a file.".to_string());
    }

    open::that_detached(file_path).map_err(|error| format!("Failed to open file: {error}"))
}

#[tauri::command]
fn read_workspace_file_as_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
fn workspace_path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

struct TempFileGuard {
    path: std::path::PathBuf,
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn cleanup_dir_previews(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name != ".git"
                    && name != ".typsastra"
                    && name != ".typstella"
                    && name != "node_modules"
                    && name != "target"
                {
                    cleanup_dir_previews(&path);
                }
            } else if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.')
                        && (name.contains("typsastra-preview") || name.contains("typsastra-check"))
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }
}

fn remove_cache_symlinks(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_type()
            .is_ok_and(|file_type| file_type.is_symlink())
        {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            let _ = std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir(&path));
        } else if metadata.file_type().is_dir() {
            remove_cache_symlinks(&path);
        }
    }
}

#[tauri::command]
fn cleanup_workspace_preview_files(workspace_root_path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(workspace_root_path);
    if !root.is_dir() {
        return Ok(());
    }
    let cache_root = root.join(".typsastra").join("cache");
    validate_existing_render_cache_owner(&root, &cache_root).map_err(|error| {
        format!("Failed to validate preview cache ownership before starting Tinymist: {error}")
    })?;
    cleanup_dir_previews(&root);
    // Migrate caches written by versions that linked PDF/image assets back to
    // the project. Plain cache files keep project-folder copies safe.
    remove_cache_symlinks(&cache_root);
    // Immutable PDF generations normally delete when their range source
    // closes. Retain a small recovery window for crashes and forced shutdowns
    // instead of allowing one orphaned file to accumulate per app session.
    prune_preview_generation_cache(&cache_root.join("preview").join("generations"), None)?;
    Ok(())
}

#[tauri::command]
fn save_workspace_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Failed to save file: {}", e))
}

#[tauri::command]
fn create_workspace_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create dir: {}", e))
}

#[tauri::command]
fn rename_workspace_file(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))
}

#[tauri::command]
fn copy_workspace_file(source: String, dest: String) -> Result<(), String> {
    std::fs::copy(&source, &dest)
        .map(|_| ())
        .map_err(|e| format!("Failed to copy: {}", e))
}

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tokio::sync::mpsc;

#[allow(dead_code)]
#[cfg(windows)]
fn disable_webview_context_menus(webview: tauri::webview::PlatformWebview) {
    unsafe {
        if let Ok(core_webview) = webview.controller().CoreWebView2() {
            if let Ok(settings) = core_webview.Settings() {
                let _ = settings.SetAreDefaultContextMenusEnabled(false);
            }
        }
    }
}

#[allow(dead_code)]
#[cfg(not(windows))]
fn disable_webview_context_menus(_webview: tauri::webview::PlatformWebview) {}

struct LspState {
    generation: AtomicU64,
    tx: Mutex<Option<mpsc::Sender<String>>>,
    process: Mutex<Option<tokio::process::Child>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMemorySample {
    pid: u32,
    parent_pid: u32,
    name: String,
    working_set_bytes: u64,
}

#[cfg(windows)]
fn process_memory_samples() -> Result<Vec<ProcessMemorySample>, String> {
    use std::collections::HashSet;
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err("Unable to enumerate processes.".to_string());
    }

    let mut entries = Vec::<(u32, u32, String)>::new();
    let mut entry = unsafe { std::mem::zeroed::<PROCESSENTRY32W>() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut available = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while available {
        let name_end = entry
            .szExeFile
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(entry.szExeFile.len());
        entries.push((
            entry.th32ProcessID,
            entry.th32ParentProcessID,
            String::from_utf16_lossy(&entry.szExeFile[..name_end]),
        ));
        available = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };

    let mut related = HashSet::from([std::process::id()]);
    loop {
        let previous_len = related.len();
        for (pid, parent_pid, _) in &entries {
            if related.contains(parent_pid) {
                related.insert(*pid);
            }
        }
        if related.len() == previous_len {
            break;
        }
    }

    let mut samples = Vec::new();
    for (pid, parent_pid, name) in entries {
        if !related.contains(&pid) {
            continue;
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if process.is_null() {
            continue;
        }
        let mut counters = unsafe { std::mem::zeroed::<PROCESS_MEMORY_COUNTERS>() };
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let read = unsafe { K32GetProcessMemoryInfo(process, &mut counters, counters.cb) } != 0;
        unsafe { CloseHandle(process) };
        if read {
            samples.push(ProcessMemorySample {
                pid,
                parent_pid,
                name,
                working_set_bytes: counters.WorkingSetSize as u64,
            });
        }
    }
    samples.sort_by(|left, right| right.working_set_bytes.cmp(&left.working_set_bytes));
    Ok(samples)
}

#[cfg(not(windows))]
fn process_memory_samples() -> Result<Vec<ProcessMemorySample>, String> {
    Ok(Vec::new())
}

#[tauri::command]
fn get_memory_diagnostics() -> Result<Vec<ProcessMemorySample>, String> {
    process_memory_samples()
}

#[derive(Default)]
struct PendingProjectImports {
    paths: Mutex<Vec<PathBuf>>,
}

#[derive(Default)]
struct ProjectImportOperations {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[tauri::command]
fn cancel_typsastra_project_import(
    state: tauri::State<'_, ProjectImportOperations>,
    operation_id: String,
) {
    if let Ok(operations) = state.cancellations.lock() {
        if let Some(cancelled) = operations.get(&operation_id) {
            cancelled.store(true, Ordering::Relaxed);
        }
    }
}

impl PendingProjectImports {
    fn from_process_args() -> Self {
        let pending = Self::default();
        for argument in std::env::args_os().skip(1) {
            pending.push(PathBuf::from(argument));
        }
        pending
    }

    fn push(&self, candidate: PathBuf) {
        if !candidate
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| {
                value.eq_ignore_ascii_case("typsastra") || value.eq_ignore_ascii_case("typstella")
            })
        {
            return;
        }
        let path = dunce::canonicalize(&candidate).unwrap_or(candidate);
        if !path.is_file() {
            return;
        }
        let key = project_import_path_key(&path);
        if let Ok(mut paths) = self.paths.lock() {
            if !paths
                .iter()
                .any(|existing| project_import_path_key(existing) == key)
            {
                paths.push(path);
            }
        }
    }

    fn take(&self) -> Vec<String> {
        self.paths
            .lock()
            .map(|mut paths| {
                paths
                    .drain(..)
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn project_import_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

#[tauri::command]
fn take_pending_project_imports(state: tauri::State<'_, PendingProjectImports>) -> Vec<String> {
    state.take()
}

#[cfg(test)]
mod project_open_queue_tests {
    use super::PendingProjectImports;

    #[test]
    fn accepts_only_existing_typsastra_files_and_deduplicates_canonical_paths() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("គម្រោង test.typsastra");
        let source = directory.path().join("main.typ");
        std::fs::write(&archive, b"archive").unwrap();
        std::fs::write(&source, b"source").unwrap();
        let queue = PendingProjectImports::default();
        queue.push(archive.clone());
        queue.push(directory.path().join(".").join("គម្រោង test.typsastra"));
        queue.push(source);
        queue.push(directory.path().join("missing.typsastra"));

        let paths = queue.take();
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("គម្រោង test.typsastra"));
        assert!(queue.take().is_empty());
    }
}

#[derive(Clone, Default)]
struct StartupTimings {
    entries: Arc<Mutex<Vec<StartupTimingEntry>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupTimingEntry {
    source: &'static str,
    label: String,
    ms: f64,
}

impl StartupTimings {
    fn record(&self, source: &'static str, label: impl Into<String>, start: Instant) {
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        if let Ok(mut entries) = self.entries.lock() {
            entries.push(StartupTimingEntry {
                source,
                label: label.into(),
                ms: elapsed,
            });
        }
    }

    fn snapshot(&self) -> Vec<StartupTimingEntry> {
        self.entries
            .lock()
            .map(|entries| entries.clone())
            .unwrap_or_default()
    }
}

#[tauri::command]
fn get_startup_timings(state: tauri::State<'_, StartupTimings>) -> Vec<StartupTimingEntry> {
    state.snapshot()
}

#[tauri::command]
async fn finish_startup_initialization(
    app_handle: tauri::AppHandle,
    registry: tauri::State<'_, SegmentationRegistry>,
    timings: tauri::State<'_, StartupTimings>,
) -> Result<Vec<ProviderCapabilities>, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to locate app data directory: {error}"))?;
    let registry = registry.inner().clone();
    let timings = timings.inner().clone();
    tokio::task::spawn_blocking(move || {
        let total_start = Instant::now();

        let legacy_font_start = Instant::now();
        font_store::remove_legacy_font_cache(&data_dir);
        timings.record(
            "deferred startup",
            "remove legacy font cache",
            legacy_font_start,
        );

        let provider_reload_start = Instant::now();
        registry.reload_installed(&data_dir)?;
        timings.record(
            "deferred startup",
            "initialize language provider catalog",
            provider_reload_start,
        );

        let font_install_start = Instant::now();
        if let Err(error) = font_store::ensure_base_fonts_installed() {
            eprintln!("Failed to install bundled fonts for the current user: {error}");
        }
        timings.record(
            "deferred startup",
            "ensure and register bundled fonts",
            font_install_start,
        );

        let capabilities = registry.provider_capabilities()?;
        timings.record(
            "deferred startup",
            "finish startup initialization",
            total_start,
        );
        Ok(capabilities)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn read_workspace_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let mut entries = vec![];
    let dir = std::fs::read_dir(&path).map_err(|e| format!("Failed to read dir: {}", e))?;
    for entry in dir {
        if let Ok(entry) = entry {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // Ignore hidden system/editor metadata and temporary build files
            if file_name == ".git"
                || file_name.contains("typsastra-check")
                || file_name.contains("typsastra-preview")
                || file_name.contains(".export.typ")
            {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            entries.push(json!({
                "name": file_name,
                "isDirectory": is_dir
            }));
        }
    }
    Ok(entries)
}

#[tauri::command]
fn move_to_trash(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("Failed to move to trash: {}", e))
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to open file manager: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn open_directory_in_explorer(path: String) -> Result<(), String> {
    let directory = std::path::Path::new(&path);
    if !directory.is_dir() {
        return Err(format!(
            "Project folder does not exist: {}",
            directory.display()
        ));
    }

    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(directory)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(directory)
            .spawn()
            .map_err(|e| format!("Failed to open finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(directory)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }
    Ok(())
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PreviewTarget {
    root_path: Option<String>,
    main_path: Option<String>,
    imported: bool,
    standalone: bool,
    disabled: bool,
}

fn normalized_existing_path(path: &std::path::Path) -> std::path::PathBuf {
    // std::fs::canonicalize returns verbatim `\\?\` paths on Windows. Tinymist
    // compares source identities against ordinary file-URI paths, so keep the
    // canonical path while removing that platform-specific representation.
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn local_typst_dependencies(contents: &str, parent: &std::path::Path) -> Vec<std::path::PathBuf> {
    let bytes = contents.as_bytes();
    let mut dependencies = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"//") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index..].starts_with(b"/*") {
            index += 2;
            let mut depth = 1usize;
            while index < bytes.len() && depth > 0 {
                if bytes[index..].starts_with(b"/*") {
                    depth += 1;
                    index += 2;
                } else if bytes[index..].starts_with(b"*/") {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b'`' {
            let fence_start = index;
            while index < bytes.len() && bytes[index] == b'`' {
                index += 1;
            }
            let fence_len = index - fence_start;
            while index < bytes.len() {
                if bytes[index] == b'`' {
                    let close_start = index;
                    while index < bytes.len() && bytes[index] == b'`' {
                        index += 1;
                    }
                    if index - close_start >= fence_len {
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b'"' {
            index += 1;
            let mut escaped = false;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if byte == b'"' && !escaped {
                    break;
                }
                escaped = byte == b'\\' && !escaped;
                if byte != b'\\' {
                    escaped = false;
                }
            }
            continue;
        }
        let command_len = if bytes[index..].starts_with(b"#import") {
            7
        } else if bytes[index..].starts_with(b"#include") {
            8
        } else {
            index += 1;
            continue;
        };
        index += command_len;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'"' {
            continue;
        }
        index += 1;
        let start = index;
        let mut escaped = false;
        while index < bytes.len() {
            let byte = bytes[index];
            if byte == b'"' && !escaped {
                let raw = &contents[start..index];
                if !raw.starts_with('@') && !raw.contains("://") {
                    let candidate = normalized_existing_path(&parent.join(raw));
                    if candidate.extension().and_then(|value| value.to_str()) == Some("typ") {
                        dependencies.push(candidate);
                    }
                }
                index += 1;
                break;
            }
            escaped = byte == b'\\' && !escaped;
            if byte != b'\\' {
                escaped = false;
            }
            index += 1;
        }
    }
    // Typst also permits a path stored in a simple string binding, such as
    // `#let chapter = "chapters/one.typ"` followed by `#include chapter`.
    // Keep resolving direct literals above, then supplement them with these
    // statically knowable bindings. Arbitrary computed expressions remain the
    // compiler's responsibility.
    use std::collections::HashMap;
    use typst_syntax::ast::{
        AstNode, Expr, LetBinding, LetBindingKind, ModuleImport, ModuleInclude, Pattern,
    };

    fn collect_bound_dependencies(
        node: &typst_syntax::SyntaxNode,
        parent: &std::path::Path,
        bindings: &mut HashMap<String, String>,
        dependencies: &mut Vec<std::path::PathBuf>,
    ) {
        if let Some(binding) = LetBinding::from_untyped(node) {
            if let (
                LetBindingKind::Normal(Pattern::Normal(Expr::Ident(name))),
                Some(Expr::Str(value)),
            ) = (binding.kind(), binding.init())
            {
                bindings.insert(name.as_str().to_string(), value.get().to_string());
            }
        }

        let source = ModuleInclude::from_untyped(node)
            .map(ModuleInclude::source)
            .or_else(|| ModuleImport::from_untyped(node).map(ModuleImport::source));
        if let Some(Expr::Ident(identifier)) = source {
            if let Some(raw) = bindings.get(identifier.as_str()) {
                if !raw.starts_with('@') && !raw.contains("://") {
                    let candidate = normalized_existing_path(&parent.join(raw));
                    if candidate.extension().and_then(|value| value.to_str()) == Some("typ")
                        && !dependencies.contains(&candidate)
                    {
                        dependencies.push(candidate);
                    }
                }
            }
        }

        for child in node.children() {
            collect_bound_dependencies(child, parent, bindings, dependencies);
        }
    }

    let syntax = typst_syntax::parse(contents);
    collect_bound_dependencies(&syntax, parent, &mut HashMap::new(), &mut dependencies);
    dependencies
}

#[derive(Debug, PartialEq)]
struct StaticTypstImageReference {
    path: std::path::PathBuf,
    from_byte: usize,
    path_from_byte: usize,
    path_to_byte: usize,
    from_utf16: usize,
    to_utf16: usize,
}

fn local_typst_images(contents: &str, parent: &std::path::Path) -> Vec<StaticTypstImageReference> {
    let bytes = contents.as_bytes();
    let mut images = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"//") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index..].starts_with(b"/*") {
            index += 2;
            let mut depth = 1usize;
            while index < bytes.len() && depth > 0 {
                if bytes[index..].starts_with(b"/*") {
                    depth += 1;
                    index += 2;
                } else if bytes[index..].starts_with(b"*/") {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b'`' {
            let fence_start = index;
            while index < bytes.len() && bytes[index] == b'`' {
                index += 1;
            }
            let fence_len = index - fence_start;
            while index < bytes.len() {
                if bytes[index] == b'`' {
                    let close_start = index;
                    while index < bytes.len() && bytes[index] == b'`' {
                        index += 1;
                    }
                    if index - close_start >= fence_len {
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b'"' {
            index += 1;
            let mut escaped = false;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if byte == b'"' && !escaped {
                    break;
                }
                escaped = byte == b'\\' && !escaped;
                if byte != b'\\' {
                    escaped = false;
                }
            }
            continue;
        }
        let previous_is_identifier =
            index > 0 && (bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_');
        if previous_is_identifier || !bytes[index..].starts_with(b"image") {
            index += 1;
            continue;
        }
        let call_start = if index > 0 && bytes[index - 1] == b'#' {
            index - 1
        } else {
            index
        };
        let mut cursor = index + 5;
        if cursor < bytes.len() && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_')
        {
            index += 1;
            continue;
        }
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'(' {
            index += 1;
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'"' {
            index += 1;
            continue;
        }
        cursor += 1;
        let start = cursor;
        let mut escaped = false;
        while cursor < bytes.len() {
            let byte = bytes[cursor];
            if byte == b'"' && !escaped {
                let raw = &contents[start..cursor];
                if !raw.starts_with('@') && !raw.contains("://") && !raw.contains('\\') {
                    images.push(StaticTypstImageReference {
                        path: normalized_existing_path(&parent.join(raw)),
                        from_byte: call_start,
                        path_from_byte: start,
                        path_to_byte: cursor,
                        from_utf16: contents[..call_start].encode_utf16().count(),
                        to_utf16: contents[..cursor + 1].encode_utf16().count(),
                    });
                }
                cursor += 1;
                break;
            }
            escaped = byte == b'\\' && !escaped;
            if byte != b'\\' {
                escaped = false;
            }
            cursor += 1;
        }
        index = cursor;
    }
    images
}

fn read_raster_dimensions(path: &std::path::Path) -> Option<(u32, u32, &'static str)> {
    use std::io::Read;

    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024).read_to_end(&mut bytes).ok()?;

    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((width, height, "PNG"));
    }
    if bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        let width = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32;
        let height = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32;
        return Some((width, height, "GIF"));
    }
    if bytes.len() >= 26 && bytes.starts_with(b"BM") {
        let width = i32::from_le_bytes(bytes[18..22].try_into().ok()?).unsigned_abs();
        let height = i32::from_le_bytes(bytes[22..26].try_into().ok()?).unsigned_abs();
        return Some((width, height, "BMP"));
    }
    if bytes.len() >= 30 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        if &bytes[12..16] == b"VP8X" {
            let width = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
            let height = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
            return Some((width, height, "WebP"));
        }
    }
    if bytes.len() >= 4 && bytes.starts_with(b"\xff\xd8") {
        let mut cursor = 2usize;
        while cursor + 3 < bytes.len() {
            if bytes[cursor] != 0xff {
                cursor += 1;
                continue;
            }
            while cursor < bytes.len() && bytes[cursor] == 0xff {
                cursor += 1;
            }
            if cursor >= bytes.len() {
                break;
            }
            let marker = bytes[cursor];
            cursor += 1;
            if marker == 0xd8 || marker == 0xd9 || marker == 0x01 {
                continue;
            }
            if cursor + 2 > bytes.len() {
                break;
            }
            let segment_len =
                u16::from_be_bytes(bytes[cursor..cursor + 2].try_into().ok()?) as usize;
            if segment_len < 2 || cursor + segment_len > bytes.len() {
                break;
            }
            if matches!(
                marker,
                0xc0 | 0xc1
                    | 0xc2
                    | 0xc3
                    | 0xc5
                    | 0xc6
                    | 0xc7
                    | 0xc9
                    | 0xca
                    | 0xcb
                    | 0xcd
                    | 0xce
                    | 0xcf
            ) && segment_len >= 7
            {
                let height =
                    u16::from_be_bytes(bytes[cursor + 3..cursor + 5].try_into().ok()?) as u32;
                let width =
                    u16::from_be_bytes(bytes[cursor + 5..cursor + 7].try_into().ok()?) as u32;
                return Some((width, height, "JPEG"));
            }
            cursor += segment_len;
        }
    }
    let (width, height) = image::image_dimensions(path).ok()?;
    let format = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "PNG",
        Some("jpg" | "jpeg") => "JPEG",
        Some("gif") => "GIF",
        Some("bmp") => "BMP",
        Some("webp") => "WebP",
        _ => return None,
    };
    Some((width, height, format))
}

fn read_oriented_raster_dimensions(path: &std::path::Path) -> Option<(u32, u32, &'static str)> {
    use image::{metadata::Orientation, ImageDecoder, ImageReader};

    let (_, _, format) = read_raster_dimensions(path)?;
    let reader = ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (height, width),
        Orientation::NoTransforms
        | Orientation::Rotate180
        | Orientation::FlipHorizontal
        | Orientation::FlipVertical => (width, height),
    };
    Some((width, height, format))
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PreviewImageReference {
    source_path: String,
    from_utf16: usize,
    to_utf16: usize,
    line: usize,
    column: usize,
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PreviewImageAsset {
    path: String,
    width: u32,
    height: u32,
    source_bytes: u64,
    estimated_decoded_bytes: u64,
    format: String,
    modified_ms: u64,
    references: Vec<PreviewImageReference>,
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PreviewImageProfile {
    images: Vec<PreviewImageAsset>,
    unique_image_count: usize,
    reference_count: usize,
    total_source_bytes: u64,
    estimated_total_decoded_bytes: u64,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ProjectImageAsset {
    path: String,
    width: u32,
    height: u32,
    source_bytes: u64,
    estimated_decoded_bytes: u64,
    format: String,
    modified_ms: u64,
    referenced_by_current_document: bool,
    references: Vec<PreviewImageReference>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ProjectImageIndex {
    images: Vec<ProjectImageAsset>,
    scanned_typst_files: usize,
}

fn is_image_tool_directory(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.') || matches!(name, "node_modules" | "target"))
}

fn is_indexed_raster_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| {
            matches!(
                extension.as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp"
            )
        })
}

fn collect_project_files(
    root: &std::path::Path,
    typst_files: &mut Vec<std::path::PathBuf>,
    image_files: &mut Vec<std::path::PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !is_image_tool_directory(&path) {
                collect_project_files(&path, typst_files, image_files);
            }
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("typ") {
            typst_files.push(normalized_existing_path(&path));
        } else if is_indexed_raster_path(&path) {
            image_files.push(normalized_existing_path(&path));
        }
    }
}

fn current_document_sources(
    main_path: Option<&std::path::Path>,
) -> std::collections::HashSet<std::path::PathBuf> {
    use std::collections::{HashSet, VecDeque};
    let mut visited = HashSet::new();
    let Some(main_path) = main_path else {
        return visited;
    };
    let mut pending = VecDeque::from([normalized_existing_path(main_path)]);
    while let Some(path) = pending.pop_front() {
        if !visited.insert(path.clone()) {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        let parent = path.parent().unwrap_or(std::path::Path::new(""));
        pending.extend(local_typst_dependencies(&contents, parent));
    }
    visited
}

fn project_image_index_blocking(
    workspace_root_path: String,
    main_path: Option<String>,
) -> Result<ProjectImageIndex, String> {
    use std::collections::HashMap;
    use std::time::UNIX_EPOCH;

    let root = normalized_existing_path(std::path::Path::new(&workspace_root_path));
    if !root.is_dir() {
        return Err("Project folder does not exist".into());
    }
    let current_sources = current_document_sources(main_path.as_deref().map(std::path::Path::new));
    let mut typst_files = Vec::new();
    let mut image_files = Vec::new();
    collect_project_files(&root, &mut typst_files, &mut image_files);

    let mut references: HashMap<std::path::PathBuf, Vec<PreviewImageReference>> = HashMap::new();
    let mut referenced_by_current = std::collections::HashSet::new();
    for source_path in &typst_files {
        let Ok(contents) = std::fs::read_to_string(source_path) else {
            continue;
        };
        let parent = source_path.parent().unwrap_or(std::path::Path::new(""));
        for image_reference in local_typst_images(&contents, parent) {
            if !image_reference.path.starts_with(&root) {
                continue;
            }
            let source_prefix = &contents[..image_reference.from_byte];
            let line_start = source_prefix.rfind('\n').map_or(0, |index| index + 1);
            references
                .entry(image_reference.path.clone())
                .or_default()
                .push(PreviewImageReference {
                    source_path: source_path.to_string_lossy().to_string(),
                    from_utf16: image_reference.from_utf16,
                    to_utf16: image_reference.to_utf16,
                    line: source_prefix.bytes().filter(|byte| *byte == b'\n').count() + 1,
                    column: source_prefix[line_start..].encode_utf16().count() + 1,
                });
            if current_sources.contains(source_path) {
                referenced_by_current.insert(image_reference.path);
            }
        }
    }

    let mut images = Vec::new();
    for path in image_files {
        let Some((width, height, format)) = read_oriented_raster_dimensions(&path) else {
            continue;
        };
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or_default();
        let image_references = references.remove(&path).unwrap_or_default();
        images.push(ProjectImageAsset {
            path: path.to_string_lossy().to_string(),
            width,
            height,
            source_bytes: metadata.len(),
            estimated_decoded_bytes: u64::from(width)
                .saturating_mul(u64::from(height))
                .saturating_mul(4),
            format: format.into(),
            modified_ms,
            referenced_by_current_document: referenced_by_current.contains(&path),
            references: image_references,
        });
    }
    images.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ProjectImageIndex {
        images,
        scanned_typst_files: typst_files.len(),
    })
}

#[tauri::command]
async fn project_image_index(
    workspace_root_path: String,
    main_path: Option<String>,
) -> Result<ProjectImageIndex, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_image_index_blocking(workspace_root_path, main_path)
    })
    .await
    .map_err(|error| format!("Could not index project images: {error}"))?
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageToolPreviewRequest {
    workspace_root_path: String,
    source_path: String,
    width: u32,
    height: u32,
    format: String,
    quality: u8,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageToolPreviewResult {
    path: String,
    mime_type: String,
    width: u32,
    height: u32,
    output_bytes: u64,
}

fn image_tool_generate_preview_blocking(
    request: ImageToolPreviewRequest,
) -> Result<ImageToolPreviewResult, String> {
    use image::{
        codecs::jpeg::JpegEncoder, imageops::FilterType, metadata::Orientation, DynamicImage,
        ImageDecoder, ImageFormat, ImageReader,
    };
    use std::hash::{Hash, Hasher};
    use std::io::BufWriter;

    let root = normalized_existing_path(std::path::Path::new(&request.workspace_root_path));
    let source = normalized_existing_path(std::path::Path::new(&request.source_path));
    if !source.starts_with(&root) || !is_indexed_raster_path(&source) {
        return Err("Image optimization is restricted to local project raster images".into());
    }
    if request.width == 0
        || request.height == 0
        || request.width > 32_768
        || request.height > 32_768
    {
        return Err("Target dimensions must be between 1 and 32,768 pixels".into());
    }
    if u64::from(request.width).saturating_mul(u64::from(request.height)) > 64 * 1024 * 1024 {
        return Err("Target dimensions exceed the 64-megapixel optimization limit".into());
    }
    let format = request.format.to_ascii_lowercase();
    if !matches!(format.as_str(), "png" | "jpeg" | "jpg" | "webp") {
        return Err("Target format must be PNG, JPEG, or WebP".into());
    }
    let reader = ImageReader::open(&source)
        .map_err(|error| format!("Could not open {}: {error}", source.display()))?
        .with_guessed_format()
        .map_err(|error| format!("Could not identify {}: {error}", source.display()))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("Could not initialize {}: {error}", source.display()))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut decoded = DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("Could not decode {}: {error}", source.display()))?;
    decoded.apply_orientation(orientation);
    let resized = decoded.resize_exact(request.width, request.height, FilterType::Lanczos3);
    let cache = root.join(".typsastra").join("cache").join("image-tool");
    std::fs::create_dir_all(&cache)
        .map_err(|error| format!("Could not prepare image-tool cache: {error}"))?;
    let extension = if format == "jpg" {
        "jpeg"
    } else {
        format.as_str()
    };
    let mut identity = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut identity);
    request.width.hash(&mut identity);
    request.height.hash(&mut identity);
    format.hash(&mut identity);
    request.quality.hash(&mut identity);
    let destination = cache.join(format!(
        "preview-{identity:016x}-{request_width}x{request_height}.{extension}",
        identity = identity.finish(),
        request_width = request.width,
        request_height = request.height
    ));
    let file = std::fs::File::create(&destination)
        .map_err(|error| format!("Could not create optimization preview: {error}"))?;
    let mut writer = BufWriter::new(file);
    match format.as_str() {
        "jpeg" | "jpg" => {
            let rgb = resized.to_rgb8();
            JpegEncoder::new_with_quality(&mut writer, request.quality.clamp(1, 100))
                .encode(
                    &rgb,
                    request.width,
                    request.height,
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|error| format!("Could not encode JPEG preview: {error}"))?;
        }
        "png" => resized
            .write_to(&mut writer, ImageFormat::Png)
            .map_err(|error| format!("Could not encode PNG preview: {error}"))?,
        "webp" => resized
            .write_to(&mut writer, ImageFormat::WebP)
            .map_err(|error| format!("Could not encode WebP preview: {error}"))?,
        _ => unreachable!(),
    }
    drop(writer);
    let output_bytes = std::fs::metadata(&destination)
        .map_err(|error| format!("Could not inspect optimization preview: {error}"))?
        .len();
    Ok(ImageToolPreviewResult {
        path: destination.to_string_lossy().to_string(),
        mime_type: format!("image/{extension}"),
        width: request.width,
        height: request.height,
        output_bytes,
    })
}

#[tauri::command]
async fn image_tool_generate_preview(
    request: ImageToolPreviewRequest,
) -> Result<ImageToolPreviewResult, String> {
    tauri::async_runtime::spawn_blocking(move || image_tool_generate_preview_blocking(request))
        .await
        .map_err(|error| format!("Image optimization task failed: {error}"))?
}

#[tauri::command]
fn image_tool_save_copy(
    workspace_root_path: String,
    preview_path: String,
    destination_path: String,
) -> Result<(), String> {
    let root = normalized_existing_path(std::path::Path::new(&workspace_root_path));
    let preview = normalized_existing_path(std::path::Path::new(&preview_path));
    let expected_cache = root.join(".typsastra").join("cache").join("image-tool");
    if !preview.starts_with(expected_cache) || !preview.is_file() {
        return Err("Optimization preview is no longer available".into());
    }
    std::fs::copy(&preview, &destination_path)
        .map(|_| ())
        .map_err(|error| format!("Could not save optimized image: {error}"))
}

fn same_path_component(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn relative_file_path(
    from_directory: &std::path::Path,
    target: &std::path::Path,
) -> Option<String> {
    let from = from_directory
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect::<Vec<_>>();
    let to = target
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect::<Vec<_>>();
    let mut common = 0;
    while common < from.len()
        && common < to.len()
        && same_path_component(&from[common], &to[common])
    {
        common += 1;
    }
    if common == 0 {
        return None;
    }
    let mut relative = std::path::PathBuf::new();
    for _ in common..from.len() {
        relative.push("..");
    }
    for component in &to[common..] {
        relative.push(component);
    }
    Some(relative.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn image_tool_update_references(
    workspace_root_path: String,
    original_image_path: String,
    replacement_image_path: String,
    source_paths: Vec<String>,
) -> Result<usize, String> {
    let root = normalized_existing_path(std::path::Path::new(&workspace_root_path));
    let original = normalized_existing_path(std::path::Path::new(&original_image_path));
    let replacement = normalized_existing_path(std::path::Path::new(&replacement_image_path));
    if !root.is_dir() || !original.starts_with(&root) {
        return Err("The original image is outside the active project".into());
    }
    if !replacement.is_file() || !replacement.starts_with(&root) {
        return Err("Choose a replacement image inside the active project".into());
    }

    let mut updated = 0;
    let mut visited = std::collections::HashSet::new();
    for source_path in source_paths {
        let source = normalized_existing_path(std::path::Path::new(&source_path));
        if !source.starts_with(&root)
            || source.extension().and_then(|extension| extension.to_str()) != Some("typ")
            || !visited.insert(source.clone())
        {
            continue;
        }
        let mut contents = std::fs::read_to_string(&source)
            .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
        let parent = source.parent().unwrap_or(std::path::Path::new(""));
        let relative = relative_file_path(parent, &replacement).ok_or_else(|| {
            format!(
                "Could not create a relative Typst path from {} to {}",
                source.display(),
                replacement.display()
            )
        })?;
        let mut ranges = local_typst_images(&contents, parent)
            .into_iter()
            .filter(|reference| reference.path == original)
            .map(|reference| (reference.path_from_byte, reference.path_to_byte))
            .collect::<Vec<_>>();
        ranges.sort_unstable_by(|left, right| right.0.cmp(&left.0));
        let file_updates = ranges.len();
        for (from, to) in ranges {
            contents.replace_range(from..to, &relative);
        }
        if file_updates > 0 {
            std::fs::write(&source, contents)
                .map_err(|error| format!("Could not update {}: {error}", source.display()))?;
            updated += file_updates;
        }
    }
    Ok(updated)
}

#[cfg(test)]
mod image_tool_tests {
    use super::{
        image_tool_generate_preview_blocking, image_tool_save_copy, image_tool_update_references,
        project_image_index_blocking,
    };

    fn write_png(path: &std::path::Path, width: u32, height: u32) {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([20, 120, 80, 255]));
        image.save(path).expect("save PNG fixture");
    }

    #[test]
    fn indexes_project_images_and_tracks_current_document_references() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let root = workspace.path();
        std::fs::create_dir(root.join("images")).unwrap();
        std::fs::create_dir(root.join(".hidden")).unwrap();
        write_png(&root.join("images/current.png"), 20, 10);
        write_png(&root.join("images/unused.png"), 8, 8);
        write_png(&root.join(".hidden/ignored.png"), 4, 4);
        std::fs::write(root.join("main.typ"), "#image(\"images/current.png\")").unwrap();
        std::fs::write(root.join("other.typ"), "#image(\"images/unused.png\")").unwrap();

        let index = project_image_index_blocking(
            root.to_string_lossy().to_string(),
            Some(root.join("main.typ").to_string_lossy().to_string()),
        )
        .expect("index images");

        assert_eq!(index.scanned_typst_files, 2);
        assert_eq!(index.images.len(), 2);
        let current = index
            .images
            .iter()
            .find(|image| image.path.ends_with("current.png"))
            .unwrap();
        assert!(current.referenced_by_current_document);
        assert_eq!(current.references.len(), 1);
        let unused = index
            .images
            .iter()
            .find(|image| image.path.ends_with("unused.png"))
            .unwrap();
        assert!(!unused.referenced_by_current_document);
        assert_eq!(unused.references.len(), 1);
    }

    #[test]
    fn generates_a_bounded_optimization_preview_inside_project_cache() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let source = workspace.path().join("source.png");
        write_png(&source, 20, 10);

        let result = image_tool_generate_preview_blocking(super::ImageToolPreviewRequest {
            workspace_root_path: workspace.path().to_string_lossy().to_string(),
            source_path: source.to_string_lossy().to_string(),
            width: 10,
            height: 5,
            format: "jpeg".into(),
            quality: 80,
        })
        .expect("generate preview");

        assert_eq!((result.width, result.height), (10, 5));
        assert!(std::path::Path::new(&result.path).starts_with(workspace.path().join(".typsastra")));
        assert!(result.output_bytes > 0);
    }

    #[test]
    fn saves_an_optimized_copy_and_updates_static_typst_paths() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let root = workspace.path();
        let images = root.join("images");
        let chapters = root.join("chapters");
        std::fs::create_dir_all(&images).unwrap();
        std::fs::create_dir_all(&chapters).unwrap();
        let original = images.join("original.png");
        write_png(&original, 20, 10);
        let source = chapters.join("chapter.typ");
        std::fs::write(
            &source,
            "#image(\"../images/original.png\")\n#image(\"../images/original.png\")",
        )
        .unwrap();

        let preview = image_tool_generate_preview_blocking(super::ImageToolPreviewRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            source_path: original.to_string_lossy().to_string(),
            width: 10,
            height: 5,
            format: "png".into(),
            quality: 80,
        })
        .expect("generate preview");
        let replacement = images.join("optimized.png");
        image_tool_save_copy(
            root.to_string_lossy().to_string(),
            preview.path,
            replacement.to_string_lossy().to_string(),
        )
        .expect("save optimized copy");
        let updated = image_tool_update_references(
            root.to_string_lossy().to_string(),
            original.to_string_lossy().to_string(),
            replacement.to_string_lossy().to_string(),
            vec![source.to_string_lossy().to_string()],
        )
        .expect("update source references");

        assert_eq!(updated, 2);
        assert_eq!(
            std::fs::read_to_string(source).unwrap(),
            "#image(\"../images/optimized.png\")\n#image(\"../images/optimized.png\")"
        );
    }

    #[test]
    fn updates_static_typst_paths_after_an_image_is_renamed() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let root = workspace.path();
        let images = root.join("images");
        std::fs::create_dir_all(&images).unwrap();
        let original = images.join("original.png");
        let renamed = images.join("renamed.png");
        write_png(&original, 20, 10);
        let source = root.join("main.typ");
        std::fs::write(&source, "#image(\"images/original.png\")").unwrap();

        std::fs::rename(&original, &renamed).unwrap();
        let updated = image_tool_update_references(
            root.to_string_lossy().to_string(),
            original.to_string_lossy().to_string(),
            renamed.to_string_lossy().to_string(),
            vec![source.to_string_lossy().to_string()],
        )
        .expect("update renamed image reference");

        assert_eq!(updated, 1);
        assert_eq!(
            std::fs::read_to_string(source).unwrap(),
            "#image(\"images/renamed.png\")"
        );
    }
}

fn collect_preview_image_profile_with_override(
    root_path: &std::path::Path,
    active_source: Option<(&std::path::Path, &str)>,
) -> PreviewImageProfile {
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::time::UNIX_EPOCH;

    let mut visited_sources = HashSet::new();
    let mut pending = VecDeque::from([normalized_existing_path(root_path)]);
    let mut images_by_path: HashMap<std::path::PathBuf, PreviewImageAsset> = HashMap::new();
    while let Some(path) = pending.pop_front() {
        if !visited_sources.insert(path.clone()) {
            continue;
        }
        let contents = if active_source
            .is_some_and(|(active_path, _)| normalized_existing_path(active_path) == path)
        {
            active_source
                .map(|(_, contents)| contents.to_string())
                .unwrap_or_default()
        } else {
            let Ok(contents) = std::fs::read_to_string(&path) else {
                continue;
            };
            contents
        };
        let parent = path.parent().unwrap_or(std::path::Path::new(""));
        pending.extend(local_typst_dependencies(&contents, parent));
        for image_reference in local_typst_images(&contents, parent) {
            let source_prefix = &contents[..image_reference.from_byte];
            let line_start = source_prefix.rfind('\n').map_or(0, |index| index + 1);
            let reference = PreviewImageReference {
                source_path: path.to_string_lossy().to_string(),
                from_utf16: image_reference.from_utf16,
                to_utf16: image_reference.to_utf16,
                line: source_prefix.bytes().filter(|byte| *byte == b'\n').count() + 1,
                column: source_prefix[line_start..].encode_utf16().count() + 1,
            };
            if let Some(image) = images_by_path.get_mut(&image_reference.path) {
                image.references.push(reference);
                continue;
            }
            let Some((width, height, format)) = read_raster_dimensions(&image_reference.path)
            else {
                continue;
            };
            let estimated_decoded_bytes = u64::from(width)
                .saturating_mul(u64::from(height))
                .saturating_mul(4);
            let Ok(metadata) = std::fs::metadata(&image_reference.path) else {
                continue;
            };
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or_default();
            images_by_path.insert(
                image_reference.path.clone(),
                PreviewImageAsset {
                    path: image_reference.path.to_string_lossy().to_string(),
                    width,
                    height,
                    source_bytes: metadata.len(),
                    estimated_decoded_bytes,
                    format: format.to_string(),
                    modified_ms,
                    references: vec![reference],
                },
            );
        }
    }
    let mut images = images_by_path.into_values().collect::<Vec<_>>();
    images.sort_by(|left, right| {
        right
            .estimated_decoded_bytes
            .cmp(&left.estimated_decoded_bytes)
            .then_with(|| left.path.cmp(&right.path))
    });
    PreviewImageProfile {
        unique_image_count: images.len(),
        reference_count: images.iter().map(|image| image.references.len()).sum(),
        total_source_bytes: images.iter().fold(0u64, |total, image| {
            total.saturating_add(image.source_bytes)
        }),
        estimated_total_decoded_bytes: images.iter().fold(0u64, |total, image| {
            total.saturating_add(image.estimated_decoded_bytes)
        }),
        images,
    }
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TypstPreviewSourceStats {
    size_bytes: u64,
    line_count: u64,
    file_count: u64,
}

fn collect_typst_preview_source_stats(root_path: &std::path::Path) -> TypstPreviewSourceStats {
    use std::collections::{HashSet, VecDeque};

    let mut stats = TypstPreviewSourceStats {
        size_bytes: 0,
        line_count: 0,
        file_count: 0,
    };
    let mut visited = HashSet::new();
    let mut pending = VecDeque::from([normalized_existing_path(root_path)]);
    while let Some(path) = pending.pop_front() {
        if !visited.insert(path.clone()) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        stats.size_bytes = stats.size_bytes.saturating_add(bytes.len() as u64);
        stats.line_count = stats.line_count.saturating_add(
            bytes.iter().filter(|byte| **byte == b'\n').count() as u64
                + u64::from(!bytes.is_empty() && !bytes.ends_with(b"\n")),
        );
        stats.file_count = stats.file_count.saturating_add(1);
        let Ok(contents) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let parent = path.parent().unwrap_or(std::path::Path::new(""));
        pending.extend(local_typst_dependencies(contents, parent));
    }
    stats
}

#[tauri::command]
fn typst_preview_source_stats(root_path: String) -> TypstPreviewSourceStats {
    collect_typst_preview_source_stats(std::path::Path::new(&root_path))
}

#[tauri::command]
fn typst_preview_image_profile(
    root_path: String,
    active_source_path: Option<String>,
    active_source_contents: Option<String>,
) -> PreviewImageProfile {
    let active_source_path = active_source_path.as_deref().map(std::path::Path::new);
    let active_source = active_source_path.zip(active_source_contents.as_deref());
    collect_preview_image_profile_with_override(std::path::Path::new(&root_path), active_source)
}

fn collect_typst_files(root: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            if name != ".git"
                && name != "target"
                && name != "node_modules"
                && name != ".typsastra"
                && name != ".typstella"
            {
                collect_typst_files(&path, files);
            }
        } else if path.extension().and_then(|value| value.to_str()) == Some("typ") {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !name.contains("typsastra-preview") {
                files.push(normalized_existing_path(&path));
            }
        }
    }
}

fn allows_standalone_preview(_contents: &str) -> bool {
    // Disabled for v1.0. Keep preview resolution on the configured main
    // document until the v1.x source-sync redesign is complete.
    false
}

fn resolve_preview_target(
    file_path: String,
    workspace_root_path: Option<String>,
    file_contents: Option<String>,
    pinned_main_path: Option<String>,
) -> Result<PreviewTarget, String> {
    use std::collections::{HashMap, VecDeque};

    let path = normalized_existing_path(&std::path::PathBuf::from(&file_path));
    if path.extension().and_then(|ext| ext.to_str()) != Some("typ") {
        return Ok(PreviewTarget {
            root_path: None,
            main_path: None,
            imported: false,
            standalone: false,
            disabled: false,
        });
    }

    let active_contents =
        file_contents.unwrap_or_else(|| std::fs::read_to_string(&path).unwrap_or_default());
    let workspace_root = workspace_root_path
        .map(std::path::PathBuf::from)
        .map(|root| normalized_existing_path(&root))
        .or_else(|| path.parent().map(std::path::Path::to_path_buf));
    let mut files = Vec::new();
    if let Some(root) = workspace_root.as_deref() {
        collect_typst_files(root, &mut files);
    }
    if !files.contains(&path) {
        files.push(path.clone());
    }

    let mut reverse: HashMap<std::path::PathBuf, Vec<std::path::PathBuf>> = HashMap::new();
    for source in files {
        let contents = if source == path {
            active_contents.as_str()
        } else {
            match std::fs::read_to_string(&source) {
                Ok(contents) => {
                    for dependency in local_typst_dependencies(
                        &contents,
                        source.parent().unwrap_or(std::path::Path::new("")),
                    ) {
                        reverse.entry(dependency).or_default().push(source.clone());
                    }
                    continue;
                }
                Err(_) => continue,
            }
        };
        for dependency in local_typst_dependencies(
            contents,
            source.parent().unwrap_or(std::path::Path::new("")),
        ) {
            reverse.entry(dependency).or_default().push(source.clone());
        }
    }

    let mut ancestors: HashMap<std::path::PathBuf, usize> = HashMap::new();
    let mut queue = VecDeque::from([(path.clone(), 0usize)]);
    while let Some((child, distance)) = queue.pop_front() {
        for parent in reverse.get(&child).into_iter().flatten() {
            if ancestors
                .get(parent)
                .is_none_or(|known| distance + 1 < *known)
            {
                ancestors.insert(parent.clone(), distance + 1);
                queue.push_back((parent.clone(), distance + 1));
            }
        }
    }
    let preferred = |candidate: &std::path::Path| {
        matches!(
            candidate
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("main.typ" | "index.typ" | "document.typ")
        )
    };
    let standalone_preview = allows_standalone_preview(&active_contents);

    let mut preview_disabled = false;
    let main_root = if let Some(ref pinned) = pinned_main_path {
        let pinned_buf = normalized_existing_path(&std::path::PathBuf::from(pinned));
        let is_pinned_active = pinned_buf == path;

        if is_pinned_active {
            None
        } else if ancestors.contains_key(&pinned_buf) {
            Some(pinned_buf)
        } else {
            if !standalone_preview {
                preview_disabled = true;
            }
            None
        }
    } else {
        ancestors
            .iter()
            .filter(|(candidate, _)| preferred(candidate))
            .max_by_key(|(_, distance)| *distance)
            .or_else(|| ancestors.iter().max_by_key(|(_, distance)| *distance))
            .map(|(candidate, _)| candidate.clone())
    };

    let imported = if pinned_main_path.is_some() {
        if let Some(ref pinned) = pinned_main_path {
            let pinned_buf = normalized_existing_path(&std::path::PathBuf::from(pinned));
            pinned_buf != path && ancestors.contains_key(&pinned_buf)
        } else {
            false
        }
    } else {
        !ancestors.is_empty()
    };

    let root = if imported && standalone_preview {
        path.clone()
    } else {
        main_root.clone().unwrap_or_else(|| path.clone())
    };

    Ok(PreviewTarget {
        root_path: Some(root.to_string_lossy().to_string()),
        main_path: main_root.map(|p| p.to_string_lossy().to_string()),
        imported,
        standalone: !imported || standalone_preview,
        disabled: preview_disabled,
    })
}

#[tauri::command]
fn resolve_preview_main(
    file_path: String,
    workspace_root_path: Option<String>,
    file_contents: Option<String>,
    pinned_main_path: Option<String>,
) -> Result<PreviewTarget, String> {
    resolve_preview_target(
        file_path,
        workspace_root_path,
        file_contents,
        pinned_main_path,
    )
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TypstCheckDiagnostic {
    severity: String,
    message: String,
    line: Option<usize>,
    column: Option<usize>,
}

#[tauri::command]
async fn check_typst_document(
    app_handle: tauri::AppHandle,
    source_code: String,
    file_path: String,
) -> Result<Vec<TypstCheckDiagnostic>, String> {
    use tauri::Manager;

    let path = std::path::Path::new(&file_path);
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy();

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    let input_path = parent.join(format!(".{}.typsastra-check-{}.typ", file_stem, nonce));
    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!(".{}.typsastra-check-{}.svg", file_stem, nonce));

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let tinymist_cmd = active_tinymist(&data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;

    std::fs::write(&input_path, source_code).map_err(|e| format!("Check write failed: {}", e))?;
    let _input_guard = TempFileGuard {
        path: input_path.clone(),
    };
    let _output_guard = TempFileGuard {
        path: output_path.clone(),
    };

    let mut command = std::process::Command::new(&tinymist_cmd);
    command.current_dir(parent);
    apply_workspace_font_paths(&mut command, &app_handle, &data_dir, parent);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.arg("compile");
    let output = command
        .arg("--root")
        .arg(parent)
        .arg("--format")
        .arg("svg")
        .arg(&input_path)
        .arg(&output_path)
        .output()
        .map_err(|e| format!("Tinymist check failed to start: {}", e));

    let output = output?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(parse_typst_check_diagnostics(&stderr))
}

fn parse_typst_check_diagnostics(stderr: &str) -> Vec<TypstCheckDiagnostic> {
    let mut diagnostics = Vec::new();

    for line in stderr.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(diagnostic) = parse_short_typst_diagnostic(trimmed) {
            diagnostics.push(diagnostic);
        } else if trimmed.starts_with("error:") || trimmed.starts_with("warning:") {
            let (severity, message) = trimmed.split_once(':').unwrap_or(("error", trimmed));
            diagnostics.push(TypstCheckDiagnostic {
                severity: severity.to_string(),
                message: message.trim().to_string(),
                line: None,
                column: None,
            });
        }
    }

    diagnostics
}

fn parse_short_typst_diagnostic(line: &str) -> Option<TypstCheckDiagnostic> {
    let (location, severity, message) =
        if let Some((location, message)) = line.split_once(": error:") {
            (location, "error", message)
        } else if let Some((location, message)) = line.split_once(": warning:") {
            (location, "warning", message)
        } else if let Some((location, message)) = line.split_once(": info:") {
            (location, "info", message)
        } else {
            return None;
        };

    let mut location_parts = location.rsplitn(3, ':');
    let column_number = location_parts.next()?.parse::<usize>().ok()?;
    let line_number = location_parts.next()?.parse::<usize>().ok()?;

    Some(TypstCheckDiagnostic {
        severity: severity.to_string(),
        message: message.trim().to_string(),
        line: Some(line_number),
        column: Some(column_number),
    })
}

#[tauri::command]
async fn compile_typst_document(
    app_handle: tauri::AppHandle,
    source_code: String,
    file_path: String,
) -> Result<String, String> {
    use tauri::Manager;
    let path = std::path::Path::new(&file_path);
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    // The source must remain beside the document so relative imports resolve,
    // but its name must be short enough for deeply nested Windows workspaces.
    let input_path = parent.join(format!("t-{:016x}.typ", nonce as u64));
    // Keep compiler persistence outside the long workspace path entirely.
    let output_path = std::env::temp_dir().join(format!(
        "typsastra-export-{}-{nonce:x}.pdf",
        std::process::id()
    ));

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let tinymist_cmd = active_tinymist(&data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&input_path)
        .map_err(|e| format!("IO Failure: {}", e))?;
    std::io::Write::write_all(&mut file, source_code.as_bytes())
        .map_err(|e| format!("Buffer Flush Failure: {}", e))?;

    let mut command = std::process::Command::new(&tinymist_cmd);
    command.current_dir(parent);
    apply_workspace_font_paths(&mut command, &app_handle, &data_dir, parent);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.arg("compile");
    // A previous interrupted export must never make a failed compile appear successful.
    let _ = std::fs::remove_file(&output_path);
    let output =
        command
            .arg("--root")
            .arg(".")
            .arg(input_path.file_name().ok_or_else(|| {
                "Failed to construct the temporary Typst export path.".to_string()
            })?)
            .arg(&output_path)
            .output()
            .map_err(|e| format!("Host binary execution blocked: {}", e))?;

    let _ = std::fs::remove_file(&input_path);

    if !output.status.success() {
        let stderr_string = String::from_utf8_lossy(&output.stderr).to_string();
        let warning_only = warning_only_pdf_result(&output_path, &stderr_string);
        if !warning_only {
            let _ = std::fs::remove_file(&output_path);
            return Err(stderr_string);
        }
    }

    Ok(output_path.to_string_lossy().to_string())
}

fn warning_only_pdf_result(output_path: &Path, stderr: &str) -> bool {
    output_path.is_file()
        && stderr
            .lines()
            .any(|line| line.trim_start().starts_with("warning:"))
        && !stderr
            .lines()
            .any(|line| line.trim_start().starts_with("error:"))
}

#[cfg(test)]
mod export_compile_tests {
    use super::warning_only_pdf_result;

    #[test]
    fn accepts_only_warning_output_that_produced_a_fresh_pdf() {
        let directory = tempfile::tempdir().unwrap();
        let pdf = directory.path().join("export.pdf");
        assert!(!warning_only_pdf_result(
            &pdf,
            "warning: PDF contains optional content groups"
        ));
        std::fs::write(&pdf, b"%PDF-1.7").unwrap();
        assert!(warning_only_pdf_result(
            &pdf,
            "warning: PDF contains optional content groups"
        ));
        assert!(!warning_only_pdf_result(
            &pdf,
            "warning: recovered output\nerror: compilation failed"
        ));
    }
}

#[tauri::command]
#[allow(dead_code)]
async fn compile_typst_preview(
    _app_handle: tauri::AppHandle,
    source_code: String,
    file_path: String,
    preview_root_path: Option<String>,
) -> Result<Vec<String>, String> {
    let active_path = std::path::Path::new(&file_path);
    let preview_path = preview_root_path
        .as_deref()
        .map(std::path::Path::new)
        .unwrap_or(active_path);
    let path = preview_path;
    let preview_source = if preview_path == active_path {
        source_code
    } else {
        std::fs::read_to_string(preview_path)
            .map_err(|error| format!("Failed to read preview root: {}", error))?
    };
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let prefix = format!(".{}.typsastra-preview-{}-", file_stem, nonce);
    let input_path = parent.join(format!("{}.typ", prefix));

    let temp_dir = std::env::temp_dir();
    let output_pattern = temp_dir.join(format!("{}{{0p}}.svg", prefix));

    // Clean up previously generated preview files to prevent disk leak
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with(&format!(".{}.typsastra-preview-", file_stem))
                        && name.ends_with(".svg")
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }

    let typst_cmd = std::path::PathBuf::from("typst");

    std::fs::write(&input_path, preview_source)
        .map_err(|error| format!("Preview source write failed: {}", error))?;
    let _input_guard = TempFileGuard {
        path: input_path.clone(),
    };
    let mut command = std::process::Command::new(&typst_cmd);
    command.current_dir(parent);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output =
        command
            .arg("compile")
            .arg("--root")
            .arg(".")
            .arg("--format")
            .arg("svg")
            .arg(input_path.file_name().ok_or_else(|| {
                "Failed to construct the temporary Typst preview path.".to_string()
            })?)
            .arg(&output_pattern)
            .output()
            .map_err(|error| format!("Tinymist preview failed to start: {}", error));
    let output = output?;

    let mut page_paths: Vec<_> = std::fs::read_dir(&temp_dir)
        .map_err(|error| format!("Failed to read compiled preview: {}", error))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|candidate| {
            candidate
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".svg"))
        })
        .collect();
    page_paths.sort();
    if !output.status.success() {
        for page in page_paths {
            let _ = std::fs::remove_file(page);
        }
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    if page_paths.is_empty() {
        return Err("Typst produced no SVG preview pages.".to_string());
    }

    Ok(page_paths
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
#[allow(dead_code)]
async fn compile_typst_pdf_preview(
    _app_handle: tauri::AppHandle,
    source_code: String,
    file_path: String,
    preview_root_path: Option<String>,
) -> Result<String, String> {
    let active_path = std::path::Path::new(&file_path);
    let preview_path = preview_root_path
        .as_deref()
        .map(std::path::Path::new)
        .unwrap_or(active_path);
    let path = preview_path;
    let preview_source = if preview_path == active_path {
        source_code
    } else {
        std::fs::read_to_string(preview_path)
            .map_err(|error| format!("Failed to read preview root: {}", error))?
    };
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let prefix = format!(".{}.typsastra-preview-pdf-{}-", file_stem, nonce);
    let input_path = parent.join(format!("{}.typ", prefix));

    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!("{}.pdf", prefix));

    // Clean up previously generated PDF preview files to prevent disk leak
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with(&format!(".{}.typsastra-preview-pdf-", file_stem))
                        && name.ends_with(".pdf")
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }

    let typst_cmd = std::path::PathBuf::from("typst");

    std::fs::write(&input_path, preview_source)
        .map_err(|error| format!("Preview source write failed: {}", error))?;
    let _input_guard = TempFileGuard {
        path: input_path.clone(),
    };

    let mut command = std::process::Command::new(&typst_cmd);
    command.current_dir(parent);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .arg("compile")
        .arg("--root")
        .arg(".")
        .arg(
            input_path
                .file_name()
                .ok_or_else(|| "Failed to construct path".to_string())?,
        )
        .arg(&output_path)
        .output()
        .map_err(|error| format!("Typst compile failed: {}", error))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&output_path);
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod preview_main_tests {
    use super::{
        cleanup_workspace_preview_files, collect_preview_image_profile_with_override,
        collect_typst_preview_source_stats, local_typst_images, read_raster_dimensions,
        resolve_preview_target, TypstPreviewSourceStats,
    };

    #[test]
    fn preview_stats_include_reachable_chapters_and_templates_once() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let chapter_path = workspace.path().join("chapter.typ");
        let template_path = workspace.path().join("template.typ");
        std::fs::write(
            &main_path,
            "#import \"template.typ\": *\n#include \"chapter.typ\"\n",
        )
        .expect("write main");
        std::fs::write(&chapter_path, "#import \"template.typ\": *\nChapter\n")
            .expect("write chapter");
        std::fs::write(&template_path, "Template\n").expect("write template");

        let stats = collect_typst_preview_source_stats(&main_path);
        let expected_size = [&main_path, &chapter_path, &template_path]
            .iter()
            .map(|path| std::fs::metadata(path).expect("metadata").len())
            .sum();
        assert_eq!(
            stats,
            TypstPreviewSourceStats {
                size_bytes: expected_size,
                line_count: 5,
                file_count: 3,
            }
        );
    }

    #[test]
    fn finds_static_images_without_matching_comments_or_strings() {
        let parent = std::path::Path::new("/workspace");
        let paths = local_typst_images(
            "#image(\"hero.png\")\n// #image(\"ignored.png\")\n#let sample = \"image(\\\"also-ignored.png\\\")\"\n",
            parent,
        );
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, parent.join("hero.png"));
        assert_eq!(paths[0].from_utf16, 0);
    }

    #[test]
    fn reads_png_dimensions_and_reports_oversized_reachable_images() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let chapter_path = workspace.path().join("chapter.typ");
        let image_path = workspace.path().join("large.png");
        std::fs::write(&main_path, "#include \"chapter.typ\"\n").expect("write main");
        let chapter_source = "ខ្មែរ\n#image(\"large.png\")\n";
        std::fs::write(&chapter_path, chapter_source).expect("write chapter");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&5000u32.to_be_bytes());
        png[20..24].copy_from_slice(&4000u32.to_be_bytes());
        std::fs::write(&image_path, png).expect("write png");

        assert_eq!(
            read_raster_dimensions(&image_path),
            Some((5000, 4000, "PNG"))
        );
        let profile = collect_preview_image_profile_with_override(&main_path, None);
        assert_eq!(profile.unique_image_count, 1);
        assert_eq!(profile.reference_count, 1);
        assert_eq!(profile.estimated_total_decoded_bytes, 80_000_000);
        assert_eq!(profile.images[0].width, 5000);
        assert_eq!(profile.images[0].height, 4000);
        assert_eq!(profile.images[0].estimated_decoded_bytes, 80_000_000);
        assert_eq!(
            profile.images[0].references[0].source_path,
            chapter_path.to_string_lossy()
        );
        assert_eq!(
            profile.images[0].references[0].from_utf16,
            "ខ្មែរ\n".encode_utf16().count()
        );
        assert_eq!(profile.images[0].references[0].line, 2);
        assert_eq!(profile.images[0].references[0].column, 1);
    }

    #[test]
    fn aggregates_many_individually_small_raster_images() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let mut source = String::new();
        for index in 0..70 {
            let name = format!("small-{index}.png");
            source.push_str(&format!("#image(\"{name}\")\n"));
            let mut png = vec![0u8; 24];
            png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
            png[16..20].copy_from_slice(&1000u32.to_be_bytes());
            png[20..24].copy_from_slice(&1000u32.to_be_bytes());
            std::fs::write(workspace.path().join(name), png).expect("write png");
        }
        std::fs::write(&main_path, source).expect("write main");

        let profile = collect_preview_image_profile_with_override(&main_path, None);
        assert_eq!(profile.unique_image_count, 70);
        assert_eq!(profile.reference_count, 70);
        assert_eq!(profile.estimated_total_decoded_bytes, 280_000_000);
        assert!(profile
            .images
            .iter()
            .all(|image| image.estimated_decoded_bytes == 4_000_000));
    }

    #[test]
    fn image_profile_uses_unsaved_active_source_contents() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let image_path = workspace.path().join("draft.png");
        std::fs::write(&main_path, "No image yet\n").expect("write main");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&2000u32.to_be_bytes());
        png[20..24].copy_from_slice(&1000u32.to_be_bytes());
        std::fs::write(image_path, png).expect("write png");

        let profile = collect_preview_image_profile_with_override(
            &main_path,
            Some((&main_path, "#image(\"draft.png\")\n")),
        );
        assert_eq!(profile.unique_image_count, 1);
        assert_eq!(profile.reference_count, 1);
    }

    #[test]
    fn cleanup_only_removes_managed_preview_entries() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let preview = workspace.path().join(".chapter.typ.typsastra-preview.typ");
        let document = workspace.path().join("chapter.typ");
        std::fs::write(&preview, "preview").expect("write preview");
        std::fs::write(&document, "chapter").expect("write chapter");

        cleanup_workspace_preview_files(workspace.path().to_string_lossy().to_string())
            .expect("cleanup previews");

        assert!(!preview.exists());
        assert!(document.exists());
    }

    #[cfg(windows)]
    #[test]
    fn preview_root_uses_the_same_windows_path_form_as_lsp_documents() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        std::fs::write(&main_path, "Main document").expect("write main");

        let resolved = resolve_preview_target(
            main_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        let root = resolved.root_path.expect("preview root");
        assert!(!root.starts_with(r"\\?\"), "verbatim path leaked: {root}");
    }

    #[test]
    fn imported_file_uses_workspace_main() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let chapter_path = workspace.path().join("chapter.typ");
        std::fs::write(&main_path, "#include \"chapter.typ\"").expect("write main");
        std::fs::write(&chapter_path, "Chapter document").expect("write chapter");

        let resolved = resolve_preview_target(
            chapter_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        assert_eq!(
            resolved.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&main_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            resolved.main_path.as_deref(),
            Some(
                super::normalized_existing_path(&main_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(resolved.imported);
        assert!(!resolved.standalone);
    }

    #[test]
    fn unrelated_file_previews_itself() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let library_path = workspace.path().join("library.typ");
        std::fs::write(&main_path, "Main document").expect("write main");
        std::fs::write(&library_path, "#let helper = 1").expect("write library");

        let resolved = resolve_preview_target(
            library_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        assert_eq!(
            resolved.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&library_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(!resolved.imported);
        assert!(resolved.standalone);
    }

    #[test]
    fn standalone_directive_is_ignored_for_imported_files() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let draft_path = workspace.path().join("chapter.typ");
        std::fs::write(&main_path, "#import \"chapter.typ\"").expect("write main");
        std::fs::write(&draft_path, "Chapter").expect("write draft");

        let resolved = resolve_preview_target(
            draft_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            Some("// @standalone-preview\nUnsaved chapter".to_string()),
            Some(main_path.to_string_lossy().to_string()),
        )
        .expect("resolve preview");

        assert!(resolved.imported);
        assert!(!resolved.standalone);
        assert_eq!(
            resolved.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&main_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            resolved.main_path.as_deref(),
            Some(
                super::normalized_existing_path(&main_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[test]
    fn example_11_proves_main_and_standalone_preview_ownership() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("examples")
            .join("04-research-projects")
            .join("04-typsastra-readme");
        let main = root.join("main.typ");
        let khmer = root.join("chapters").join("khmer-research.typ");
        let standalone = root.join("chapters").join("research-workflow.typ");

        let khmer_target = resolve_preview_target(
            khmer.to_string_lossy().to_string(),
            Some(root.to_string_lossy().to_string()),
            None,
            Some(main.to_string_lossy().to_string()),
        )
        .expect("resolve Khmer chapter");
        assert_eq!(
            khmer_target.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&main)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(khmer_target.imported);
        assert!(!khmer_target.standalone);

        let standalone_target = resolve_preview_target(
            standalone.to_string_lossy().to_string(),
            Some(root.to_string_lossy().to_string()),
            None,
            Some(main.to_string_lossy().to_string()),
        )
        .expect("resolve standalone chapter");
        assert_eq!(
            standalone_target.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&main)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(standalone_target.imported);
        assert!(!standalone_target.standalone);
    }

    #[test]
    fn transitive_import_uses_top_level_main() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let chapter_path = workspace.path().join("chapter.typ");
        let helper_path = workspace.path().join("helper.typ");
        std::fs::write(&main_path, "#include \"chapter.typ\"").expect("write main");
        std::fs::write(&chapter_path, "#import \"helper.typ\"").expect("write chapter");
        std::fs::write(&helper_path, "#let value = 1").expect("write helper");

        let resolved = resolve_preview_target(
            helper_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        assert_eq!(
            resolved.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&main_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[test]
    fn commented_import_does_not_create_a_preview_parent() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let chapter_path = workspace.path().join("chapter.typ");
        std::fs::write(&main_path, "// #include \"chapter.typ\"\nMain").expect("write main");
        std::fs::write(&chapter_path, "Chapter").expect("write chapter");

        let resolved = resolve_preview_target(
            chapter_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        assert!(!resolved.imported);
    }
}

#[tauri::command]
async fn ensure_toolchain(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
) -> Result<toolchain::ToolchainStatus, String> {
    stop_lsp_process(&state).await;
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {}", error))?;
    toolchain::ensure(&data_dir).await
}

#[tauri::command]
async fn get_toolchain_status(
    app_handle: tauri::AppHandle,
) -> Result<toolchain::ToolchainStatus, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {}", error))?;
    Ok(toolchain::status(&data_dir))
}

#[tauri::command]
async fn list_tinymist_releases() -> Result<Vec<toolchain::TinymistReleaseInfo>, String> {
    toolchain::tinymist_releases().await
}

async fn stop_lsp_process(state: &tauri::State<'_, LspState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.tx.lock().unwrap() = None;
    let existing_process = state.process.lock().unwrap().take();
    if let Some(mut child) = existing_process {
        let _ = child.kill().await;
    }
}

#[tauri::command]
async fn stop_tinymist_lsp(state: tauri::State<'_, LspState>) -> Result<(), String> {
    stop_lsp_process(&state).await;
    Ok(())
}

#[tauri::command]
async fn install_tinymist_toolchain(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    version: String,
) -> Result<toolchain::ToolchainStatus, String> {
    stop_lsp_process(&state).await;
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {}", error))?;
    toolchain::install(&data_dir, &version).await
}

#[tauri::command]
async fn start_tinymist_lsp(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    workspace_root_path: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *state.tx.lock().unwrap() = None;
    let existing_process = state.process.lock().unwrap().take();
    if let Some(mut child) = existing_process {
        let _ = child.kill().await;
    }

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let tinymist_exe = active_tinymist(&data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;

    let mut command = tokio::process::Command::new(&tinymist_exe);
    let font_paths = workspace_root_path
        .as_deref()
        .map(|workspace_root| {
            compiler_font_directories(&app_handle, &data_dir, Path::new(workspace_root))
        })
        .unwrap_or_else(|| configured_private_font_directories(&app_handle));
    if !font_paths.is_empty() {
        if let Ok(value) = std::env::join_paths(font_paths) {
            command.env("TYPST_FONT_PATHS", value);
        }
    }
    command.arg("lsp");
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    configure_background_compiler(&mut command);

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn LSP: {}", e))?;
    if let Some(pid) = child.id() {
        lower_background_process_priority(pid);
    }

    let mut stdout = child.stdout.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();

    let (tx, mut rx) = mpsc::channel::<String>(32);
    *state.tx.lock().unwrap() = Some(tx);

    let app_clone = app_handle.clone();
    tokio::spawn(async move {
        let mut byte = [0u8; 1];
        let mut header = Vec::new();
        loop {
            header.clear();
            loop {
                if tokio::io::AsyncReadExt::read_exact(&mut stdout, &mut byte)
                    .await
                    .is_err()
                {
                    let current_generation = app_clone
                        .state::<LspState>()
                        .generation
                        .load(Ordering::SeqCst);
                    if current_generation == generation {
                        let _ = app_clone.emit("lsp-status", "stopped");
                    }
                    return;
                }
                header.push(byte[0]);
                if header.ends_with(b"\r\n\r\n") {
                    break;
                }
            }

            let header_str = String::from_utf8_lossy(&header);
            let mut content_length = 0;
            for line in header_str.split("\r\n") {
                if line.starts_with("Content-Length: ") {
                    content_length = line["Content-Length: ".len()..].trim().parse().unwrap_or(0);
                }
            }

            if content_length > 0 {
                let mut content = vec![0u8; content_length];
                if tokio::io::AsyncReadExt::read_exact(&mut stdout, &mut content)
                    .await
                    .is_err()
                {
                    let current_generation = app_clone
                        .state::<LspState>()
                        .generation
                        .load(Ordering::SeqCst);
                    if current_generation == generation {
                        let _ = app_clone.emit("lsp-status", "stopped");
                    }
                    return;
                }
                if let Ok(json_str) = String::from_utf8(content) {
                    #[cfg(debug_assertions)]
                    let _ = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(std::env::temp_dir().join("typsastra_lsp_log.txt"))
                        .and_then(|mut f| {
                            // PDF export responses can contain multi-megabyte
                            // Base64 payloads. Duplicating them into a formatted
                            // debug string on every save inflates the backend's
                            // allocator working set and produces unusable logs.
                            if json_str.len() > 64 * 1024 {
                                let summary = format!(
                                    "RX: <large payload omitted: {} bytes>\n",
                                    json_str.len()
                                );
                                std::io::Write::write_all(&mut f, summary.as_bytes())
                            } else {
                                std::io::Write::write_all(&mut f, b"RX: ")
                                    .and_then(|_| {
                                        std::io::Write::write_all(&mut f, json_str.as_bytes())
                                    })
                                    .and_then(|_| std::io::Write::write_all(&mut f, b"\n"))
                            }
                        });

                    let _ = app_clone.emit("lsp-rx", json_str);
                }
            }
        }
    });

    let app_clone = app_handle.clone();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            #[cfg(debug_assertions)]
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(std::env::temp_dir().join("typsastra_lsp_log.txt"))
                .and_then(|mut f| {
                    std::io::Write::write_all(&mut f, format!("TX: {}\n", msg).as_bytes())
                });

            let payload: String = format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg);
            if tokio::io::AsyncWriteExt::write_all(&mut stdin, payload.as_bytes())
                .await
                .is_err()
            {
                let current_generation = app_clone
                    .state::<LspState>()
                    .generation
                    .load(Ordering::SeqCst);
                if current_generation == generation {
                    let _ = app_clone.emit("lsp-status", "stopped");
                }
                break;
            }
            let _ = tokio::io::AsyncWriteExt::flush(&mut stdin).await;
        }
    });

    *state.process.lock().unwrap() = Some(child);
    let _ = app_handle.emit("lsp-status", "running");

    Ok(())
}

#[tauri::command]
async fn send_lsp_message(
    message: String,
    state: tauri::State<'_, LspState>,
) -> Result<(), String> {
    let tx = state.tx.lock().unwrap().clone();
    let Some(tx) = tx else {
        return Err("Tinymist LSP is not running.".to_string());
    };
    tx.send(message)
        .await
        .map_err(|_| "Tinymist LSP message channel is closed.".to_string())
}

#[tauri::command]
async fn fetch_loopback_resource(url: String) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| format!("Invalid URL: {error}"))?;
    if parsed.scheme() != "http" {
        return Err("Only http loopback preview resources can be fetched.".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Preview resource URL has no host.".to_string())?;
    if host != "127.0.0.1" && host != "localhost" && host != "::1" {
        return Err("Only loopback preview resources can be fetched.".to_string());
    }
    if parsed.port().is_none() {
        return Err("Preview resource URL must include a port.".to_string());
    }

    let response = reqwest::get(parsed)
        .await
        .map_err(|error| format!("Failed to fetch preview resource: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Preview resource request failed with {status}."));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read preview resource: {error}"))?;
    const MAX_PREVIEW_RESOURCE_BYTES: usize = 32 * 1024 * 1024;
    if bytes.len() > MAX_PREVIEW_RESOURCE_BYTES {
        return Err("Preview resource is too large.".to_string());
    }
    Ok(bytes.to_vec())
}

fn parse_loopback_url(url: &str, expected_scheme: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    if parsed.scheme() != expected_scheme {
        return Err(format!(
            "Only {expected_scheme} loopback preview URLs are supported."
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Preview URL has no host.".to_string())?;
    if host != "127.0.0.1" && host != "localhost" && host != "::1" {
        return Err("Only loopback preview URLs are supported.".to_string());
    }
    if parsed.port().is_none() {
        return Err("Preview URL must include a port.".to_string());
    }
    Ok(parsed)
}

fn preview_ws_origin(target_port: u16) -> String {
    format!("http://127.0.0.1:{target_port}")
}

const PREVIEW_WS_MAX_UPSTREAM_MESSAGE_BYTES: usize = 256 << 20;
const PREVIEW_WS_PROXY_READY_FRAME: &[u8] = b"proxy-ready,";
const PREVIEW_WS_SOURCE_MAP_READY_FRAME: &[u8] = b"source-map-ready,";

fn preview_ws_upstream_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(PREVIEW_WS_MAX_UPSTREAM_MESSAGE_BYTES))
        .max_frame_size(Some(PREVIEW_WS_MAX_UPSTREAM_MESSAGE_BYTES))
}

fn is_tinymist_vector_document_message(message: &WsMessage) -> bool {
    match message {
        WsMessage::Binary(bytes) => bytes.starts_with(b"new,") || bytes.starts_with(b"diff-v1,"),
        _ => false,
    }
}

fn report_preview_ws_proxy_error(direction: &str, error: tokio_tungstenite::tungstenite::Error) {
    use std::io::ErrorKind;
    use tokio_tungstenite::tungstenite::{error::ProtocolError, Error};

    let expected_shutdown = matches!(&error, Error::ConnectionClosed | Error::AlreadyClosed)
        || matches!(
            &error,
            Error::Protocol(ProtocolError::ResetWithoutClosingHandshake)
        )
        || matches!(
            &error,
            Error::Io(io_error)
                if matches!(
                    io_error.kind(),
                    ErrorKind::BrokenPipe | ErrorKind::ConnectionAborted | ErrorKind::ConnectionReset
                )
        );
    if !expected_shutdown {
        eprintln!("Preview WebSocket proxy {direction} failed: {error}");
    }
}

#[tauri::command]
async fn start_preview_ws_proxy(target_url: String) -> Result<String, String> {
    let target = parse_loopback_url(&target_url, "ws")?;
    let target_port = target
        .port()
        .ok_or_else(|| "Preview WebSocket URL must include a port.".to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Failed to bind preview WebSocket proxy: {error}"))?;
    let proxy_port = listener
        .local_addr()
        .map_err(|error| format!("Failed to read preview WebSocket proxy port: {error}"))?
        .port();
    let target_base = target.to_string();

    tauri::async_runtime::spawn(async move {
        // A source-map session owns one browser socket. Keep the proxy scoped
        // to that socket so failed/restarted Tinymist tasks cannot accumulate
        // dormant loopback listeners for the lifetime of the application.
        let accepted =
            tokio::time::timeout(std::time::Duration::from_secs(15), listener.accept()).await;
        let stream = match accepted {
            Ok(Ok((stream, _addr))) => stream,
            Ok(Err(error)) => {
                eprintln!("Preview WebSocket proxy accept failed: {error}");
                return;
            }
            Err(_) => return,
        };

        let requested_path = std::sync::Arc::new(std::sync::Mutex::new(String::from("/")));
        let requested_path_for_callback = requested_path.clone();
        let client_ws = match accept_hdr_async(
            stream,
            move |request: &WsServerRequest, response: WsServerResponse| {
                if let Some(path_and_query) = request.uri().path_and_query() {
                    if let Ok(mut target) = requested_path_for_callback.lock() {
                        *target = path_and_query.as_str().to_string();
                    }
                }
                Ok(response)
            },
        )
        .await
        {
            Ok(socket) => socket,
            Err(error) => {
                eprintln!("Preview WebSocket proxy client handshake failed: {error}");
                return;
            }
        };

        let path = requested_path
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "/".to_string());
        let mut outbound = match reqwest::Url::parse(&target_base) {
            Ok(url) => url,
            Err(error) => {
                eprintln!("Preview WebSocket proxy target URL invalid: {error}");
                return;
            }
        };
        outbound.set_path(path.split('?').next().unwrap_or("/"));
        outbound.set_query(path.split_once('?').map(|(_, query)| query));
        let outbound_url = outbound.to_string();
        let mut outbound_request = match outbound_url.clone().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                eprintln!("Preview WebSocket proxy request creation failed: {error}");
                return;
            }
        };
        if let Ok(value) = preview_ws_origin(target_port).parse() {
            outbound_request.headers_mut().insert("Origin", value);
        }

        let server_ws = match connect_async_with_config(
            outbound_request,
            Some(preview_ws_upstream_config()),
            false,
        )
        .await
        {
            Ok((socket, _response)) => socket,
            Err(error) => {
                report_preview_ws_proxy_error("upstream handshake", error);
                return;
            }
        };

        let (mut client_write, mut client_read) = client_ws.split();
        let (mut server_write, mut server_read) = server_ws.split();
        // The downstream WebView socket becomes OPEN before this bridge has
        // necessarily completed its upstream Tinymist handshake. A warm-up
        // command sent during that gap can produce the only source-map update
        // before the bridge is subscribed. Explicitly acknowledge the
        // completed upstream connection so the frontend can serialize the
        // first source lookup behind it.
        if let Err(error) = client_write
            .send(WsMessage::Binary(
                PREVIEW_WS_PROXY_READY_FRAME.to_vec().into(),
            ))
            .await
        {
            report_preview_ws_proxy_error("proxy-ready", error);
            return;
        }
        let client_to_server = async {
            while let Some(message) = client_read.next().await {
                server_write.send(message?).await?;
            }
            Ok::<(), tokio_tungstenite::tungstenite::Error>(())
        };
        let server_to_client = async {
            let mut source_map_ready_sent = false;
            while let Some(message) = server_read.next().await {
                let message = message?;
                // This bridge exists only for PDF forward/inverse sync. Tinymist
                // renders a complete SVG update after a source lookup, which can
                // be tens or hundreds of MiB even though Typsastra needs only the
                // small jump/viewport frame. Accept the trusted loopback frame so
                // tungstenite does not close the connection, then discard it
                // before it is copied into WebView memory.
                if is_tinymist_vector_document_message(&message) {
                    // Completing this frame also means Tinymist's render actor
                    // has built the source-map state needed by inverse sync.
                    // Readiness must not depend on whether the cursor used for
                    // the warm-up probe happens to map to visible document
                    // content, so replace the discarded SVG with a tiny local
                    // protocol sentinel.
                    if !source_map_ready_sent {
                        client_write
                            .send(WsMessage::Binary(
                                PREVIEW_WS_SOURCE_MAP_READY_FRAME.to_vec().into(),
                            ))
                            .await?;
                        source_map_ready_sent = true;
                    }
                    continue;
                }
                client_write.send(message).await?;
            }
            Ok::<(), tokio_tungstenite::tungstenite::Error>(())
        };
        tokio::select! {
            result = client_to_server => {
                if let Err(error) = result {
                    report_preview_ws_proxy_error("client-to-server", error);
                }
            }
            result = server_to_client => {
                if let Err(error) = result {
                    report_preview_ws_proxy_error("server-to-client", error);
                }
            }
        }
    });

    Ok(format!("ws://127.0.0.1:{proxy_port}"))
}

#[cfg(test)]
mod preview_ws_proxy_tests {
    use super::{
        is_tinymist_vector_document_message, parse_loopback_url, preview_ws_origin,
        start_preview_ws_proxy, PREVIEW_WS_PROXY_READY_FRAME, PREVIEW_WS_SOURCE_MAP_READY_FRAME,
    };
    use futures_util::{SinkExt, StreamExt};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async, connect_async,
        tungstenite::{
            handshake::server::{Request, Response},
            Message,
        },
    };

    #[test]
    fn accepts_only_explicit_loopback_websocket_targets() {
        assert!(parse_loopback_url("ws://127.0.0.1:34373", "ws").is_ok());
        assert!(parse_loopback_url("ws://localhost:34373/source-map", "ws").is_ok());
        assert!(parse_loopback_url("wss://127.0.0.1:34373", "ws").is_err());
        assert!(parse_loopback_url("ws://example.com:34373", "ws").is_err());
        assert!(parse_loopback_url("ws://127.0.0.1", "ws").is_err());
    }

    #[test]
    fn uses_the_tinymist_loopback_endpoint_as_upstream_origin() {
        assert_eq!(preview_ws_origin(34373), "http://127.0.0.1:34373");
    }

    #[test]
    fn identifies_only_tinymist_vector_document_frames() {
        assert!(is_tinymist_vector_document_message(&Message::Binary(
            b"new,vector payload".to_vec().into()
        )));
        assert!(is_tinymist_vector_document_message(&Message::Binary(
            b"diff-v1,vector payload".to_vec().into()
        )));
        assert!(!is_tinymist_vector_document_message(&Message::Binary(
            b"jump,2 24.5 80.25".to_vec().into()
        )));
        assert!(!is_tinymist_vector_document_message(&Message::Text(
            "current".into()
        )));
    }

    #[tokio::test]
    async fn bridges_frames_with_the_expected_upstream_origin() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let observed_origin = Arc::new(Mutex::new(None::<String>));
        let observed_origin_for_server = observed_origin.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = upstream.accept().await.unwrap();
            let mut socket =
                accept_hdr_async(stream, move |request: &Request, response: Response| {
                    let origin = request
                        .headers()
                        .get("Origin")
                        .and_then(|value| value.to_str().ok())
                        .map(ToOwned::to_owned);
                    *observed_origin_for_server.lock().unwrap() = origin;
                    Ok(response)
                })
                .await
                .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().into_text().unwrap(),
                "current"
            );
            socket
                .send(Message::Binary(b"jump,2 24.5 80.25".to_vec().into()))
                .await
                .unwrap();
            socket.close(None).await.unwrap();
        });

        let proxy_url = start_preview_ws_proxy(format!("ws://127.0.0.1:{upstream_port}"))
            .await
            .unwrap();
        let (mut client, _) = connect_async(proxy_url).await.unwrap();
        let proxy_ready = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(proxy_ready.into_data(), PREVIEW_WS_PROXY_READY_FRAME);
        client.send(Message::Text("current".into())).await.unwrap();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(frame.into_data(), b"jump,2 24.5 80.25".as_slice());
        let close = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(close.is_close());
        server.await.unwrap();
        assert_eq!(
            observed_origin.lock().unwrap().as_deref(),
            Some(format!("http://127.0.0.1:{upstream_port}").as_str())
        );
    }

    #[tokio::test]
    async fn drops_oversized_vector_frames_but_keeps_source_map_frames() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = upstream.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, |_request: &Request, response: Response| {
                Ok(response)
            })
            .await
            .unwrap();
            let mut vector = b"diff-v1,".to_vec();
            vector.resize((17 << 20) + vector.len(), b'x');
            socket.send(Message::Binary(vector.into())).await.unwrap();
            socket
                .send(Message::Binary(b"jump,7 12.5 40.25".to_vec().into()))
                .await
                .unwrap();
            socket.close(None).await.unwrap();
        });

        let proxy_url = start_preview_ws_proxy(format!("ws://127.0.0.1:{upstream_port}"))
            .await
            .unwrap();
        let (mut client, _) = connect_async(proxy_url).await.unwrap();
        let proxy_ready = tokio::time::timeout(std::time::Duration::from_secs(10), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(proxy_ready.into_data(), PREVIEW_WS_PROXY_READY_FRAME);
        let ready = tokio::time::timeout(std::time::Duration::from_secs(10), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(ready.into_data(), PREVIEW_WS_SOURCE_MAP_READY_FRAME);
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(frame.into_data(), b"jump,7 12.5 40.25".as_slice());
        server.await.unwrap();
    }
}

#[tauri::command]
async fn export_source_zip(workspace_path: String, zip_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_archive::export_source_zip(Path::new(&workspace_path), Path::new(&zip_path))
    })
    .await
    .map_err(|error| format!("Source ZIP export task failed: {error}"))?
}

#[tauri::command]
async fn export_typsastra_project(
    app_handle: tauri::AppHandle,
    workspace_path: String,
    archive_path: String,
    main_file_path: String,
) -> Result<project_archive::ProjectManifest, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {error}"))?;
    let toolchain = toolchain::status(&data_dir);
    let typst_version = toolchain.typst_version.ok_or_else(|| {
        "Cannot export a version-bound project because no validated Typst toolchain is active."
            .to_string()
    })?;
    let tinymist_version = toolchain.tinymist_version.ok_or_else(|| {
        "Cannot export a version-bound project because no validated Tinymist toolchain is active."
            .to_string()
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        project_archive::export_typsastra_project(project_archive::ProjectExport {
            workspace_root: Path::new(&workspace_path),
            archive_path: Path::new(&archive_path),
            main_file_path: Path::new(&main_file_path),
            app_version: env!("CARGO_PKG_VERSION"),
            typst_version: &typst_version,
            tinymist_version: &tinymist_version,
        })
    })
    .await
    .map_err(|error| format!("Typsastra project export task failed: {error}"))?
}

#[tauri::command]
async fn inspect_typsastra_project(
    app_handle: tauri::AppHandle,
    archive_path: String,
) -> Result<ProjectImportPreflight, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let inspection = project_archive::inspect_typsastra_project(Path::new(&archive_path))?;
        let active = toolchain::status(&data_dir);
        let toolchain_state = toolchain::project_toolchain_state(
            &data_dir,
            &inspection.manifest.toolchain.tinymist_version,
            &inspection.manifest.toolchain.typst_version,
        );
        Ok(ProjectImportPreflight {
            manifest: inspection.manifest,
            manifest_sha256: inspection.manifest_sha256,
            entry_count: inspection.entry_count,
            total_uncompressed_bytes: inspection.total_uncompressed_bytes,
            suggested_folder_name: inspection.suggested_folder_name,
            toolchain_state,
            active_typst_version: active.typst_version,
            active_tinymist_version: active.tinymist_version,
        })
    })
    .await
    .map_err(|error| format!("Project inspection task failed: {error}"))?
}

#[tauri::command]
fn validate_typsastra_project_import_destination(
    parent_path: String,
    project_name: String,
) -> Result<String, String> {
    project_archive::validate_import_destination(Path::new(&parent_path), &project_name)
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
async fn import_typsastra_project(
    app_handle: tauri::AppHandle,
    archive_path: String,
    destination_path: String,
    expected_manifest_sha256: String,
    allow_incompatible_toolchain: bool,
    operation_id: String,
    operations: tauri::State<'_, ProjectImportOperations>,
) -> Result<project_archive::ImportedProject, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {error}"))?;
    let cancelled = Arc::new(AtomicBool::new(false));
    operations
        .cancellations
        .lock()
        .map_err(|_| "Project import cancellation state is unavailable.".to_string())?
        .insert(operation_id.clone(), cancelled.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let inspection = project_archive::inspect_typsastra_project(Path::new(&archive_path))?;
        let state = toolchain::project_toolchain_state(
            &data_dir,
            &inspection.manifest.toolchain.tinymist_version,
            &inspection.manifest.toolchain.typst_version,
        );
        if !allow_incompatible_toolchain
            && !matches!(state, toolchain::ProjectToolchainState::ExactActive)
        {
            return Err(
                "The compatible project toolchain is not active. Select or download it before importing."
                    .to_string(),
            );
        }
        project_archive::import_typsastra_project_cancellable(
            Path::new(&archive_path),
            Path::new(&destination_path),
            &expected_manifest_sha256,
            || cancelled.load(Ordering::Relaxed),
        )
    })
    .await
    .map_err(|error| format!("Project import task failed: {error}"))?;
    if let Ok(mut active) = operations.cancellations.lock() {
        active.remove(&operation_id);
    }
    result
}

#[tauri::command]
async fn select_project_toolchain(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    tinymist_version: String,
    typst_version: String,
) -> Result<toolchain::ToolchainStatus, String> {
    stop_lsp_process(&state).await;
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        toolchain::select_project_toolchain(&data_dir, &tinymist_version, &typst_version)
    })
    .await
    .map_err(|error| format!("Toolchain selection task failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    compatibility::configure_process_environment();
    let native_start = Instant::now();
    let startup_timings = StartupTimings::default();
    let registry_start = Instant::now();
    let segmentation_registry = SegmentationRegistry::empty();
    startup_timings.record(
        "native startup",
        "create empty language registry",
        registry_start,
    );
    let setup_timings = startup_timings.clone();
    let pending_project_imports = PendingProjectImports::from_process_args();
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .manage(pending_project_imports)
        .manage(ProjectImportOperations::default())
        .manage(PdfRangeSources::default())
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, _working_directory| {
                let pending = app.state::<PendingProjectImports>();
                for argument in arguments.into_iter().skip(1) {
                    pending.push(PathBuf::from(argument));
                }
                let _ = app.emit("typsastra-project-open-requested", ());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(LspState {
            generation: AtomicU64::new(0),
            tx: Mutex::new(None),
            process: Mutex::new(None),
        })
        .manage(startup_timings)
        .manage(segmentation_registry)
        .setup(move |app| {
            let setup_start = Instant::now();
            let examples_start = Instant::now();
            if let Err(error) = examples::install_examples_workspace(app.handle()) {
                eprintln!("Failed to install bundled examples: {error}");
            }
            setup_timings.record("native startup", "sync bundled examples", examples_start);
            #[cfg(not(debug_assertions))]
            let context_menu_start = Instant::now();
            #[cfg(not(debug_assertions))]
            if let Some(webview) = app.get_webview_window("main") {
                let _ = webview.with_webview(disable_webview_context_menus);
            }
            #[cfg(not(debug_assertions))]
            setup_timings.record(
                "native startup",
                "configure release webview",
                context_menu_start,
            );
            setup_timings.record("native startup", "tauri setup total", setup_start);
            setup_timings.record(
                "native startup",
                "native run until setup complete",
                native_start,
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup_timings,
            get_linux_renderer_compatibility,
            prepare_linux_renderer_relaunch,
            get_memory_diagnostics,
            finish_startup_initialization,
            load_app_settings,
            save_app_settings,
            get_webview_storage_status,
            scan_webview_storage,
            load_workspace_metadata,
            save_workspace_metadata,
            compile_typst_document,
            check_typst_document,
            read_workspace_file,
            is_probably_plain_text_file,
            read_binary_file,
            open_pdf_range_source,
            read_pdf_range,
            close_pdf_range_source,
            stage_pdf_preview_generation,
            remove_preview_generation_file,
            read_workspace_text_prefix,
            workspace_file_size,
            workspace_text_line_count,
            open_file_externally,
            read_workspace_file_as_base64,
            workspace_path_exists,
            cleanup_workspace_preview_files,
            export_source_zip,
            export_typsastra_project,
            inspect_typsastra_project,
            validate_typsastra_project_import_destination,
            import_typsastra_project,
            cancel_typsastra_project_import,
            select_project_toolchain,
            take_pending_project_imports,
            save_workspace_file,
            create_workspace_dir,
            rename_workspace_file,
            copy_workspace_file,
            read_workspace_dir,
            move_to_trash,
            reveal_in_explorer,
            open_directory_in_explorer,
            resolve_preview_main,
            typst_preview_source_stats,
            typst_preview_image_profile,
            project_image_index,
            image_tool_generate_preview,
            image_tool_save_copy,
            image_tool_update_references,
            ensure_toolchain,
            get_toolchain_status,
            list_system_fonts,
            font_families_supporting_text,
            inspect_private_font_directory,
            load_workspace_private_font_directories,
            save_workspace_private_font_directories,
            prepare_scaled_workspace_font,
            prepare_named_workspace_font,
            prepared_font_library,
            compile_font_specimen,
            scaled_workspace_font_update_required,
            scaled_workspace_font_set_update_required,
            scaled_workspace_font_set_status,
            activate_scaled_workspace_fonts,
            clear_scaled_workspace_fonts,
            inspect_scaled_font_cache,
            delete_scaled_font_variants,
            delete_unused_scaled_font_variants,
            renew_scaled_font_variant,
            install_unicode_font,
            analyze_language_ranges,
            language_suggestions,
            get_provider_capabilities,
            list_hunspell_catalog,
            install_hunspell_dictionary,
            remove_hunspell_dictionary,
            open_devtools,
            complete_language_word,
            prepare_examples_workspace,
            list_tinymist_releases,
            install_tinymist_toolchain,
            start_tinymist_lsp,
            stop_tinymist_lsp,
            send_lsp_message,
            prepare_render_project,
            prepare_render_file,
            cancel_render_preparation,
            start_draft_thumbnail_generation,
            get_draft_thumbnail_status,
            cancel_draft_thumbnail_generation,
            map_generated_to_source,
            map_source_to_generated,
            fetch_loopback_resource,
            start_preview_ws_proxy
        ])
        .run(tauri::generate_context!())
        .expect("Error initializing Tauri execution engine");
}
