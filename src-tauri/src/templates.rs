//! Typst Universe project templates and the local template library.
//!
//! Templates are always persisted as `.typsastra` archives (the same
//! multi-directory format the project exporter produces). Downloaded Universe
//! templates and user-supplied templates both live under
//! `<app local data dir>/templates`, each with a JSON sidecar and a thumbnail.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use crate::project_archive::{self, ProjectExport};

pub const REGISTRY_URL: &str = "https://packages.typst.org/preview";
pub const INDEX_URL: &str = "https://packages.typst.org/preview/index.json";
const USER_AGENT: &str = "Typsastra";
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_THUMBNAIL_BYTES: u64 = 8 * 1024 * 1024;

/// A template entry from the Typst Universe package index.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub categories: Vec<String>,
    pub keywords: Vec<String>,
    pub disciplines: Vec<String>,
    pub repository: String,
    pub compiler: String,
    pub updated_at: i64,
    pub template_path: String,
    pub template_entrypoint: String,
    pub thumbnail_url: String,
}

/// A template that exists locally (downloaded Universe or user supplied).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub categories: Vec<String>,
    /// `"universe"` for downloaded templates, `"user"` for user templates.
    pub source: String,
    /// Archive path relative to the templates root.
    pub archive: String,
    /// Thumbnail path relative to the templates root, when one exists.
    pub thumbnail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    pub workspace_path: String,
    pub main_file_path: String,
    pub project_name: String,
}

pub fn templates_root(data_dir: &Path) -> PathBuf {
    data_dir.join("templates")
}

fn user_root(data_dir: &Path) -> PathBuf {
    templates_root(data_dir).join("user")
}

pub fn index_cache_path(data_dir: &Path) -> PathBuf {
    templates_root(data_dir).join("index.json")
}

/// The Universe template catalog plus where it came from.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCatalog {
    pub templates: Vec<TemplateSummary>,
    /// Unix seconds of the last successful fetch, when known.
    pub cached_at: Option<i64>,
    pub from_cache: bool,
    /// True when the network was unreachable and a cached catalog was served.
    pub offline: bool,
}

fn index_meta_path(data_dir: &Path) -> PathBuf {
    templates_root(data_dir).join("index.meta.json")
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn read_cached_at(data_dir: &Path) -> Option<i64> {
    let bytes = fs::read(index_meta_path(data_dir)).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get("fetchedAt").and_then(|value| value.as_i64())
}

fn write_cached_at(data_dir: &Path, fetched_at: i64) {
    let path = index_meta_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, format!("{{\"fetchedAt\":{fetched_at}}}\n"));
}

fn read_cached_templates(cache: &Path) -> Option<Vec<TemplateSummary>> {
    let bytes = fs::read(cache).ok()?;
    let templates = parse_index(&bytes).ok()?;
    if templates.is_empty() {
        None
    } else {
        Some(templates)
    }
}

/// Loads the Universe template index.
///
/// Uses the on-disk cache without touching the network unless `refresh` is set
/// or no cache exists. When the network is unreachable it serves the cached
/// catalog and marks it `offline`; only a cold cache with no network fails.
pub async fn fetch_index(data_dir: &Path, refresh: bool) -> Result<TemplateCatalog, String> {
    let cache = index_cache_path(data_dir);
    let cached_at = read_cached_at(data_dir);
    if !refresh {
        if let Some(templates) = read_cached_templates(&cache) {
            return Ok(TemplateCatalog { templates, cached_at, from_cache: true, offline: false });
        }
    }
    match fetch_bytes(INDEX_URL, MAX_INDEX_BYTES).await {
        Ok(bytes) => {
            let templates = parse_index(&bytes)?;
            if let Some(parent) = cache.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&cache, &bytes);
            let fetched_at = now_unix();
            write_cached_at(data_dir, fetched_at);
            Ok(TemplateCatalog { templates, cached_at: Some(fetched_at), from_cache: false, offline: false })
        }
        Err(error) => {
            if let Some(templates) = read_cached_templates(&cache) {
                return Ok(TemplateCatalog { templates, cached_at, from_cache: true, offline: true });
            }
            Err(error)
        }
    }
}

