use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use tauri::Manager;

use super::draft::{svg_dimensions, svg_dimensions_f64};

const DIAGRAM_THUMBNAIL_CACHE_VERSION: &str = "v3";

static TEMP_SNIPPET_COUNTER: AtomicU64 = AtomicU64::new(0);
static DIAGRAM_COMPILE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

struct FileCleanup(PathBuf);

impl Drop for FileCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagramSizeCache {
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDiagramMeasurement {
    pub source_path: String,
    pub id: String,
    pub binding_name: String,
    pub diagram_kind: String,
    #[serde(default)]
    pub expression: Option<String>,
    #[serde(default)]
    pub imports: Option<String>,
    #[serde(default)]
    pub setup: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureDraftDiagramsRequest {
    pub workspace_root: String,
    #[serde(default)]
    pub cache_root_path: Option<String>,
    pub diagrams: Vec<DraftDiagramMeasurement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureDraftDiagramsResult {
    pub changed: bool,
    pub measured: usize,
}

struct MeasurementEntry {
    source_path: PathBuf,
    binding_name: String,
    expression: Option<String>,
    imports: Option<String>,
    setup: Option<String>,
    size_path: PathBuf,
}

struct DirectoryCleanup(PathBuf);

impl Drop for DirectoryCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn diagram_thumbnail_cache_dir(cache_root: &Path) -> PathBuf {
    cache_root
        .join("draft-diagram-thumbnails")
        .join(DIAGRAM_THUMBNAIL_CACHE_VERSION)
}

fn cache_identity(
    source_path: &Path,
    id: &str,
    binding_name: &str,
    diagram_kind: &str,
    layout_key: &str,
) -> Option<(String, String)> {
    let source_path = dunce::canonicalize(source_path).ok()?;
    let metadata = fs::metadata(&source_path).ok()?;
    Some(cache_identity_with_metadata(
        &source_path,
        id,
        binding_name,
        diagram_kind,
        layout_key,
        &metadata,
    ))
}

fn cache_identity_with_metadata(
    source_path: &Path,
    id: &str,
    binding_name: &str,
    diagram_kind: &str,
    layout_key: &str,
    metadata: &fs::Metadata,
) -> (String, String) {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let layout_digest = format!("{:x}", Sha256::digest(layout_key.as_bytes()));
    let cache_key = format!(
        "{}:{}:{}:{}:{}:{}",
        id,
        binding_name,
        diagram_kind,
        metadata.len(),
        modified,
        layout_digest
    );
    let cache_digest = format!("{:x}", Sha256::digest(cache_key.as_bytes()))[..16].to_string();
    let mut stable_digest = Sha256::new();
    stable_digest.update(source_path.to_string_lossy().as_bytes());
    stable_digest.update([0]);
    stable_digest.update(binding_name.as_bytes());
    let stable_key = format!("{:x}", stable_digest.finalize())[..16].to_string();
    (stable_key, cache_digest)
}

fn cache_paths(directory: &Path, stable_key: &str, cache_digest: &str) -> (PathBuf, PathBuf) {
    (
        directory.join(format!("{stable_key}-{cache_digest}.svg")),
        directory.join(format!("{stable_key}-{cache_digest}.json")),
    )
}

fn read_size_cache(path: &Path) -> Option<(f64, f64)> {
    let bytes = fs::read(path).ok()?;
    let size = serde_json::from_slice::<DiagramSizeCache>(&bytes).ok()?;
    (size.width > 0.0 && size.height > 0.0).then_some((size.width, size.height))
}

fn write_size_cache(path: &Path, width: f64, height: f64) -> Result<(), String> {
    let bytes = serde_json::to_vec(&DiagramSizeCache { width, height })
        .map_err(|error| format!("Unable to encode the Draft diagram size: {error}"))?;
    fs::write(path, bytes)
        .map_err(|error| format!("Unable to cache the Draft diagram size: {error}"))
}

fn combine_diagram_blocks<'a>(blocks: impl IntoIterator<Item = &'a str>) -> (String, bool) {
    let mut seen_imports = std::collections::HashSet::new();
    let mut lines = Vec::new();
    let mut has_setup = false;
    for block in blocks {
        for line in block.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("#import ") {
                if !seen_imports.insert(trimmed.to_string()) {
                    continue;
                }
            } else if !trimmed.is_empty() {
                has_setup = true;
            }
            lines.push(line.to_string());
        }
    }
    (lines.join("\n"), has_setup)
}

/// Fingerprints the cached diagram sizes so a Draft PDF whose placeholders were
/// generated before a size measurement cannot be restored.
pub fn diagram_size_signature(cache_root: &Path) -> String {
    let directory = diagram_thumbnail_cache_dir(cache_root);
    let mut entries = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&directory) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let metadata = entry.metadata().ok();
            let length = metadata
                .as_ref()
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            let modified = metadata
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            entries.push(format!("{name}:{length}:{modified}"));
        }
    }
    entries.sort();
    let mut digest = Sha256::new();
    digest.update(DIAGRAM_THUMBNAIL_CACHE_VERSION.as_bytes());
    for entry in entries {
        digest.update(entry.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

pub fn diagram_size_cache_path(
    cache_root: &Path,
    source_path: &Path,
    id: &str,
    binding_name: &str,
    diagram_kind: &str,
    layout_key: &str,
) -> Option<PathBuf> {
    let directory = diagram_thumbnail_cache_dir(cache_root);
    let (stable_key, cache_digest) =
        cache_identity(source_path, id, binding_name, diagram_kind, layout_key)?;
    Some(cache_paths(&directory, &stable_key, &cache_digest).1)
}

/// Reads a cached diagram size for Draft placeholder layout.
pub fn cached_diagram_dimensions(
    cache_root: &Path,
    source_path: &Path,
    id: &str,
    binding_name: &str,
    diagram_kind: &str,
    layout_key: &str,
) -> Option<(f64, f64)> {
    let directory = diagram_thumbnail_cache_dir(cache_root);
    let (stable_key, cache_digest) =
        cache_identity(source_path, id, binding_name, diagram_kind, layout_key)?;
    let (svg_path, size_path) = cache_paths(&directory, &stable_key, &cache_digest);
    if let Some(size) = read_size_cache(&size_path) {
        return Some(size);
    }
    let bytes = fs::read(svg_path).ok()?;
    let text = std::str::from_utf8(&bytes).ok()?;
    let (width, height) = svg_dimensions_f64(text)?;
    (width > 0.0 && height > 0.0).then_some((width, height))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDiagramThumbnailRequest {
    pub workspace_root: String,
    #[serde(default)]
    pub cache_root_path: Option<String>,
    pub id: String,
    pub source_path: String,
    pub binding_name: String,
    pub diagram_kind: String,
    #[serde(default)]
    pub expression: Option<String>,
    #[serde(default)]
    pub imports: Option<String>,
    #[serde(default)]
    pub setup: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDiagramThumbnailStatus {
    pub status: String,
    pub path: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn get_draft_diagram_thumbnail(
    app_handle: tauri::AppHandle,
    request: DraftDiagramThumbnailRequest,
) -> Result<DraftDiagramThumbnailStatus, String> {
    if !request
        .id
        .chars()
        .all(|character| character.is_ascii_hexdigit())
        || request.id.len() != 24
    {
        return Err("Invalid Draft diagram identifier.".into());
    }
    if !is_valid_binding_name(&request.binding_name) {
        return Err("Invalid Draft diagram binding name.".into());
    }
    if request.diagram_kind != "fletcher" && request.diagram_kind != "cetz" {
        return Err("Unsupported Draft diagram kind.".into());
    }

    let workspace_root = dunce::canonicalize(&request.workspace_root)
        .map_err(|error| format!("Unable to resolve the workspace root: {error}"))?;
    if !workspace_root.is_dir() {
        return Err("The Draft diagram workspace root is unavailable.".into());
    }
    let source_path = dunce::canonicalize(&request.source_path)
        .map_err(|error| format!("Unable to resolve the Draft diagram source: {error}"))?;
    if !source_path.is_file()
        || !source_path.starts_with(&workspace_root)
        || source_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("typ"))
    {
        return Err("The Draft diagram source must be a Typst file inside the workspace.".into());
    }

    let metadata = fs::metadata(&source_path)
        .map_err(|error| format!("Unable to inspect the Draft diagram source: {error}"))?;
    let (stable_key, cache_digest) = cache_identity_with_metadata(
        &source_path,
        &request.id,
        &request.binding_name,
        &request.diagram_kind,
        request.setup.as_deref().unwrap_or_default(),
        &metadata,
    );
    let app_local_data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get app data directory: {error}"))?;
    let cache_root = resolve_diagram_cache_root(
        &app_local_data_dir,
        &workspace_root,
        request.cache_root_path.as_deref(),
    )?;
    let cache_dir = diagram_thumbnail_cache_dir(&cache_root);
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Unable to prepare the Draft diagram cache: {error}"))?;
    let _compile_guard = DIAGRAM_COMPILE_LOCK.lock().await;
    let (cache_path, size_path) = cache_paths(&cache_dir, &stable_key, &cache_digest);
    if let Ok(bytes) = fs::read(&cache_path) {
        if is_svg(&bytes) {
            let status = thumbnail_status(&cache_path, &bytes)?;
            if !size_path.is_file() {
                if let Some((width, height)) = std::str::from_utf8(&bytes)
                    .ok()
                    .and_then(svg_dimensions_f64)
                {
                    let _ = write_size_cache(&size_path, width, height);
                    super::mirror::invalidate_draft_preparation_cache(
                        &cache_root,
                        &workspace_root,
                        &source_path,
                    );
                }
            }
            return Ok(status);
        }
    }

    let executable = crate::active_tinymist(&app_local_data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;

    let expression = request
        .expression
        .as_deref()
        .map(str::trim)
        .filter(|expression| !expression.is_empty());
    if expression.is_some_and(|expression| expression.len() > 256 * 1024) {
        return Err("The inline Draft diagram expression is too large.".into());
    }
    if request
        .imports
        .as_deref()
        .is_some_and(|imports| imports.len() > 256 * 1024)
    {
        return Err("The inline Draft diagram imports are too large.".into());
    }
    if request
        .setup
        .as_deref()
        .is_some_and(|setup| setup.len() > 256 * 1024)
    {
        return Err("The Draft diagram setup is too large.".into());
    }
    let binding_import = if expression.is_none() {
        let relative = source_path
            .strip_prefix(&workspace_root)
            .map_err(|_| "The Draft diagram source is outside the workspace.".to_string())?;
        let import_path = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
        Some(format!(
            "#import \"{}\": {}",
            escape_typst_string(&import_path),
            request.binding_name
        ))
    } else {
        None
    };
    let (blocks, has_setup) = combine_diagram_blocks([
        request.setup.as_deref().unwrap_or_default(),
        request.imports.as_deref().unwrap_or_default(),
        binding_import.as_deref().unwrap_or_default(),
    ]);
    let text_size = if has_setup {
        ""
    } else {
        "#set text(size: 11pt)\n"
    };
    let body = if let Some(expression) = expression {
        format!("#({expression})")
    } else {
        format!("#{}", request.binding_name)
    };
    let document =
        format!("{blocks}\n#set page(width: auto, height: auto, margin: 0pt)\n{text_size}{body}\n");

    // Tinymist 0.15 rejects entries whose derived project root contains `..`
    // components, so keep the transient entry directly at the workspace root.
    // The `.typsastra-` prefix keeps the workspace watcher from treating it as
    // a user edit.
    let nonce = TEMP_SNIPPET_COUNTER.fetch_add(1, Ordering::Relaxed);
    let snippet_name = format!(".typsastra-d-{:x}-{:x}.typ", std::process::id(), nonce);
    let snippet_path = workspace_root.join(&snippet_name);
    let _snippet_cleanup = FileCleanup(snippet_path.clone());
    fs::write(&snippet_path, document)
        .map_err(|error| format!("Unable to write the Draft diagram source: {error}"))?;

    let temporary_output = cache_dir.join(format!("d-{:x}-{:x}.svg", std::process::id(), nonce));
    let _temporary_cleanup = FileCleanup(temporary_output.clone());

    let mut command = tokio::process::Command::new(executable);
    command
        .arg("compile")
        .current_dir(&workspace_root)
        .arg(&snippet_name)
        .arg(&temporary_output)
        .arg("--root")
        .arg(&workspace_root)
        .arg("--format")
        .arg("svg")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let font_paths =
        crate::compiler_font_directories(&app_handle, &app_local_data_dir, &workspace_root);
    if !font_paths.is_empty() {
        if let Ok(value) = std::env::join_paths(font_paths) {
            command.env("TYPST_FONT_PATHS", value);
        }
    }
    crate::configure_background_compiler(&mut command);
    #[cfg(windows)]
    command.creation_flags(crate::CREATE_NO_WINDOW);

    let result = command
        .output()
        .await
        .map_err(|error| format!("Failed to start the Draft diagram compiler: {error}"))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Draft diagram compilation failed with {}.", result.status)
        } else {
            stderr
        });
    }
    let bytes = fs::read(&temporary_output)
        .map_err(|error| format!("Unable to read the compiled Draft diagram: {error}"))?;
    fs::write(&cache_path, &bytes)
        .map_err(|error| format!("Unable to cache the Draft diagram preview: {error}"))?;
    let status = thumbnail_status(&cache_path, &bytes)?;
    let (width, height) = std::str::from_utf8(&bytes)
        .ok()
        .and_then(svg_dimensions_f64)
        .ok_or_else(|| "The compiled Draft diagram has no valid size.".to_string())?;
    let had_size = size_path.is_file();
    write_size_cache(&size_path, width, height)?;
    if !had_size {
        super::mirror::invalidate_draft_preparation_cache(
            &cache_root,
            &workspace_root,
            &source_path,
        );
    }
    prune_previous_diagram_cache_entries(&cache_dir, &stable_key, &cache_path, &size_path);
    Ok(status)
}

#[tauri::command]
pub async fn measure_draft_diagrams(
    app_handle: tauri::AppHandle,
    request: MeasureDraftDiagramsRequest,
) -> Result<MeasureDraftDiagramsResult, String> {
    let workspace_root = dunce::canonicalize(&request.workspace_root)
        .map_err(|error| format!("Unable to resolve the workspace root: {error}"))?;
    if !workspace_root.is_dir() {
        return Err("The Draft diagram workspace root is unavailable.".into());
    }
    let app_local_data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get app data directory: {error}"))?;
    let cache_root = resolve_diagram_cache_root(
        &app_local_data_dir,
        &workspace_root,
        request.cache_root_path.as_deref(),
    )?;
    let cache_dir = diagram_thumbnail_cache_dir(&cache_root);
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Unable to prepare the Draft diagram cache: {error}"))?;
    let _compile_guard = DIAGRAM_COMPILE_LOCK.lock().await;

    let mut seen = std::collections::HashSet::new();
    let mut pending = Vec::new();
    for diagram in request.diagrams {
        if !diagram
            .id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
            || diagram.id.len() != 24
            || !is_valid_binding_name(&diagram.binding_name)
            || diagram.binding_name.starts_with('_')
            || (diagram.diagram_kind != "fletcher" && diagram.diagram_kind != "cetz")
        {
            continue;
        }
        let source_path = match dunce::canonicalize(&diagram.source_path) {
            Ok(path) => path,
            Err(_) => continue,
        };
        if !source_path.is_file()
            || !source_path.starts_with(&workspace_root)
            || source_path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("typ"))
            || !seen.insert((source_path.clone(), diagram.id.clone()))
        {
            continue;
        }
        let expression = diagram
            .expression
            .map(|expression| expression.trim().to_string())
            .filter(|expression| !expression.is_empty());
        if expression
            .as_ref()
            .is_some_and(|expression| expression.len() > 256 * 1024)
        {
            continue;
        }
        let imports = diagram
            .imports
            .map(|imports| imports.trim().to_string())
            .filter(|imports| !imports.is_empty());
        if imports
            .as_ref()
            .is_some_and(|imports| imports.len() > 256 * 1024)
        {
            continue;
        }
        let setup = diagram
            .setup
            .map(|setup| setup.trim().to_string())
            .filter(|setup| !setup.is_empty());
        if setup.as_ref().is_some_and(|setup| setup.len() > 256 * 1024) {
            continue;
        }
        let Some((stable_key, cache_digest)) = cache_identity(
            &source_path,
            &diagram.id,
            &diagram.binding_name,
            &diagram.diagram_kind,
            setup.as_deref().unwrap_or_default(),
        ) else {
            continue;
        };
        let (_, size_path) = cache_paths(&cache_dir, &stable_key, &cache_digest);
        if read_size_cache(&size_path).is_some() {
            continue;
        }
        pending.push(MeasurementEntry {
            source_path,
            binding_name: diagram.binding_name,
            expression,
            imports,
            setup,
            size_path,
        });
    }
    if pending.is_empty() {
        return Ok(MeasureDraftDiagramsResult {
            changed: false,
            measured: 0,
        });
    }

    let (document, page_entries) = build_measurement_document(&workspace_root, &pending)?;
    let nonce = TEMP_SNIPPET_COUNTER.fetch_add(1, Ordering::Relaxed);
    let snippet_name = format!(".typsastra-m-{:x}-{:x}.typ", std::process::id(), nonce);
    let snippet_path = workspace_root.join(&snippet_name);
    let _snippet_cleanup = FileCleanup(snippet_path.clone());
    fs::write(&snippet_path, document).map_err(|error| {
        format!("Unable to write the Draft diagram measurement source: {error}")
    })?;

    let output_dir = cache_dir.join(format!("measure-{:x}-{:x}", std::process::id(), nonce));
    fs::create_dir_all(&output_dir).map_err(|error| {
        format!("Unable to prepare the Draft diagram measurement output: {error}")
    })?;
    let _output_cleanup = DirectoryCleanup(output_dir.clone());
    let output_template = output_dir.join("page-{p}.svg");

    let executable = crate::active_tinymist(&app_local_data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;
    let mut command = tokio::process::Command::new(executable);
    command
        .arg("compile")
        .current_dir(&workspace_root)
        .arg(&snippet_name)
        .arg(&output_template)
        .arg("--root")
        .arg(&workspace_root)
        .arg("--format")
        .arg("svg")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let font_paths =
        crate::compiler_font_directories(&app_handle, &app_local_data_dir, &workspace_root);
    if !font_paths.is_empty() {
        if let Ok(value) = std::env::join_paths(font_paths) {
            command.env("TYPST_FONT_PATHS", value);
        }
    }
    crate::configure_background_compiler(&mut command);
    #[cfg(windows)]
    command.creation_flags(crate::CREATE_NO_WINDOW);

    let result = command
        .output()
        .await
        .map_err(|error| format!("Failed to start the Draft diagram measurement: {error}"))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Draft diagram measurement failed with {}.", result.status)
        } else {
            stderr
        });
    }

    let mut pages = Vec::new();
    for entry in fs::read_dir(&output_dir)
        .map_err(|error| format!("Unable to read the Draft diagram measurement output: {error}"))?
        .flatten()
    {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(number) = name
            .strip_prefix("page-")
            .and_then(|rest| rest.strip_suffix(".svg"))
            .and_then(|value| value.parse::<usize>().ok())
        else {
            continue;
        };
        pages.push((number, path));
    }
    pages.sort_by_key(|(number, _)| *number);
    if pages.len() != page_entries.len() {
        return Err(format!(
            "Draft diagram measurement produced {} page(s) for {} diagram(s).",
            pages.len(),
            page_entries.len()
        ));
    }
    let mut measured_sources = std::collections::HashSet::new();
    for ((_, page_path), (entry_index, _)) in pages.iter().zip(page_entries.iter()) {
        let bytes = fs::read(page_path)
            .map_err(|error| format!("Unable to read a Draft diagram measurement page: {error}"))?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| "A Draft diagram measurement page is not valid SVG.".to_string())?;
        let (width, height) = svg_dimensions_f64(text)
            .ok_or_else(|| "A Draft diagram measurement page has no valid size.".to_string())?;
        let entry = &pending[*entry_index];
        write_size_cache(&entry.size_path, width, height)?;
        measured_sources.insert(entry.source_path.clone());
    }
    for source_path in measured_sources {
        super::mirror::invalidate_draft_preparation_cache(
            &cache_root,
            &workspace_root,
            &source_path,
        );
    }
    Ok(MeasureDraftDiagramsResult {
        changed: true,
        measured: page_entries.len(),
    })
}

fn build_measurement_document(
    workspace_root: &Path,
    entries: &[MeasurementEntry],
) -> Result<(String, Vec<(usize, String)>), String> {
    let mut groups: Vec<(PathBuf, Vec<usize>)> = Vec::new();
    let mut inline_imports = Vec::new();
    let mut seen_imports = std::collections::HashSet::new();
    let mut setup_blocks = Vec::new();
    let mut seen_setups = std::collections::HashSet::new();
    let mut inline_pages = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        if let Some(setup) = &entry.setup {
            if !setup.is_empty() && seen_setups.insert(setup.clone()) {
                setup_blocks.push(setup.clone());
            }
        }
        if let Some(expression) = &entry.expression {
            if let Some(imports) = &entry.imports {
                if !imports.is_empty() && seen_imports.insert(imports.clone()) {
                    inline_imports.push(imports.clone());
                }
            }
            inline_pages.push((index, format!("#({expression})")));
            continue;
        }
        if let Some((_, indices)) = groups
            .iter_mut()
            .find(|(source_path, _)| source_path == &entry.source_path)
        {
            indices.push(index);
        } else {
            groups.push((entry.source_path.clone(), vec![index]));
        }
    }

    let mut imports = inline_imports;
    let mut page_entries = Vec::new();
    for (group_index, (source_path, indices)) in groups.iter().enumerate() {
        let relative = source_path
            .strip_prefix(workspace_root)
            .map_err(|_| "A Draft diagram source is outside the workspace.".to_string())?;
        let import_path = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
        let names = indices
            .iter()
            .map(|index| entries[*index].binding_name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        imports.push(format!(
            "#import \"{}\" as d{}: {}",
            escape_typst_string(&import_path),
            group_index,
            names
        ));
        for index in indices {
            page_entries.push((
                *index,
                format!("#d{group_index}.{}", entries[*index].binding_name),
            ));
        }
    }
    page_entries.extend(inline_pages);

    let pages = page_entries
        .iter()
        .map(|(_, page)| page.as_str())
        .collect::<Vec<_>>()
        .join("\n#pagebreak()\n");
    let (blocks, has_setup) = combine_diagram_blocks(
        setup_blocks
            .iter()
            .map(String::as_str)
            .chain(imports.iter().map(String::as_str)),
    );
    let text_size = if has_setup {
        ""
    } else {
        "#set text(size: 11pt)\n"
    };
    let document = format!(
        "{blocks}\n#set page(width: auto, height: auto, margin: 0pt)\n{text_size}{pages}\n"
    );
    Ok((document, page_entries))
}