pub async fn fetch_bytes(url: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("Could not create the download client: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not reach {url}: {error}"))?;
    let response = response
        .error_for_status()
        .map_err(|error| format!("{url} returned an error: {error}"))?;
    if let Some(length) = response.content_length() {
        if length > max_bytes {
            return Err(format!("{url} is larger than the allowed download size."));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not download {url}: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{url} is larger than the allowed download size."));
    }
    Ok(bytes.to_vec())
}

/// Parses the registry index, keeping only template packages and the latest
/// version of each.
pub fn parse_index(bytes: &[u8]) -> Result<Vec<TemplateSummary>, String> {
    let values: Vec<serde_json::Value> = serde_json::from_slice(bytes)
        .map_err(|error| format!("The Typst Universe index is malformed: {error}"))?;
    let mut best: BTreeMap<String, TemplateSummary> = BTreeMap::new();
    for value in &values {
        let Some(template) = value.get("template") else { continue };
        if !template.is_object() {
            continue;
        }
        let name = string_field(value, "name");
        let version = string_field(value, "version");
        if name.is_empty() || version.is_empty() {
            continue;
        }
        let compiler = string_field(value, "compiler");
        let summary = TemplateSummary {
            description: string_field(value, "description"),
            authors: string_array(value, "authors"),
            categories: string_array(value, "categories"),
            keywords: string_array(value, "keywords"),
            disciplines: string_array(value, "disciplines"),
            repository: string_field(value, "repository"),
            compiler: if compiler.is_empty() { "0.13.0".to_string() } else { compiler },
            updated_at: value.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0),
            template_path: string_field(template, "path"),
            template_entrypoint: string_field(template, "entrypoint"),
            thumbnail_url: thumbnail_url(&name, &version),
            name,
            version,
        };
        match best.get(&summary.name) {
            Some(existing) if !version_is_newer(&summary.version, &existing.version) => {}
            _ => {
                best.insert(summary.name.clone(), summary);
            }
        }
    }
    Ok(best.into_values().collect())
}

fn thumbnail_url(name: &str, version: &str) -> String {
    format!("{REGISTRY_URL}/thumbnails/{name}-{version}-small.webp")
}

pub fn package_url(name: &str, version: &str) -> String {
    format!("{REGISTRY_URL}/{name}-{version}.tar.gz")
}

fn string_field(value: &serde_json::Value, key: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn string_array(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    match (semver::Version::parse(candidate), semver::Version::parse(current)) {
        (Ok(candidate), Ok(current)) => candidate > current,
        _ => candidate > current,
    }
}

/// Extracts a `.tar.gz` package into `destination`, rejecting unsafe entries.
pub fn extract_tar_gz(bytes: &[u8], destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not prepare the template workspace: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("The template package is not a valid archive: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("Could not read the template package: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("The template package has an invalid path: {error}"))?
            .to_path_buf();
        if !is_safe_relative(&path) {
            return Err("The template package contains an unsafe path.".to_string());
        }
        entry
            .unpack_in(destination)
            .map_err(|error| format!("Could not extract the template package: {error}"))?;
    }
    Ok(())
}

fn is_safe_relative(path: &Path) -> bool {
    if path.is_absolute() {
        return false;
    }
    path.components().all(|component| match component {
        Component::Normal(_) | Component::CurDir => true,
        _ => false,
    })
}

pub fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create '{}': {error}", destination.display()))?;
    let entries = fs::read_dir(source)
        .map_err(|error| format!("Could not read '{}': {error}", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not read '{}': {error}", source.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect '{}': {error}", entry.path().display()))?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err("Template packages may not contain symbolic links.".to_string());
        }
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target).map_err(|error| {
                format!("Could not copy '{}': {error}", entry.path().display())
            })?;
        }
    }
    Ok(())
}

fn normalize_relative(value: &str) -> Result<String, String> {
    let normalized = value.replace('\\', "/");
    let path = Path::new(&normalized);
    if !is_safe_relative(path) || normalized.is_empty() {
        return Err("The template entry point is not a safe relative path.".to_string());
    }
    Ok(normalized)
}

fn sanitize_component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['.', '-', '_']).to_string();
    if trimmed.is_empty() {
        "template".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn unique_project_id() -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos().to_le_bytes())
            .unwrap_or_default(),
    );
    hasher.update(std::process::id().to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest[..32].to_string()
}

/// Writes the minimal `.typsastra/config.json` and `workspace.json` metadata so
/// a freshly scaffolded directory is a valid Typsastra project.
pub fn write_workspace_scaffold(root: &Path, main_file: &str) -> Result<(), String> {
    let metadata = root.join(".typsastra");
    fs::create_dir_all(&metadata)
        .map_err(|error| format!("Could not create project metadata: {error}"))?;
    let project = serde_json::json!({
        "schemaVersion": 2,
        "projectId": unique_project_id(),
        "mainFile": main_file,
        "recommendedToolchain": null,
        "terminology": [],
        "scriptLanguages": [],
        "tables": [],
    });
    let workspace = serde_json::json!({
        "schemaVersion": 2,
        "activeFile": main_file,
        "openTabs": [{ "path": main_file, "selectionAnchor": 0, "selectionHead": 0 }],
        "expandedDirectories": [],
        "layout": {
            "inputContainerWidthPct": 50,
            "explorerSidebarWidthPx": 250,
            "sidebarVisible": true,
            "activeSidebarTool": "explorer",
        },
        "selectedToolchain": null,
        "previewContentMode": "normal",
        "previewRenderMode": null,
        "previewScrollTop": 0,
    });
    write_json(&metadata.join("config.json"), &project)?;
    write_json(&metadata.join("workspace.json"), &workspace)?;
    Ok(())
}

fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize project metadata: {error}"))?;
    bytes.push(b'\n');
    fs::write(path, bytes).map_err(|error| format!("Could not write '{}': {error}", path.display()))
}

/// Materializes a Universe template package into a cached `.typsastra` archive
/// plus a sidecar and thumbnail.
pub fn store_universe_template(
    data_dir: &Path,
    summary: &TemplateSummary,
    package_bytes: &[u8],
    thumbnail: Option<&[u8]>,
    app_version: &str,
    tinymist_version: &str,
) -> Result<TemplateEntry, String> {
    let root = templates_root(data_dir);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create the template cache: {error}"))?;
    let temp = tempfile::Builder::new()
        .prefix(".typsastra-template-")
        .tempdir_in(&root)
        .map_err(|error| format!("Could not create the template workspace: {error}"))?;
    extract_tar_gz(package_bytes, temp.path())?;

    let template_source = temp.path().join(normalize_relative(&summary.template_path)?);
    if !template_source.is_dir() {
        return Err("The template package does not contain its template directory.".to_string());
    }
    let workspace = temp.path().join(sanitize_component(&summary.name));
    copy_dir_recursive(&template_source, &workspace)?;
    let main_relative = normalize_relative(&summary.template_entrypoint)?;
    let main_path = workspace.join(&main_relative);
    if !main_path.is_file() {
        return Err("The template package does not contain its entry point.".to_string());
    }
    write_workspace_scaffold(&workspace, &main_relative)?;

    let archive_name = format!("{}-{}.typsastra", summary.name, summary.version);
    let archive_absolute = root.join(&archive_name);
    if archive_absolute.exists() {
        fs::remove_file(&archive_absolute)
            .map_err(|error| format!("Could not replace the cached template: {error}"))?;
    }
    project_archive::export_typsastra_project(ProjectExport {
        workspace_root: &workspace,
        archive_path: &archive_absolute,
        main_file_path: &main_path,
        app_version,
        typst_version: &summary.compiler,
        tinymist_version,
    })?;

    let mut thumbnail_name = None;
    if let Some(bytes) = thumbnail {
        let name = format!("{}-{}.webp", summary.name, summary.version);
        if fs::write(root.join(&name), bytes).is_ok() {
            thumbnail_name = Some(name);
        }
    }

    let entry = TemplateEntry {
        id: format!("{}-{}", summary.name, summary.version),
        name: summary.name.clone(),
        version: summary.version.clone(),
        description: summary.description.clone(),
        authors: summary.authors.clone(),
        categories: summary.categories.clone(),
        source: "universe".to_string(),
        archive: archive_name,
        thumbnail: thumbnail_name,
    };
    write_sidecar(&root, &entry)?;
    Ok(entry)
}