fn resolve_diagram_cache_root(
    app_local_data_dir: &Path,
    workspace_root: &Path,
    cache_root_path: Option<&str>,
) -> Result<PathBuf, String> {
    match cache_root_path.filter(|path| !path.is_empty()) {
        Some(path) => {
            crate::resolve_managed_workspace_cache_root(app_local_data_dir, workspace_root, path)
        }
        None => {
            // The undocked preview window does not open a workspace, so it
            // cannot provide the cache root. Derive the managed project cache.
            let root = crate::workspace_render_cache_root(app_local_data_dir, workspace_root);
            fs::create_dir_all(&root)
                .map_err(|error| format!("Unable to prepare the Draft diagram cache: {error}"))?;
            dunce::canonicalize(&root)
                .map_err(|error| format!("Unable to resolve the Draft diagram cache: {error}"))
        }
    }
}

fn is_svg(bytes: &[u8]) -> bool {
    bytes.starts_with(b"<svg") || bytes.windows(4).any(|window| window == b"<svg")
}

fn prune_previous_diagram_cache_entries(
    directory: &Path,
    stable_key: &str,
    current_svg: &Path,
    current_size: &Path,
) {
    let prefix = format!("{stable_key}-");
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == current_svg || path == current_size {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with(&prefix) && (name.ends_with(".svg") || name.ends_with(".json")) {
            let _ = fs::remove_file(path);
        }
    }
}