fn sidecar_path(root: &Path, entry: &TemplateEntry) -> PathBuf {
    if entry.source == "user" {
        root.join("user").join(format!("{}.json", entry.id))
    } else {
        root.join(format!("{}.json", entry.id))
    }
}

fn write_sidecar(root: &Path, entry: &TemplateEntry) -> Result<(), String> {
    let path = sidecar_path(root, entry);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the template cache: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(entry)
        .map_err(|error| format!("Could not serialize the template metadata: {error}"))?;
    fs::write(&path, bytes).map_err(|error| format!("Could not write '{}': {error}", path.display()))
}

pub fn list_templates(data_dir: &Path, source: &str) -> Result<Vec<TemplateEntry>, String> {
    let root = templates_root(data_dir);
    let directory = if source == "user" { user_root(data_dir) } else { root.clone() };
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(&directory)
        .map_err(|error| format!("Could not read the template cache: {error}"))?
    {
        let item = item.map_err(|error| format!("Could not read the template cache: {error}"))?;
        let path = item.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(entry) = serde_json::from_slice::<TemplateEntry>(&bytes) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

pub fn remove_template(data_dir: &Path, source: &str, id: &str) -> Result<(), String> {
    let root = templates_root(data_dir);
    let directory = if source == "user" { user_root(data_dir) } else { root.clone() };
    let sidecar = directory.join(format!("{id}.json"));
    let bytes = fs::read(&sidecar)
        .map_err(|error| format!("The template '{id}' was not found: {error}"))?;
    let entry: TemplateEntry = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The template '{id}' metadata is unreadable: {error}"))?;
    let _ = fs::remove_file(&sidecar);
    let _ = fs::remove_file(root.join(&entry.archive));
    if let Some(thumbnail) = &entry.thumbnail {
        let _ = fs::remove_file(root.join(thumbnail));
    }
    Ok(())
}

pub fn template_archive_path(data_dir: &Path, source: &str, id: &str) -> Result<PathBuf, String> {
    let root = templates_root(data_dir);
    let directory = if source == "user" { user_root(data_dir) } else { root.clone() };
    let sidecar = directory.join(format!("{id}.json"));
    let bytes = fs::read(&sidecar)
        .map_err(|error| format!("The template '{id}' was not found: {error}"))?;
    let entry: TemplateEntry = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The template '{id}' metadata is unreadable: {error}"))?;
    Ok(root.join(entry.archive))
}

pub fn thumbnail_data_url(data_dir: &Path, source: &str, id: &str) -> Result<Option<String>, String> {
    let root = templates_root(data_dir);
    let directory = if source == "user" { user_root(data_dir) } else { root.clone() };
    let sidecar = directory.join(format!("{id}.json"));
    let Ok(bytes) = fs::read(&sidecar) else { return Ok(None) };
    let Ok(entry) = serde_json::from_slice::<TemplateEntry>(&bytes) else { return Ok(None) };
    let Some(thumbnail) = entry.thumbnail else { return Ok(None) };
    let path = root.join(&thumbnail);
    let Ok(bytes) = fs::read(&path) else { return Ok(None) };
    let mime = match path.extension().and_then(|value| value.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "image/webp",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(format!("data:{mime};base64,{encoded}")))
}

/// Registers a user-supplied `.typsastra` as a reusable template.
pub fn store_user_template(
    data_dir: &Path,
    project_name: &str,
    description: &str,
    archive_bytes: &[u8],
    thumbnail: Option<(&str, &[u8])>,
) -> Result<TemplateEntry, String> {
    let root = templates_root(data_dir);
    let directory = user_root(data_dir);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the template library: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(archive_bytes);
    let digest = format!("{:x}", hasher.finalize());
    let id = format!("{}-{}", sanitize_component(project_name), &digest[..12]);
    let archive_name = format!("user/{id}.typsastra");
    fs::write(root.join(&archive_name), archive_bytes)
        .map_err(|error| format!("Could not store the template: {error}"))?;
    let mut thumbnail_name = None;
    if let Some((extension, bytes)) = thumbnail {
        let name = format!("user/{id}.{extension}");
        if fs::write(root.join(&name), bytes).is_ok() {
            thumbnail_name = Some(name);
        }
    }
    let entry = TemplateEntry {
        id,
        name: project_name.to_string(),
        version: String::new(),
        description: description.to_string(),
        authors: Vec::new(),
        categories: Vec::new(),
        source: "user".to_string(),
        archive: archive_name,
        thumbnail: thumbnail_name,
    };
    write_sidecar(&root, &entry)?;
    Ok(entry)
}

pub fn create_blank_project(
    parent_path: &Path,
    project_name: &str,
) -> Result<CreatedProject, String> {
    let destination = project_archive::validate_import_destination(parent_path, project_name)?;
    fs::create_dir_all(&destination)
        .map_err(|error| format!("Could not create the project folder: {error}"))?;
    let main_file = "main.typ";
    fs::write(destination.join(main_file), b"= Untitled\n")
        .map_err(|error| format!("Could not create the main file: {error}"))?;
    write_workspace_scaffold(&destination, main_file)?;
    Ok(CreatedProject {
        workspace_path: destination.to_string_lossy().to_string(),
        main_file_path: destination.join(main_file).to_string_lossy().to_string(),
        project_name: project_name.to_string(),
    })
}

pub fn created_from_import(
    imported: project_archive::ImportedProject,
    project_name: &str,
) -> CreatedProject {
    CreatedProject {
        workspace_path: imported.workspace_path,
        main_file_path: imported.main_file_path,
        project_name: project_name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_bytes() -> Vec<u8> {
        serde_json::json!([
            { "name": "alpha", "version": "0.1.0", "description": "A", "authors": ["X"],
              "categories": ["paper"], "template": { "path": "template", "entrypoint": "main.typ" } },
            { "name": "alpha", "version": "0.2.0", "description": "A2", "authors": [],
              "categories": [], "template": { "path": "template", "entrypoint": "main.typ" } },
            { "name": "beta", "version": "1.0.0", "description": "B", "authors": [],
              "categories": [] },
        ])
        .to_string()
        .into_bytes()
    }

    #[test]
    fn parse_index_keeps_only_templates_and_latest_version() {
        let summaries = parse_index(&index_bytes()).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].name, "alpha");
        assert_eq!(summaries[0].version, "0.2.0");
        assert_eq!(summaries[0].template_path, "template");
        assert_eq!(summaries[0].template_entrypoint, "main.typ");
        assert!(summaries[0].thumbnail_url.ends_with("alpha-0.2.0-small.webp"));
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        assert!(is_safe_relative(Path::new("template/main.typ")));
        assert!(!is_safe_relative(Path::new("../escape")));
        assert!(!is_safe_relative(Path::new("/absolute")));
    }

    #[test]
    fn writes_a_scaffold_that_normalizes() {
        let directory = tempfile::tempdir().unwrap();
        write_workspace_scaffold(directory.path(), "main.typ").unwrap();
        let config = directory.path().join(".typsastra/config.json");
        assert!(config.is_file());
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert_eq!(value["schemaVersion"], 2);
        assert_eq!(value["mainFile"], "main.typ");
    }

    #[test]
    fn creates_a_blank_project_directory() {
        let parent = tempfile::tempdir().unwrap();
        let created = create_blank_project(parent.path(), "My Project").unwrap();
        assert!(Path::new(&created.main_file_path).is_file());
        assert!(Path::new(&created.workspace_path).join(".typsastra/config.json").is_file());
    }
}