fn thumbnail_status(path: &Path, bytes: &[u8]) -> Result<DraftDiagramThumbnailStatus, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "The compiled Draft diagram is not valid SVG.".to_string())?;
    let (width, height) = svg_dimensions(text).unwrap_or((0, 0));
    Ok(DraftDiagramThumbnailStatus {
        status: "ready".into(),
        path: path.to_string_lossy().to_string(),
        mime_type: "image/svg+xml".into(),
        width,
        height,
    })
}

fn is_valid_binding_name(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if first.is_ascii_digit() || name.len() > 128 {
        return false;
    }
    characters.all(|character| character.is_alphanumeric() || character == '_' || character == '-')
        && (first.is_alphabetic() || first == '_')
}

fn escape_typst_string(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_typst_binding_names_and_rejects_source_injection() {
        assert!(is_valid_binding_name("LLfromFol"));
        assert!(is_valid_binding_name("_private-diagram2"));
        assert!(!is_valid_binding_name(""));
        assert!(!is_valid_binding_name("2diagram"));
        assert!(!is_valid_binding_name("diagram with space"));
        assert!(!is_valid_binding_name("diagram\"\n#set page(width: 1pt)"));
    }

    #[test]
    fn prunes_previous_versions_of_the_same_diagram_thumbnail() {
        let directory = tempfile::tempdir().unwrap();
        let current_svg = directory.path().join("abc-current.svg");
        let current_size = directory.path().join("abc-current.json");
        let stale_svg = directory.path().join("abc-stale.svg");
        let stale_size = directory.path().join("abc-stale.json");
        let other = directory.path().join("def-stale.svg");
        fs::write(&current_svg, "<svg/>").unwrap();
        fs::write(&current_size, r#"{"width":1,"height":1}"#).unwrap();
        fs::write(&stale_svg, "<svg/>").unwrap();
        fs::write(&stale_size, r#"{"width":1,"height":1}"#).unwrap();
        fs::write(&other, "<svg/>").unwrap();

        prune_previous_diagram_cache_entries(directory.path(), "abc", &current_svg, &current_size);

        assert!(current_svg.is_file());
        assert!(current_size.is_file());
        assert!(!stale_svg.is_file());
        assert!(!stale_size.is_file());
        assert!(other.is_file());
    }

    #[test]
    fn reports_svg_dimensions_from_the_compiled_thumbnail() {
        let status = thumbnail_status(
            Path::new("diagram.svg"),
            br#"<svg viewBox="0 0 170.1 240.2" width="170.1pt" height="240.2pt"></svg>"#,
        )
        .unwrap();
        assert_eq!(status.width, 170);
        assert_eq!(status.height, 240);
    }

    #[test]
    fn builds_aliased_measurement_pages_for_multiple_sources() {
        let workspace = tempfile::tempdir().unwrap();
        let first = workspace.path().join("a.typ");
        let second = workspace.path().join("b.typ");
        let entries = vec![
            MeasurementEntry {
                source_path: first.clone(),
                binding_name: "A".into(),
                expression: None,
                imports: None,
                setup: None,
                size_path: workspace.path().join("a-size.json"),
            },
            MeasurementEntry {
                source_path: second.clone(),
                binding_name: "B".into(),
                expression: None,
                imports: None,
                setup: None,
                size_path: workspace.path().join("b-size.json"),
            },
            MeasurementEntry {
                source_path: first.clone(),
                binding_name: "C".into(),
                expression: None,
                imports: None,
                setup: None,
                size_path: workspace.path().join("c-size.json"),
            },
            MeasurementEntry {
                source_path: first.clone(),
                binding_name: "inline-line-9".into(),
                expression: Some("diagram(spacing: (1em, 1em))".into()),
                imports: Some("#import \"/parts/diags.typ\": *".into()),
                setup: Some("#import \"/parts/diags.typ\": *\n#set text(size: 14pt)".into()),
                size_path: workspace.path().join("inline-size.json"),
            },
        ];
        let (document, pages) = build_measurement_document(workspace.path(), &entries).unwrap();
        assert!(document.contains("#import \"/a.typ\" as d0: A, C"));
        assert!(document.contains("#import \"/b.typ\" as d1: B"));
        assert!(document.contains("#import \"/parts/diags.typ\": *"));
        assert!(document.contains("#set text(size: 14pt)"));
        assert!(!document.contains("#set text(size: 11pt)"));
        assert!(document.contains("#d0.A\n#pagebreak()\n#d0.C\n#pagebreak()\n#d1.B"));
        assert!(document.contains("#(diagram(spacing: (1em, 1em)))"));
        assert_eq!(pages.len(), 4);
    }

    #[test]
    fn size_signature_changes_when_a_diagram_size_is_cached() {
        let directory = tempfile::tempdir().unwrap();
        let cache_root = directory.path().join("cache");
        let cache_dir = diagram_thumbnail_cache_dir(&cache_root);
        fs::create_dir_all(&cache_dir).unwrap();
        let before = diagram_size_signature(&cache_root);
        write_size_cache(&cache_dir.join("diagram.json"), 122.0, 68.0).unwrap();
        let after = diagram_size_signature(&cache_root);
        assert_ne!(before, after);
    }

    #[test]
    fn round_trips_cached_diagram_sizes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("size.json");
        write_size_cache(&path, 122.0, 68.0).unwrap();
        assert_eq!(read_size_cache(&path), Some((122.0, 68.0)));
    }

    #[test]
    fn resolves_cached_dimensions_for_draft_placeholders() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("diags.typ");
        fs::write(&source, "#let D = 1").unwrap();
        let cache_root = workspace.path().join("cache");
        let cache_dir = diagram_thumbnail_cache_dir(&cache_root);
        fs::create_dir_all(&cache_dir).unwrap();
        let id = "0123456789abcdef01234567";
        let (stable_key, cache_digest) = cache_identity(&source, id, "D", "cetz", "setup").unwrap();
        let (_, size_path) = cache_paths(&cache_dir, &stable_key, &cache_digest);
        write_size_cache(&size_path, 122.0, 68.0).unwrap();

        assert_eq!(
            cached_diagram_dimensions(&cache_root, &source, id, "D", "cetz", "setup"),
            Some((122.0, 68.0))
        );
        assert_eq!(
            cached_diagram_dimensions(&cache_root, &source, "other", "D", "cetz", "setup"),
            None
        );
    }
}
