use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use super::draft::{
    prepare_draft_images, DraftImageAsset, DraftImageDiagnostic, DraftPreparation,
    PreviewContentMode,
};
use super::sourcemap::{MappingKind, SourceMap, SOURCE_MAP_VERSION};

const RENDER_CACHE_LAYOUT_VERSION: &str = "4-original-source-render";
const RENDER_CACHE_OWNER_SCHEMA_VERSION: u32 = 1;
const RENDER_CACHE_OWNER_FILE: &str = "workspace-owner.json";
const DRAFT_PREPARATION_CACHE_VERSION: u32 = 2;
const RENDER_CACHE_STORAGE_REPORT_VERSION: u32 = 1;
const RENDER_CACHE_STORAGE_REPORT_FILE: &str = "render-storage.json";
const LARGE_COPY_FALLBACK_THRESHOLD_BYTES: u64 = 64 * 1024 * 1024;
const LARGE_COPY_FALLBACK_ERROR_PREFIX: &str = "TYPSASTRA_LARGE_ASSET_COPY_FALLBACK:";

pub fn workspace_render_cache_root(app_local_data_dir: &Path, project_root: &Path) -> PathBuf {
    let canonical = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());
    let mut identity = canonical.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        identity.make_ascii_lowercase();
    }
    let digest = Sha256::digest(identity.as_bytes());
    let workspace_key = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    app_local_data_dir
        .join("workspace-cache")
        .join(workspace_key)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheStorageReport {
    pub version: u32,
    pub project_root: PathBuf,
    pub cache_root: PathBuf,
    pub recorded_at_ms: u64,
    pub hard_linked_bytes: u64,
    pub copied_bytes: u64,
    pub hard_linked_files: usize,
    pub copied_files: usize,
}

/// A machine-local render cache belonging to one project. The cache path is
/// intentionally separate from the project's cloud-synced source directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRenderCacheStorageEntry {
    pub project_root: Option<PathBuf>,
    pub cache_root: PathBuf,
    pub total_bytes: u64,
    pub file_count: usize,
    pub recorded_at_ms: u64,
    pub hard_linked_bytes: u64,
    pub copied_bytes: u64,
    pub hard_linked_files: usize,
    pub copied_files: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssetStorageKind {
    HardLinked,
    Copied,
}

#[derive(Debug, Clone, Copy)]
struct AssetSyncResult {
    changed: bool,
    bytes: u64,
    kind: AssetStorageKind,
}

#[derive(Debug)]
struct PendingAssetCopy {
    source: PathBuf,
    destination: PathBuf,
    bytes: u64,
}

enum AssetSyncOutcome {
    Ready(AssetSyncResult),
    CopyRequired(PendingAssetCopy),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LargeCopyFallbackNotice {
    bytes: u64,
    files: usize,
    threshold_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RenderCacheOwner {
    schema_version: u32,
    workspace_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DraftDependencyStamp {
    path: PathBuf,
    length: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftPreparationCache {
    version: u32,
    source_digest: String,
    dependencies: Vec<DraftDependencyStamp>,
    prepared_text: String,
    source_map: SourceMap,
    assets: Vec<DraftImageAsset>,
    diagnostics: Vec<DraftImageDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPrepareWarning {
    pub file_path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPrepareOptions {
    pub project_root: PathBuf,
    pub entry_file: PathBuf,
    pub cache_root: PathBuf,
    pub generate_source_map: bool,
    #[serde(default)]
    pub preview_content_mode: PreviewContentMode,
    #[serde(default)]
    pub allow_large_copy_fallback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPrepareResult {
    pub generated_entry_file: PathBuf,
    pub changed_files: Vec<PathBuf>,
    pub warnings: Vec<RenderPrepareWarning>,
    pub draft_assets: Vec<DraftImageAsset>,
    pub draft_diagnostics: Vec<DraftImageDiagnostic>,
    pub draft_cache_hits: usize,
    pub draft_reachable_files: Vec<PathBuf>,
    pub storage: RenderCacheStorageReport,
    pub timings: RenderPrepareTimings,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderPrepareTimings {
    pub total_ms: f64,
    pub setup_ms: f64,
    pub cleanup_ms: f64,
    pub discovery_ms: f64,
    pub typ_processing_ms: f64,
    pub asset_sync_ms: f64,
    pub discovered_files: usize,
    pub typ_files: usize,
    pub asset_files: usize,
}

pub fn mirror_project_cancellable(
    options: &RenderPrepareOptions,
    is_cancelled: impl Fn() -> bool,
) -> Result<RenderPrepareResult, String> {
    let total_started_at = Instant::now();
    let project_root = &options.project_root;
    let cache_root = &options.cache_root;

    validate_workspace_dependency_boundary(project_root, &options.entry_file)?;

    let setup_started_at = Instant::now();
    ensure_render_cache_owner(project_root, cache_root).map_err(|error| error.to_string())?;
    let render_dir = cache_root.join("render");
    let maps_dir = cache_root.join("maps");
    let preview_dir = cache_root.join("preview");

    migrate_render_cache_layout(cache_root, &render_dir, &maps_dir, &preview_dir)
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&render_dir).map_err(|e| e.to_string())?;
    if options.generate_source_map {
        fs::create_dir_all(&maps_dir).map_err(|e| e.to_string())?;
    }
    let setup_ms = setup_started_at.elapsed().as_secs_f64() * 1_000.0;

    let cleanup_started_at = Instant::now();
    let _ = clean_stale_cache_files(&render_dir, &maps_dir, project_root);
    let cleanup_ms = cleanup_started_at.elapsed().as_secs_f64() * 1_000.0;

    let mut changed_files = Vec::new();
    let mut warnings = Vec::new();
    let mut draft_assets = Vec::new();
    let mut draft_diagnostics = Vec::new();
    let mut draft_cache_hits = 0usize;
    let mut typ_processing_ms = 0.0;
    let mut asset_sync_ms = 0.0;
    let mut typ_files = 0usize;
    let mut asset_files = 0usize;
    let mut storage = RenderCacheStorageReport {
        version: RENDER_CACHE_STORAGE_REPORT_VERSION,
        project_root: project_root.clone(),
        cache_root: cache_root.clone(),
        recorded_at_ms: 0,
        ..RenderCacheStorageReport::default()
    };
    let mut pending_asset_copies = Vec::new();

    let discovery_started_at = Instant::now();
    let mut files_to_process = Vec::new();
    walk_project_dir(
        project_root,
        project_root,
        cache_root,
        &mut files_to_process,
    )
    .map_err(|e| e.to_string())?;

    if options.entry_file.exists() && options.entry_file.is_file() {
        if let Ok(rel_path) = options.entry_file.strip_prefix(project_root) {
            let rel_path_buf = rel_path.to_path_buf();
            if !files_to_process.iter().any(|(p, _)| p == &rel_path_buf) {
                files_to_process.push((rel_path_buf, false));
            }
        }
    }
    let discovery_ms = discovery_started_at.elapsed().as_secs_f64() * 1_000.0;
    let discovered_files = files_to_process.len();
    let draft_reachable_files = collect_reachable_typst_files(project_root, &options.entry_file);

    for (rel_path, is_dir) in files_to_process {
        if is_cancelled() {
            return Err("Render preparation cancelled.".to_string());
        }
        let src_path = project_root.join(&rel_path);
        let dest_path = render_dir.join(&rel_path);

        if is_dir {
            fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            if rel_path.extension().and_then(|s| s.to_str()) == Some("typ") {
                typ_files += 1;
                let typ_started_at = Instant::now();
                let result = process_typ_file(&src_path, &dest_path, &rel_path, &maps_dir, options);
                typ_processing_ms += typ_started_at.elapsed().as_secs_f64() * 1_000.0;
                match result {
                    Ok(processed) => {
                        if processed.changed {
                            changed_files.push(dest_path.clone());
                        }
                        if processed.draft_cache_hit {
                            draft_cache_hits += 1;
                        }
                        let contributes_to_draft = options.preview_content_mode
                            != PreviewContentMode::Draft
                            || draft_reachable_files.contains(&canonical_or_original(&src_path));
                        if contributes_to_draft {
                            merge_draft_assets(&mut draft_assets, processed.draft.assets);
                            draft_diagnostics.extend(processed.draft.diagnostics);
                        }
                    }
                    Err(e) => {
                        warnings.push(RenderPrepareWarning {
                            file_path: src_path.clone(),
                            message: format!("Failed to process Typst file: {}", e),
                        });
                        if let Err(err) = fs::copy(&src_path, &dest_path) {
                            warnings.push(RenderPrepareWarning {
                                file_path: src_path.clone(),
                                message: format!("Fallback copy failed: {}", err),
                            });
                        }
                    }
                }
            } else {
                asset_files += 1;
                let asset_started_at = Instant::now();
                match prepare_asset_in_cache(&src_path, &dest_path) {
                    Ok(AssetSyncOutcome::Ready(result)) => {
                        if result.changed {
                            changed_files.push(dest_path);
                        }
                        match result.kind {
                            AssetStorageKind::HardLinked => {
                                storage.hard_linked_files += 1;
                                storage.hard_linked_bytes =
                                    storage.hard_linked_bytes.saturating_add(result.bytes);
                            }
                            AssetStorageKind::Copied => {
                                storage.copied_files += 1;
                                storage.copied_bytes =
                                    storage.copied_bytes.saturating_add(result.bytes);
                            }
                        }
                    }
                    Ok(AssetSyncOutcome::CopyRequired(pending)) => {
                        pending_asset_copies.push(pending);
                    }
                    Err(err) => {
                        warnings.push(RenderPrepareWarning {
                            file_path: src_path.clone(),
                            message: format!("Failed to copy asset into render cache: {}", err),
                        });
                    }
                }
                asset_sync_ms += asset_started_at.elapsed().as_secs_f64() * 1_000.0;
            }
        }
    }
    if let Some(notice) =
        large_copy_fallback_notice(&pending_asset_copies, options.allow_large_copy_fallback)
    {
        let payload = serde_json::to_string(&notice).map_err(|error| error.to_string())?;
        return Err(format!("{LARGE_COPY_FALLBACK_ERROR_PREFIX}{payload}"));
    }
    for pending in pending_asset_copies {
        if let Some(parent) = pending.destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&pending.source, &pending.destination).map_err(|error| {
            format!(
                "Failed to copy {} into the render cache: {error}",
                pending.source.display()
            )
        })?;
        changed_files.push(pending.destination);
        storage.copied_files += 1;
        storage.copied_bytes = storage.copied_bytes.saturating_add(pending.bytes);
    }

    let generated_entry_file = render_dir.join(
        options
            .entry_file
            .strip_prefix(project_root)
            .unwrap_or(&options.entry_file),
    );
    let mut draft_reachable_files = draft_reachable_files.into_iter().collect::<Vec<_>>();
    draft_reachable_files.sort();
    storage.recorded_at_ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    write_render_cache_storage_report(cache_root, &storage)?;

    Ok(RenderPrepareResult {
        generated_entry_file,
        changed_files,
        warnings,
        draft_assets,
        draft_diagnostics,
        draft_cache_hits,
        draft_reachable_files,
        storage,
        timings: RenderPrepareTimings {
            total_ms: total_started_at.elapsed().as_secs_f64() * 1_000.0,
            setup_ms,
            cleanup_ms,
            discovery_ms,
            typ_processing_ms,
            asset_sync_ms,
            discovered_files,
            typ_files,
            asset_files,
        },
    })
}

fn canonical_or_original(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn normalized_dependency_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = dunce::canonicalize(path) {
        return canonical;
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn outside_workspace_dependency_error(
    project_root: &Path,
    source_path: &Path,
    dependency_path: &Path,
) -> String {
    let source = source_path
        .strip_prefix(project_root)
        .unwrap_or(source_path)
        .display();
    format!(
        "A Typst dependency is outside the current workspace.\n\n\
Source: {source}\n\
Referenced file: {}\n\n\
Typsastra keeps project files inside one workspace for reliable preview, synchronization, and export. \
Open the nearest common parent folder as the workspace, then set the main file again.",
        dependency_path.display()
    )
}

fn validate_source_dependency_boundary(
    project_root: &Path,
    source_path: &Path,
    source: &str,
) -> Result<Vec<PathBuf>, String> {
    let project_root = normalized_dependency_path(project_root);
    let parent = source_path.parent().unwrap_or(project_root.as_path());
    let dependencies = crate::local_typst_dependencies(source, parent);
    let mut normalized_dependencies = Vec::with_capacity(dependencies.len());
    for dependency in dependencies {
        let dependency = normalized_dependency_path(&dependency);
        if !dependency.starts_with(&project_root) {
            return Err(outside_workspace_dependency_error(
                &project_root,
                source_path,
                &dependency,
            ));
        }
        normalized_dependencies.push(dependency);
    }
    Ok(normalized_dependencies)
}

fn validate_workspace_dependency_boundary(
    project_root: &Path,
    entry_file: &Path,
) -> Result<(), String> {
    let project_root = normalized_dependency_path(project_root);
    let entry_file = normalized_dependency_path(entry_file);
    let mut visited = HashSet::new();
    let mut pending = VecDeque::from([entry_file]);

    while let Some(source_path) = pending.pop_front() {
        if !source_path.starts_with(&project_root) {
            return Err(outside_workspace_dependency_error(
                &project_root,
                &source_path,
                &source_path,
            ));
        }
        if !visited.insert(source_path.clone()) {
            continue;
        }
        let Ok(source) = fs::read_to_string(&source_path) else {
            continue;
        };
        pending.extend(validate_source_dependency_boundary(
            &project_root,
            &source_path,
            &source,
        )?);
    }

    Ok(())
}

fn collect_reachable_typst_files(project_root: &Path, entry_file: &Path) -> HashSet<PathBuf> {
    let project_root = canonical_or_original(project_root);
    let entry_file = canonical_or_original(entry_file);
    let mut reachable = HashSet::new();
    let mut pending = VecDeque::from([entry_file]);
    while let Some(source_path) = pending.pop_front() {
        if source_path
            .extension()
            .and_then(|extension| extension.to_str())
            != Some("typ")
            || !source_path.starts_with(&project_root)
            || !reachable.insert(source_path.clone())
        {
            continue;
        }
        let Ok(source) = fs::read_to_string(&source_path) else {
            continue;
        };
        let parent = source_path.parent().unwrap_or(&project_root);
        for dependency in crate::local_typst_dependencies(&source, parent) {
            let dependency = canonical_or_original(&dependency);
            if dependency.starts_with(&project_root)
                && dependency
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("typ")
                && !reachable.contains(&dependency)
            {
                pending.push_back(dependency);
            }
        }
    }
    reachable
}

fn normalized_workspace_identity(project_root: &Path) -> String {
    let resolved = fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
    let identity = resolved.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        identity.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        identity
    }
}

fn expected_render_cache_owner(project_root: &Path) -> RenderCacheOwner {
    RenderCacheOwner {
        schema_version: RENDER_CACHE_OWNER_SCHEMA_VERSION,
        workspace_root: normalized_workspace_identity(project_root),
    }
}

fn read_render_cache_owner(cache_root: &Path) -> Option<RenderCacheOwner> {
    let bytes = fs::read(cache_root.join(RENDER_CACHE_OWNER_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn remove_render_cache(cache_root: &Path) -> Result<(), std::io::Error> {
    let Ok(metadata) = fs::symlink_metadata(cache_root) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() {
        fs::remove_file(cache_root).or_else(|_| fs::remove_dir(cache_root))
    } else {
        fs::remove_dir_all(cache_root)
    }
}

fn write_render_cache_owner(project_root: &Path, cache_root: &Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(cache_root)?;
    let owner = expected_render_cache_owner(project_root);
    let bytes = serde_json::to_vec_pretty(&owner).map_err(std::io::Error::other)?;
    fs::write(cache_root.join(RENDER_CACHE_OWNER_FILE), bytes)
}

/// Invalidates a copied or moved workspace cache before any compiler process
/// can observe hard links or generated sources owned by the former location.
/// A missing cache remains missing until preview preparation is requested.
pub fn validate_existing_render_cache_owner(
    project_root: &Path,
    cache_root: &Path,
) -> Result<bool, std::io::Error> {
    if !cache_root.exists() {
        return Ok(false);
    }
    if read_render_cache_owner(cache_root).as_ref()
        == Some(&expected_render_cache_owner(project_root))
    {
        return Ok(false);
    }
    remove_render_cache(cache_root)?;
    Ok(true)
}

fn ensure_render_cache_owner(project_root: &Path, cache_root: &Path) -> Result<(), std::io::Error> {
    let invalidated = validate_existing_render_cache_owner(project_root, cache_root)?;
    if invalidated || !cache_root.exists() {
        write_render_cache_owner(project_root, cache_root)?;
    }
    Ok(())
}

fn migrate_render_cache_layout(
    cache_root: &Path,
    render_dir: &Path,
    maps_dir: &Path,
    preview_dir: &Path,
) -> Result<(), std::io::Error> {
    fs::create_dir_all(cache_root)?;
    let marker = cache_root.join("render-layout-version");
    if fs::read_to_string(&marker)
        .ok()
        .is_some_and(|version| version.trim() == RENDER_CACHE_LAYOUT_VERSION)
    {
        return Ok(());
    }

    if render_dir.exists() {
        fs::remove_dir_all(render_dir)?;
    }
    if maps_dir.exists() {
        fs::remove_dir_all(maps_dir)?;
    }
    if preview_dir.exists() {
        fs::remove_dir_all(preview_dir)?;
    }
    fs::write(marker, format!("{RENDER_CACHE_LAYOUT_VERSION}\n"))
}

fn clean_stale_cache_files(
    render_dir: &Path,
    maps_dir: &Path,
    project_root: &Path,
) -> Result<(), std::io::Error> {
    if !render_dir.exists() {
        return Ok(());
    }
    let mut to_delete = Vec::new();
    walk_for_stale(render_dir, render_dir, project_root, &mut to_delete)?;
    for path in to_delete {
        if path.is_dir() {
            let rel = path.strip_prefix(render_dir).unwrap_or(&path);
            let _ = fs::remove_dir_all(&path);
            let stale_maps_dir = maps_dir.join(rel);
            if stale_maps_dir.exists() {
                let _ = fs::remove_dir_all(stale_maps_dir);
            }
        } else {
            let _ = fs::remove_file(&path);
            let rel = path.strip_prefix(render_dir).unwrap_or(&path);
            for metadata_path in [
                derived_metadata_path(maps_dir, rel, "map"),
                draft_cache_path(maps_dir, rel),
            ] {
                if metadata_path.exists() {
                    let _ = fs::remove_file(metadata_path);
                }
            }
        }
    }
    Ok(())
}

fn walk_for_stale(
    base_render: &Path,
    dir: &Path,
    project_root: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), std::io::Error> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let rel = path.strip_prefix(base_render).unwrap_or(&path);
        let src_path = project_root.join(rel);

        if !src_path.exists() {
            out.push(path);
        } else if path.is_dir() {
            walk_for_stale(base_render, &path, project_root, out)?;
        }
    }
    Ok(())
}

pub fn prepare_single_in_memory_file(
    options: &RenderPrepareOptions,
    file_path: &Path,
    source_code: &str,
) -> Result<PreparedInMemoryFile, String> {
    let project_root = &options.project_root;
    let cache_root = &options.cache_root;

    validate_source_dependency_boundary(project_root, file_path, source_code)?;

    ensure_render_cache_owner(project_root, cache_root).map_err(|error| error.to_string())?;
    let render_dir = cache_root.join("render");
    let maps_dir = cache_root.join("maps");

    let rel_path = file_path.strip_prefix(project_root).unwrap_or(file_path);
    let dest_path = render_dir.join(rel_path);

    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if options.preview_content_mode == PreviewContentMode::Draft {
        if let Some(cached) =
            read_current_draft_cache(&draft_cache_path(&maps_dir, rel_path), source_code)
        {
            restore_cached_draft_artifact(
                &dest_path,
                &derived_metadata_path(&maps_dir, rel_path, "map"),
                &cached,
                options.generate_source_map,
            )?;
            return Ok(PreparedInMemoryFile {
                path: dest_path,
                prepared_text: cached.prepared_text,
                draft: DraftPreparation {
                    replacements: Vec::new(),
                    assets: cached.assets,
                    diagnostics: cached.diagnostics,
                },
                draft_cache_hit: true,
            });
        }
    }

    let mut sourcemap = SourceMap::new(
        file_path.to_string_lossy().to_string(),
        dest_path.to_string_lossy().to_string(),
    );
    sourcemap.source_digest = source_digest(source_code);
    sourcemap.preview_content_mode = content_mode_key(options.preview_content_mode).into();
    let draft = draft_preparation(options, file_path, &dest_path, source_code);
    let generated_content = prepare_source_content(source_code, &draft, &mut sourcemap);

    fs::write(&dest_path, &generated_content).map_err(|e| e.to_string())?;

    if options.generate_source_map {
        let map_path = derived_metadata_path(&maps_dir, rel_path, "map");
        if let Some(parent) = map_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let map_json = serde_json::to_string_pretty(&sourcemap).map_err(|e| e.to_string())?;
        fs::write(map_path, map_json).map_err(|e| e.to_string())?;
    }
    if options.preview_content_mode == PreviewContentMode::Draft {
        write_draft_cache(
            &draft_cache_path(&maps_dir, rel_path),
            source_code,
            &generated_content,
            &sourcemap,
            &draft,
        )?;
    }

    Ok(PreparedInMemoryFile {
        path: dest_path,
        prepared_text: generated_content,
        draft,
        draft_cache_hit: false,
    })
}

#[derive(Debug)]
pub struct PreparedInMemoryFile {
    pub path: PathBuf,
    pub prepared_text: String,
    pub draft: DraftPreparation,
    pub draft_cache_hit: bool,
}

fn walk_project_dir(
    root: &Path,
    dir: &Path,
    cache_root: &Path,
    out: &mut Vec<(PathBuf, bool)>,
) -> Result<(), std::io::Error> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.starts_with(cache_root) || path == cache_root {
            continue;
        }

        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if file_name.starts_with('.')
            || file_name == "node_modules"
            || file_name == "target"
            || file_name == "dist"
        {
            continue;
        }

        let rel_path = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        let is_dir = path.is_dir();
        out.push((rel_path.clone(), is_dir));

        if is_dir {
            walk_project_dir(root, &path, cache_root, out)?;
        }
    }
    Ok(())
}

fn prepare_asset_in_cache(src: &Path, dest: &Path) -> Result<AssetSyncOutcome, std::io::Error> {
    // Cache artifacts must remain regular files. A symbolic link back into the
    // workspace can make Explorer and backup/copy tools follow the link while
    // duplicating a project, causing the operation to hang or recurse.
    //
    // A hard link has ordinary file semantics but shares the source file's
    // storage allocation. Since the cache lives inside the workspace it will
    // normally be on the same filesystem, so large unused asset collections do
    // not consume their size twice. Filesystems that reject hard links retain
    // the portable copy fallback.
    if let Ok(meta) = fs::symlink_metadata(dest) {
        if meta.is_dir() {
            fs::remove_dir_all(dest)?;
        } else if meta.file_type().is_symlink() {
            fs::remove_file(dest)?;
        } else if let (Ok(src_meta), Ok(dest_meta)) = (fs::metadata(src), fs::metadata(dest)) {
            if src_meta.len() == dest_meta.len() {
                if let (Ok(src_modified), Ok(dest_modified)) =
                    (src_meta.modified(), dest_meta.modified())
                {
                    if src_modified <= dest_modified {
                        return Ok(AssetSyncOutcome::Ready(AssetSyncResult {
                            changed: false,
                            bytes: src_meta.len(),
                            kind: if same_file::is_same_file(src, dest).unwrap_or(false) {
                                AssetStorageKind::HardLinked
                            } else {
                                AssetStorageKind::Copied
                            },
                        }));
                    }
                }
            }
            fs::remove_file(dest)?;
        }
    }

    let source_is_symlink = fs::symlink_metadata(src)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false);
    let bytes = fs::metadata(src)?.len();
    if source_is_symlink || fs::hard_link(src, dest).is_err() {
        return Ok(AssetSyncOutcome::CopyRequired(PendingAssetCopy {
            source: src.to_path_buf(),
            destination: dest.to_path_buf(),
            bytes,
        }));
    }
    Ok(AssetSyncOutcome::Ready(AssetSyncResult {
        changed: true,
        bytes,
        kind: AssetStorageKind::HardLinked,
    }))
}

fn large_copy_fallback_notice(
    pending: &[PendingAssetCopy],
    approved: bool,
) -> Option<LargeCopyFallbackNotice> {
    let bytes = pending
        .iter()
        .fold(0u64, |total, asset| total.saturating_add(asset.bytes));
    (bytes > LARGE_COPY_FALLBACK_THRESHOLD_BYTES && !approved).then_some(LargeCopyFallbackNotice {
        bytes,
        files: pending.len(),
        threshold_bytes: LARGE_COPY_FALLBACK_THRESHOLD_BYTES,
    })
}

fn render_cache_storage_report_path(cache_root: &Path) -> PathBuf {
    cache_root.join(RENDER_CACHE_STORAGE_REPORT_FILE)
}

fn write_render_cache_storage_report(
    cache_root: &Path,
    report: &RenderCacheStorageReport,
) -> Result<(), String> {
    let path = render_cache_storage_report_path(cache_root);
    let staged = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(report).map_err(|error| error.to_string())?;
    fs::write(&staged, bytes).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(staged, path).map_err(|error| error.to_string())
}

pub fn inspect_render_cache_storage(cache_root: &Path) -> RenderCacheStorageReport {
    let path = render_cache_storage_report_path(cache_root);
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RenderCacheStorageReport>(&bytes).ok())
        .filter(|report| report.version == RENDER_CACHE_STORAGE_REPORT_VERSION)
        .unwrap_or_else(|| RenderCacheStorageReport {
            version: RENDER_CACHE_STORAGE_REPORT_VERSION,
            cache_root: cache_root.to_path_buf(),
            ..RenderCacheStorageReport::default()
        })
}

pub fn inspect_workspace_render_caches(
    app_local_data_dir: &Path,
) -> Vec<WorkspaceRenderCacheStorageEntry> {
    let root = app_local_data_dir.join("workspace-cache");
    let mut entries = fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let cache_root = entry.path();
            if !cache_root.is_dir() {
                return None;
            }
            let report = inspect_render_cache_storage(&cache_root);
            let project_root = if report.project_root.as_os_str().is_empty() {
                read_render_cache_owner(&cache_root)
                    .map(|owner| display_workspace_identity(&owner.workspace_root))
            } else {
                Some(report.project_root)
            };
            let (total_bytes, file_count) = directory_size(&cache_root);
            Some(WorkspaceRenderCacheStorageEntry {
                project_root,
                cache_root,
                total_bytes,
                file_count,
                recorded_at_ms: report.recorded_at_ms,
                hard_linked_bytes: report.hard_linked_bytes,
                copied_bytes: report.copied_bytes,
                hard_linked_files: report.hard_linked_files,
                copied_files: report.copied_files,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .total_bytes
            .cmp(&left.total_bytes)
            .then_with(|| left.cache_root.cmp(&right.cache_root))
    });
    entries
}

fn display_workspace_identity(identity: &str) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(
            identity
                .strip_prefix("//?/")
                .unwrap_or(identity)
                .replace('/', "\\"),
        )
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(identity)
    }
}

fn directory_size(path: &Path) -> (u64, usize) {
    let mut bytes = 0u64;
    let mut files = 0usize;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                bytes = bytes.saturating_add(metadata.len());
                files += 1;
            }
        }
    }
    (bytes, files)
}

struct ProcessedTypFile {
    changed: bool,
    draft: DraftPreparation,
    draft_cache_hit: bool,
}

fn derived_metadata_path(maps_dir: &Path, rel_path: &Path, suffix: &str) -> PathBuf {
    let mut derived = rel_path.to_path_buf();
    let ext = derived
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("typ");
    derived.set_extension(format!("{ext}.{suffix}.json"));
    maps_dir.join(derived)
}

fn draft_cache_path(maps_dir: &Path, rel_path: &Path) -> PathBuf {
    derived_metadata_path(maps_dir, rel_path, "draft")
}

fn source_digest(source: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(source.as_bytes());
    format!("{:x}", digest.finalize())
}

fn dependency_stamp(path: &Path) -> Option<DraftDependencyStamp> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(DraftDependencyStamp {
        path: path.to_path_buf(),
        length: metadata.len(),
        modified_secs: modified.as_secs(),
        modified_nanos: modified.subsec_nanos(),
    })
}

fn draft_cache_from_preparation(
    source: &str,
    prepared_text: &str,
    source_map: &SourceMap,
    draft: &DraftPreparation,
) -> Option<DraftPreparationCache> {
    // Unresolved calls are deliberately rechecked. A missing image may appear
    // without the Typst source changing, so caching that diagnostic could hide
    // a newly valid Draft replacement.
    if !draft.diagnostics.is_empty() {
        return None;
    }
    let mut dependencies = draft
        .assets
        .iter()
        .filter_map(|asset| dependency_stamp(&asset.path))
        .collect::<Vec<_>>();
    if dependencies.len() != draft.assets.len() {
        return None;
    }
    dependencies.sort_by(|left, right| left.path.cmp(&right.path));
    dependencies.dedup_by(|left, right| left.path == right.path);
    Some(DraftPreparationCache {
        version: DRAFT_PREPARATION_CACHE_VERSION,
        source_digest: source_digest(source),
        dependencies,
        prepared_text: prepared_text.to_string(),
        source_map: source_map.clone(),
        assets: draft.assets.clone(),
        diagnostics: draft.diagnostics.clone(),
    })
}

fn read_current_draft_cache(path: &Path, source: &str) -> Option<DraftPreparationCache> {
    let bytes = fs::read(path).ok()?;
    let cached = serde_json::from_slice::<DraftPreparationCache>(&bytes).ok()?;
    if cached.version != DRAFT_PREPARATION_CACHE_VERSION
        || cached.source_digest != source_digest(source)
        || !cached.diagnostics.is_empty()
        || cached
            .dependencies
            .iter()
            .any(|expected| dependency_stamp(&expected.path).as_ref() != Some(expected))
    {
        return None;
    }
    Some(cached)
}

fn write_draft_cache(
    path: &Path,
    source: &str,
    prepared_text: &str,
    source_map: &SourceMap,
    draft: &DraftPreparation,
) -> Result<(), String> {
    let Some(cache) = draft_cache_from_preparation(source, prepared_text, source_map, draft) else {
        let _ = fs::remove_file(path);
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec(&cache).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn restore_cached_draft_artifact(
    dest: &Path,
    map_path: &Path,
    cached: &DraftPreparationCache,
    generate_source_map: bool,
) -> Result<bool, String> {
    let prepared_changed = fs::read_to_string(dest)
        .map(|current| current != cached.prepared_text)
        .unwrap_or(true);
    if prepared_changed {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(dest, &cached.prepared_text).map_err(|error| error.to_string())?;
    }
    if generate_source_map {
        let map_json =
            serde_json::to_string_pretty(&cached.source_map).map_err(|error| error.to_string())?;
        let map_changed = fs::read_to_string(map_path)
            .map(|current| current != map_json)
            .unwrap_or(true);
        if map_changed {
            if let Some(parent) = map_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(map_path, map_json).map_err(|error| error.to_string())?;
        }
    }
    Ok(prepared_changed)
}

fn process_typ_file(
    src: &Path,
    dest: &Path,
    rel_path: &Path,
    maps_dir: &Path,
    options: &RenderPrepareOptions,
) -> Result<ProcessedTypFile, String> {
    let source_content = fs::read_to_string(src).map_err(|e| e.to_string())?;
    let current_source_digest = source_digest(&source_content);
    if options.preview_content_mode == PreviewContentMode::Draft {
        if let Some(cached) =
            read_current_draft_cache(&draft_cache_path(maps_dir, rel_path), &source_content)
        {
            let changed = restore_cached_draft_artifact(
                dest,
                &derived_metadata_path(maps_dir, rel_path, "map"),
                &cached,
                options.generate_source_map,
            )?;
            return Ok(ProcessedTypFile {
                changed,
                draft: DraftPreparation {
                    replacements: Vec::new(),
                    assets: cached.assets,
                    diagnostics: cached.diagnostics,
                },
                draft_cache_hit: true,
            });
        }
    }
    if dest.exists() {
        let map_is_current = if options.generate_source_map {
            fs::read_to_string(derived_metadata_path(maps_dir, rel_path, "map"))
                .ok()
                .and_then(|content| serde_json::from_str::<SourceMap>(&content).ok())
                .is_some_and(|map| {
                    map.version == SOURCE_MAP_VERSION
                        && map.preview_content_mode
                            == content_mode_key(options.preview_content_mode)
                        && Path::new(&map.source_file) == src
                        && Path::new(&map.generated_file) == dest
                        && map.source_digest == current_source_digest
                })
        } else {
            true
        };
        if map_is_current && options.preview_content_mode == PreviewContentMode::Normal {
            if let (Ok(src_meta), Ok(dest_meta)) = (fs::metadata(src), fs::metadata(dest)) {
                if let (Ok(src_mod), Ok(dest_mod)) = (src_meta.modified(), dest_meta.modified()) {
                    if src_mod <= dest_mod {
                        return Ok(ProcessedTypFile {
                            changed: false,
                            draft: DraftPreparation::default(),
                            draft_cache_hit: false,
                        });
                    }
                }
            }
        }
    }

    let mut sourcemap = SourceMap::new(
        src.to_string_lossy().to_string(),
        dest.to_string_lossy().to_string(),
    );

    sourcemap.source_digest = current_source_digest;
    sourcemap.preview_content_mode = content_mode_key(options.preview_content_mode).into();
    let draft = draft_preparation(options, src, dest, &source_content);
    let generated_content = prepare_source_content(&source_content, &draft, &mut sourcemap);

    fs::write(dest, &generated_content).map_err(|e| e.to_string())?;

    if options.generate_source_map {
        let map_path = derived_metadata_path(maps_dir, rel_path, "map");
        if let Some(parent) = map_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let map_json = serde_json::to_string_pretty(&sourcemap).map_err(|e| e.to_string())?;
        fs::write(map_path, map_json).map_err(|e| e.to_string())?;
    }
    if options.preview_content_mode == PreviewContentMode::Draft {
        write_draft_cache(
            &draft_cache_path(maps_dir, rel_path),
            &source_content,
            &generated_content,
            &sourcemap,
            &draft,
        )?;
    }

    Ok(ProcessedTypFile {
        changed: true,
        draft,
        draft_cache_hit: false,
    })
}

fn draft_preparation(
    options: &RenderPrepareOptions,
    source_path: &Path,
    destination_path: &Path,
    source: &str,
) -> DraftPreparation {
    if options.preview_content_mode != PreviewContentMode::Draft {
        return DraftPreparation::default();
    }
    prepare_draft_images(
        &options.project_root,
        source_path,
        destination_path,
        &options.cache_root.join("render"),
        source,
    )
}

fn prepare_source_content(
    source: &str,
    draft: &DraftPreparation,
    sourcemap: &mut SourceMap,
) -> String {
    let mut generated = String::new();
    let mut cursor = 0usize;

    for replacement in &draft.replacements {
        if replacement.start < cursor
            || replacement.start > replacement.end
            || replacement.end > source.len()
        {
            continue;
        }
        append_original(&mut generated, sourcemap, source, cursor, replacement.start);
        let generated_start = generated.len();
        generated.push_str(&replacement.generated);
        sourcemap.add_mapping(
            generated_start,
            generated.len(),
            replacement.start,
            replacement.end,
            MappingKind::GeneratedWrapper,
        );
        cursor = replacement.end;
    }

    append_original(&mut generated, sourcemap, source, cursor, source.len());
    generated
}

fn append_original(
    generated: &mut String,
    sourcemap: &mut SourceMap,
    source: &str,
    start: usize,
    end: usize,
) {
    if start >= end {
        return;
    }
    let generated_start = generated.len();
    generated.push_str(&source[start..end]);
    sourcemap.add_mapping(
        generated_start,
        generated.len(),
        start,
        end,
        MappingKind::Original,
    );
}

fn content_mode_key(mode: PreviewContentMode) -> &'static str {
    match mode {
        PreviewContentMode::Normal => "normal",
        PreviewContentMode::Draft => "draft",
    }
}

fn merge_draft_assets(target: &mut Vec<DraftImageAsset>, assets: Vec<DraftImageAsset>) {
    for asset in assets {
        if let Some(existing) = target.iter_mut().find(|existing| existing.id == asset.id) {
            existing.references.extend(asset.references);
        } else {
            target.push(asset);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_cache_roots_are_stable_and_outside_projects() {
        let app_data = tempfile::tempdir().unwrap();
        let projects = tempfile::tempdir().unwrap();
        let first = projects.path().join("first");
        let second = projects.path().join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();

        let first_cache = workspace_render_cache_root(app_data.path(), &first);
        let repeated = workspace_render_cache_root(app_data.path(), &first);
        let second_cache = workspace_render_cache_root(app_data.path(), &second);

        assert_eq!(first_cache, repeated);
        assert_ne!(first_cache, second_cache);
        assert!(first_cache.starts_with(app_data.path().join("workspace-cache")));
        assert!(!first_cache.starts_with(&first));
    }

    #[test]
    fn workspace_cache_monitor_reports_all_machine_local_projects() {
        let app_data = tempfile::tempdir().unwrap();
        let projects = tempfile::tempdir().unwrap();
        let first_project = projects.path().join("first");
        let second_project = projects.path().join("second");
        fs::create_dir_all(&first_project).unwrap();
        fs::create_dir_all(&second_project).unwrap();
        let first_cache = workspace_render_cache_root(app_data.path(), &first_project);
        let second_cache = workspace_render_cache_root(app_data.path(), &second_project);

        write_render_cache_owner(&first_project, &first_cache).unwrap();
        write_render_cache_owner(&second_project, &second_cache).unwrap();
        write_render_cache_storage_report(
            &first_cache,
            &RenderCacheStorageReport {
                version: RENDER_CACHE_STORAGE_REPORT_VERSION,
                project_root: first_project.clone(),
                cache_root: first_cache.clone(),
                ..RenderCacheStorageReport::default()
            },
        )
        .unwrap();
        write_render_cache_storage_report(
            &second_cache,
            &RenderCacheStorageReport {
                version: RENDER_CACHE_STORAGE_REPORT_VERSION,
                project_root: second_project.clone(),
                cache_root: second_cache.clone(),
                ..RenderCacheStorageReport::default()
            },
        )
        .unwrap();
        fs::write(first_cache.join("first.bin"), vec![0u8; 20]).unwrap();
        fs::write(second_cache.join("second.bin"), vec![0u8; 40]).unwrap();

        let entries = inspect_workspace_render_caches(app_data.path());
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].cache_root, second_cache);
        assert!(entries[0].total_bytes >= 40);
        assert_eq!(
            entries[0].project_root.as_deref(),
            Some(second_project.as_path())
        );
        assert_eq!(entries[1].cache_root, first_cache);
        assert_eq!(
            entries[1].project_root.as_deref(),
            Some(first_project.as_path())
        );
    }

    #[test]
    fn rejects_reachable_typst_dependencies_outside_the_workspace() {
        let parent = tempfile::tempdir().unwrap();
        let workspace = parent.path().join("typst");
        let external = parent.path().join("Author/Folder/SubFolder 1/file1.typ");
        let main = workspace.join("main_file.typ");
        fs::create_dir_all(external.parent().unwrap()).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(&external, "= External chapter").unwrap();
        fs::write(
            &main,
            "#let filelocation = \"../Author/Folder/SubFolder 1/file1.typ\"\n#include filelocation",
        )
        .unwrap();
        let options = RenderPrepareOptions {
            project_root: workspace.clone(),
            entry_file: main,
            cache_root: workspace.join(".typsastra/cache"),
            generate_source_map: true,
            preview_content_mode: PreviewContentMode::Normal,
            allow_large_copy_fallback: false,
        };

        let error = mirror_project_cancellable(&options, || false).unwrap_err();

        assert!(error.contains("outside the current workspace"));
        assert!(error.contains("main_file.typ"));
        assert!(error.contains("file1.typ"));
        assert!(error.contains("Open the nearest common parent folder"));
        assert!(!options.cache_root.exists());
    }

    #[test]
    fn preserves_parent_relative_includes_inside_a_common_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let main = workspace.path().join("typst/main_file.typ");
        let chapter = workspace.path().join("Author/Folder/SubFolder 1/file1.typ");
        let cache_root = workspace.path().join(".typsastra/cache");
        fs::create_dir_all(main.parent().unwrap()).unwrap();
        fs::create_dir_all(chapter.parent().unwrap()).unwrap();
        fs::write(&chapter, "= Chapter").unwrap();
        fs::write(&main, "#include \"../Author/Folder/SubFolder 1/file1.typ\"").unwrap();
        let options = RenderPrepareOptions {
            project_root: workspace.path().to_path_buf(),
            entry_file: main,
            cache_root: cache_root.clone(),
            generate_source_map: true,
            preview_content_mode: PreviewContentMode::Normal,
            allow_large_copy_fallback: false,
        };

        let prepared = mirror_project_cancellable(&options, || false).unwrap();

        assert_eq!(
            prepared.generated_entry_file,
            cache_root.join("render/typst/main_file.typ")
        );
        assert!(cache_root
            .join("render/Author/Folder/SubFolder 1/file1.typ")
            .is_file());
        assert_eq!(prepared.storage.hard_linked_bytes, 0);
        assert_eq!(prepared.storage.copied_bytes, 0);
        assert_eq!(
            inspect_render_cache_storage(&cache_root).recorded_at_ms,
            prepared.storage.recorded_at_ms
        );
    }

    #[test]
    fn rejects_unsaved_outside_workspace_dependencies_before_writing_the_mirror() {
        let parent = tempfile::tempdir().unwrap();
        let workspace = parent.path().join("typst");
        let external = parent.path().join("Author/file1.typ");
        let main = workspace.join("main.typ");
        let cache_root = workspace.join(".typsastra/cache");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(external.parent().unwrap()).unwrap();
        fs::write(&main, "= Main").unwrap();
        fs::write(&external, "= External").unwrap();
        let options = RenderPrepareOptions {
            project_root: workspace,
            entry_file: main.clone(),
            cache_root: cache_root.clone(),
            generate_source_map: true,
            preview_content_mode: PreviewContentMode::Normal,
            allow_large_copy_fallback: false,
        };

        let error =
            prepare_single_in_memory_file(&options, &main, "#include \"../Author/file1.typ\"")
                .unwrap_err();

        assert!(error.contains("outside the current workspace"));
        assert!(!cache_root.exists());
    }

    #[test]
    fn materializes_pdf_assets_as_regular_cache_files() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("figure.pdf");
        let cache_file = workspace.path().join(".typsastra/cache/render/figure.pdf");
        fs::write(&source, b"%PDF-test").unwrap();
        fs::create_dir_all(cache_file.parent().unwrap()).unwrap();

        let outcome = prepare_asset_in_cache(&source, &cache_file).unwrap();
        assert!(matches!(
            outcome,
            AssetSyncOutcome::Ready(AssetSyncResult {
                changed: true,
                bytes: 9,
                kind: AssetStorageKind::HardLinked,
            })
        ));
        assert_eq!(fs::read(&cache_file).unwrap(), b"%PDF-test");
        let metadata = fs::symlink_metadata(&cache_file).unwrap();
        assert!(metadata.file_type().is_file());
        assert!(!metadata.file_type().is_symlink());
    }

    #[test]
    fn hard_linked_assets_share_storage_without_owning_the_source() {
        let workspace = tempfile::tempdir().unwrap();
        let probe_source = workspace.path().join("hard-link-probe-source");
        let probe_dest = workspace.path().join("hard-link-probe-dest");
        fs::write(&probe_source, b"probe").unwrap();
        if fs::hard_link(&probe_source, &probe_dest).is_err() {
            // The production path uses an ordinary copy on this filesystem.
            return;
        }
        fs::remove_file(&probe_dest).unwrap();

        let source = workspace.path().join("photo.png");
        let cache_file = workspace.path().join(".typsastra/cache/render/photo.png");
        fs::write(&source, b"original").unwrap();
        fs::create_dir_all(cache_file.parent().unwrap()).unwrap();

        let outcome = prepare_asset_in_cache(&source, &cache_file).unwrap();
        assert!(matches!(
            outcome,
            AssetSyncOutcome::Ready(AssetSyncResult {
                changed: true,
                bytes: 8,
                kind: AssetStorageKind::HardLinked,
            })
        ));
        fs::write(&source, b"updated").unwrap();
        assert_eq!(fs::read(&cache_file).unwrap(), b"updated");

        fs::remove_file(&cache_file).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"updated");
    }

    #[test]
    fn requires_explicit_approval_before_large_real_copy_fallbacks() {
        let pending = vec![
            PendingAssetCopy {
                source: PathBuf::from("one"),
                destination: PathBuf::from("cache/one"),
                bytes: 40 * 1024 * 1024,
            },
            PendingAssetCopy {
                source: PathBuf::from("two"),
                destination: PathBuf::from("cache/two"),
                bytes: 25 * 1024 * 1024,
            },
        ];

        let notice = large_copy_fallback_notice(&pending, false).unwrap();
        assert_eq!(notice.bytes, 65 * 1024 * 1024);
        assert_eq!(notice.files, 2);
        assert_eq!(notice.threshold_bytes, 64 * 1024 * 1024);
        assert!(large_copy_fallback_notice(&pending, true).is_none());
        assert!(large_copy_fallback_notice(&pending[..1], false).is_none());
    }

    #[test]
    fn migrates_existing_render_copies_once() {
        let workspace = tempfile::tempdir().unwrap();
        let cache_root = workspace.path().join(".typsastra/cache");
        let render_dir = cache_root.join("render");
        let maps_dir = cache_root.join("maps");
        let preview_dir = cache_root.join("preview");
        fs::create_dir_all(&render_dir).unwrap();
        fs::create_dir_all(&maps_dir).unwrap();
        fs::create_dir_all(preview_dir.join(".typsastra/cache/render")).unwrap();
        fs::write(render_dir.join("old-copy.png"), b"duplicated").unwrap();
        fs::write(maps_dir.join("old.typ.map.json"), b"{}").unwrap();
        fs::write(
            preview_dir.join(".typsastra/cache/render/main.pdf"),
            b"old preview",
        )
        .unwrap();

        migrate_render_cache_layout(&cache_root, &render_dir, &maps_dir, &preview_dir).unwrap();
        assert!(!render_dir.exists());
        assert!(!maps_dir.exists());
        assert!(!preview_dir.exists());
        assert_eq!(
            fs::read_to_string(cache_root.join("render-layout-version"))
                .unwrap()
                .trim(),
            RENDER_CACHE_LAYOUT_VERSION
        );

        fs::create_dir_all(&render_dir).unwrap();
        fs::write(render_dir.join("current.png"), b"keep").unwrap();
        migrate_render_cache_layout(&cache_root, &render_dir, &maps_dir, &preview_dir).unwrap();
        assert_eq!(fs::read(render_dir.join("current.png")).unwrap(), b"keep");
    }

    #[test]
    fn invalidates_a_render_cache_copied_from_another_workspace() {
        let source_workspace = tempfile::tempdir().unwrap();
        let copied_parent = tempfile::tempdir().unwrap();
        let copied_workspace = copied_parent.path().join("copied-project");
        let source_cache = source_workspace.path().join(".typsastra/cache");
        let copied_cache = copied_workspace.join(".typsastra/cache");
        let source_asset = source_workspace.path().join("images/photo.png");

        write_render_cache_owner(source_workspace.path(), &source_cache).unwrap();
        fs::create_dir_all(source_asset.parent().unwrap()).unwrap();
        fs::write(&source_asset, b"original asset").unwrap();
        fs::create_dir_all(source_cache.join("render/images")).unwrap();
        let source_cache_asset = source_cache.join("render/images/photo.png");
        if fs::hard_link(&source_asset, &source_cache_asset).is_err() {
            fs::copy(&source_asset, &source_cache_asset).unwrap();
        }

        fs::create_dir_all(&copied_cache).unwrap();
        fs::copy(
            source_cache.join(RENDER_CACHE_OWNER_FILE),
            copied_cache.join(RENDER_CACHE_OWNER_FILE),
        )
        .unwrap();
        fs::create_dir_all(copied_cache.join("render/images")).unwrap();
        // Simulate a copy tool that preserves a cache link to the old
        // workspace rather than materializing independent bytes.
        let copied_cache_asset = copied_cache.join("render/images/photo.png");
        if fs::hard_link(&source_asset, &copied_cache_asset).is_err() {
            fs::copy(&source_asset, &copied_cache_asset).unwrap();
        }
        fs::create_dir_all(copied_workspace.join(".typsastra")).unwrap();
        fs::write(
            copied_workspace.join(".typsastra/config.json"),
            b"{\"project\":\"keep\"}",
        )
        .unwrap();

        assert!(validate_existing_render_cache_owner(&copied_workspace, &copied_cache).unwrap());
        assert!(!copied_cache.exists());
        assert_eq!(fs::read(&source_asset).unwrap(), b"original asset");
        assert_eq!(
            fs::read(copied_workspace.join(".typsastra/config.json")).unwrap(),
            b"{\"project\":\"keep\"}"
        );

        ensure_render_cache_owner(&copied_workspace, &copied_cache).unwrap();
        assert_eq!(
            read_render_cache_owner(&copied_cache),
            Some(expected_render_cache_owner(&copied_workspace))
        );
    }

    #[test]
    fn preserves_a_render_cache_owned_by_the_current_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let cache_root = workspace.path().join(".typsastra/cache");
        write_render_cache_owner(workspace.path(), &cache_root).unwrap();
        fs::create_dir_all(cache_root.join("render")).unwrap();
        fs::write(cache_root.join("render/keep.png"), b"keep").unwrap();

        assert!(!validate_existing_render_cache_owner(workspace.path(), &cache_root).unwrap());
        assert_eq!(
            fs::read(cache_root.join("render/keep.png")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn stale_mirror_cleanup_removes_obsolete_draft_assets() {
        let workspace = tempfile::tempdir().unwrap();
        let render_dir = workspace.path().join(".typsastra/cache/render");
        let maps_dir = workspace.path().join(".typsastra/cache/maps");
        let draft_dir = render_dir.join(".typsastra-draft-assets");
        let placeholder = draft_dir.join("placeholder.svg");
        let stale_mirror = render_dir.join("removed-from-project.png");
        let stale_render_dir = render_dir.join("old-chapters");
        let stale_maps_dir = maps_dir.join("old-chapters");
        fs::create_dir_all(&draft_dir).unwrap();
        fs::create_dir_all(&stale_render_dir).unwrap();
        fs::create_dir_all(&stale_maps_dir).unwrap();
        fs::write(&placeholder, b"<svg/>").unwrap();
        fs::write(&stale_mirror, b"stale").unwrap();
        fs::write(stale_render_dir.join("chapter.typ"), b"stale").unwrap();
        fs::write(stale_maps_dir.join("chapter.typ.map.json"), b"stale").unwrap();

        clean_stale_cache_files(&render_dir, &maps_dir, workspace.path()).unwrap();

        assert!(!placeholder.exists());
        assert!(!stale_mirror.exists());
        assert!(!stale_render_dir.exists());
        assert!(!stale_maps_dir.exists());
    }

    #[test]
    fn normal_preview_rebuilds_a_map_that_belongs_to_an_old_source_path() {
        let workspace = tempfile::tempdir().unwrap();
        let source_dir = workspace.path().join("chapters");
        let source = source_dir.join("main.typ");
        let cache_root = workspace.path().join(".typsastra/cache");
        let render = cache_root.join("render/chapters/main.typ");
        let maps = cache_root.join("maps");
        let relative = Path::new("chapters/main.typ");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(render.parent().unwrap()).unwrap();
        fs::write(&source, "= Current chapter").unwrap();
        let options = RenderPrepareOptions {
            project_root: workspace.path().to_path_buf(),
            entry_file: source.clone(),
            cache_root,
            generate_source_map: true,
            preview_content_mode: PreviewContentMode::Normal,
            allow_large_copy_fallback: false,
        };

        process_typ_file(&source, &render, relative, &maps, &options).unwrap();
        let map_path = derived_metadata_path(&maps, relative, "map");
        let mut stale_map: SourceMap =
            serde_json::from_str(&fs::read_to_string(&map_path).unwrap()).unwrap();
        stale_map.source_file = workspace
            .path()
            .join("old-chapters/main.typ")
            .to_string_lossy()
            .to_string();
        fs::write(&map_path, serde_json::to_string_pretty(&stale_map).unwrap()).unwrap();

        let result = process_typ_file(&source, &render, relative, &maps, &options).unwrap();
        assert!(result.changed);
        let refreshed: SourceMap =
            serde_json::from_str(&fs::read_to_string(map_path).unwrap()).unwrap();
        assert_eq!(Path::new(&refreshed.source_file), source);
        assert_eq!(refreshed.source_digest, source_digest("= Current chapter"));
    }

    #[test]
    fn normal_draft_normal_draft_transition_regenerates_linked_blocks() {
        let workspace = tempfile::tempdir().unwrap();
        let main = workspace.path().join("main.typ");
        let image = workspace.path().join("photo.png");
        let cache_root = workspace.path().join(".typsastra/cache");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&800u32.to_be_bytes());
        png[20..24].copy_from_slice(&600u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        fs::write(&main, "#image(\"photo.png\", width: 50%)").unwrap();
        let mut options = RenderPrepareOptions {
            project_root: workspace.path().to_path_buf(),
            entry_file: main,
            cache_root: cache_root.clone(),
            generate_source_map: true,
            preview_content_mode: PreviewContentMode::Normal,
            allow_large_copy_fallback: false,
        };

        mirror_project_cancellable(&options, || false).unwrap();
        options.preview_content_mode = PreviewContentMode::Draft;
        let first_draft = mirror_project_cancellable(&options, || false).unwrap();
        assert_eq!(first_draft.draft_assets.len(), 1);
        let draft_source = fs::read_to_string(cache_root.join("render/main.typ")).unwrap();
        assert!(
            draft_source.contains("draft-preview.typsastra.invalid"),
            "prepared source did not contain the Draft link:\n{draft_source}"
        );
        assert!(draft_source.contains("font: \"New Computer Modern\", \"photo.png\""));
        assert!(!draft_source.contains("#raw("));

        options.preview_content_mode = PreviewContentMode::Normal;
        mirror_project_cancellable(&options, || false).unwrap();
        assert!(!fs::read_to_string(cache_root.join("render/main.typ"))
            .unwrap()
            .contains("draft-preview.typsastra.invalid"));

        options.preview_content_mode = PreviewContentMode::Draft;
        let restored_draft = mirror_project_cancellable(&options, || false).unwrap();
        assert_eq!(restored_draft.draft_cache_hits, 1);
        assert_eq!(restored_draft.changed_files.len(), 1);
        let draft_source = fs::read_to_string(cache_root.join("render/main.typ")).unwrap();
        assert!(draft_source.contains("draft-preview.typsastra.invalid"));
        assert!(draft_source.contains("font: \"New Computer Modern\", \"photo.png\""));
        assert!(!draft_source.contains("#raw("));
    }

    #[test]
    fn reuses_unchanged_draft_manifest_and_invalidates_changed_images() {
        let workspace = tempfile::tempdir().unwrap();
        let main = workspace.path().join("main.typ");
        let image = workspace.path().join("photo.png");
        let cache_root = workspace.path().join(".typsastra/cache");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&800u32.to_be_bytes());
        png[20..24].copy_from_slice(&600u32.to_be_bytes());
        fs::write(&image, &png).unwrap();
        fs::write(&main, "#image(\"photo.png\", width: 100%)").unwrap();
        let options = RenderPrepareOptions {
            project_root: workspace.path().to_path_buf(),
            entry_file: main.clone(),
            cache_root: cache_root.clone(),
            generate_source_map: true,
            preview_content_mode: PreviewContentMode::Draft,
            allow_large_copy_fallback: false,
        };

        let first = mirror_project_cancellable(&options, || false).unwrap();
        assert_eq!(first.draft_assets.len(), 1);
        assert_eq!(first.draft_cache_hits, 0);
        assert!(cache_root.join("maps/main.typ.draft.json").is_file());

        // Cloud sync and file restoration can update a source timestamp
        // without changing its contents. The source digest remains the
        // authority for Draft manifest reuse.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&main, "#image(\"photo.png\", width: 100%)").unwrap();
        let second = mirror_project_cancellable(&options, || false).unwrap();
        assert_eq!(second.draft_assets, first.draft_assets);
        assert_eq!(second.draft_cache_hits, 1);
        assert!(
            second.changed_files.is_empty(),
            "an unchanged Draft manifest should reuse the prepared source"
        );

        png[16..20].copy_from_slice(&1024u32.to_be_bytes());
        png.push(0);
        fs::write(&image, png).unwrap();
        let changed = mirror_project_cancellable(&options, || false).unwrap();
        assert_eq!(changed.draft_assets[0].width, 1024);
        assert_eq!(changed.draft_cache_hits, 0);
        assert!(
            changed
                .changed_files
                .iter()
                .any(|path| path.ends_with("main.typ")),
            "changed image metadata must invalidate the Draft source"
        );
    }

    #[test]
    fn draft_manifest_excludes_images_from_unrelated_typst_files() {
        let workspace = tempfile::tempdir().unwrap();
        let main = workspace.path().join("main.typ");
        let chapter = workspace.path().join("chapter.typ");
        let unrelated = workspace.path().join("unrelated.typ");
        let included_image = workspace.path().join("included.png");
        let unrelated_image = workspace.path().join("unrelated.png");
        let cache_root = workspace.path().join(".typsastra/cache");
        let png = |width: u32| {
            let mut bytes = vec![0u8; 24];
            bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
            bytes[16..20].copy_from_slice(&width.to_be_bytes());
            bytes[20..24].copy_from_slice(&600u32.to_be_bytes());
            bytes
        };
        fs::write(&main, "#include \"chapter.typ\"").unwrap();
        fs::write(&chapter, "#image(\"included.png\")").unwrap();
        fs::write(&unrelated, "#image(\"unrelated.png\")").unwrap();
        fs::write(&included_image, png(800)).unwrap();
        fs::write(&unrelated_image, png(1200)).unwrap();
        let options = RenderPrepareOptions {
            project_root: workspace.path().to_path_buf(),
            entry_file: main.clone(),
            cache_root,
            generate_source_map: true,
            preview_content_mode: PreviewContentMode::Draft,
            allow_large_copy_fallback: false,
        };

        let prepared = mirror_project_cancellable(&options, || false).unwrap();

        assert_eq!(prepared.draft_assets.len(), 1);
        assert_eq!(
            prepared.draft_assets[0].path,
            canonical_or_original(&included_image)
        );
        assert_eq!(
            prepared.draft_reachable_files,
            [
                canonical_or_original(&chapter),
                canonical_or_original(&main)
            ]
        );
        assert!(
            fs::read_to_string(options.cache_root.join("render").join("unrelated.typ"))
                .unwrap()
                .contains("draft-preview.typsastra.invalid"),
            "unrelated Typst files should remain prepared for mirror correctness"
        );
    }

    #[test]
    fn draft_image_frame_uses_the_outer_viewport_in_prepared_source() {
        let workspace = tempfile::tempdir().unwrap();
        let main = workspace.path().join("main.typ");
        let image = workspace.path().join("photo.png");
        let cache_root = workspace.path().join(".typsastra/cache");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&800u32.to_be_bytes());
        png[20..24].copy_from_slice(&600u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        fs::write(
            &main,
            "#block(width: 100%, height: 10cm, clip: true)[#move(dy: -2cm, [#image(\"photo.png\", width: 100%, height: 12cm, fit: \"cover\")])]",
        )
        .unwrap();
        let options = RenderPrepareOptions {
            project_root: workspace.path().to_path_buf(),
            entry_file: main,
            cache_root: cache_root.clone(),
            generate_source_map: true,
            preview_content_mode: PreviewContentMode::Draft,
            allow_large_copy_fallback: false,
        };

        let prepared = mirror_project_cancellable(&options, || false).unwrap();
        assert_eq!(prepared.draft_assets.len(), 1);
        let draft_source = fs::read_to_string(cache_root.join("render/main.typ")).unwrap();
        assert!(draft_source.contains("width: 100%"));
        assert!(draft_source.contains("height: 10cm"));
        assert!(
            draft_source.contains("draft-preview.typsastra.invalid"),
            "prepared source did not contain the Draft link:\n{draft_source}"
        );
        assert!(draft_source.contains("move(dy: -2cm"));
        assert!(draft_source.contains("move(dy: -(-2cm),"));
        assert!(!draft_source.contains("height: 12cm"));
    }

    #[test]
    fn replaces_every_reference_to_the_same_draft_asset() {
        let workspace = tempfile::tempdir().unwrap();
        let main = workspace.path().join("main.typ");
        let images = workspace.path().join("images");
        let image = images.join("logo.png");
        let cache_root = workspace.path().join(".typsastra/cache");
        fs::create_dir_all(&images).unwrap();
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1655u32.to_be_bytes());
        png[20..24].copy_from_slice(&1655u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let source = r##"#set text(font: "Calibri", size: 11pt)
#let ink = rgb("#11161C")
#let steel = rgb("#596572")
#let line-col = rgb("#C7CFD6")
#set page(
  paper: "a4",
  margin: (top: 2cm, bottom: 2cm, left: 1.5cm, right: 1.5cm),
  header: context [
    #set text(size: 7.5pt, fill: steel)
    #grid(
      columns: (1fr, auto),
      align: horizon,
      [#text(weight: "bold", fill: ink)[Example] #h(5pt) Portfolio.],
      [EVALUATION USE],
    )
    #v(5pt)
    #line(length: 100%, stroke: 0.6pt + line-col)
  ],
  footer: context [
    #set text(size: 7.5pt, fill: steel)
    #line(length: 100%, stroke: 0.6pt + line-col)
    #v(4pt)
    #grid(columns: (1fr, auto), [Example · Restricted], [#counter(page).display()])
  ],
)
#let cap(body) = text(size: 9pt, weight: "bold", fill: steel)[#body]
#let title(body) = text(size: 30pt, weight: "bold", fill: ink)[#body]
#let subtitle(body) = text(size: 13pt, fill: steel)[#body]
#let bar = rect(width: 28mm, height: 4pt, stroke: none)
#let pill(body) = box(inset: (x: 8pt, y: 4pt), radius: 2pt)[#set text(size: 7.5pt, weight: "bold"); #body]
#let numbered(num, head, body) = grid(
  columns: (10mm, 1fr),
  column-gutter: 8pt,
  [#text(size: 22pt, weight: "bold", fill: steel)[#num]],
  [#text(weight: "bold", size: 12pt)[#head] #v(3pt) #text(fill: steel)[#body]],
)

#align(center + horizon)[
  #v(2pt)
  #image("images/logo.png", width: 3.2cm)
  #v(9pt)
  #cap[Cover]
]

#pagebreak()
#align(center)[
  #image("images/logo.png", width: 3.2cm)
  #cap[Closing]
]
"##;
        fs::write(&main, source).unwrap();
        let options = RenderPrepareOptions {
            project_root: workspace.path().to_path_buf(),
            entry_file: main,
            cache_root: cache_root.clone(),
            generate_source_map: true,
            preview_content_mode: PreviewContentMode::Draft,
            allow_large_copy_fallback: false,
        };

        let prepared = mirror_project_cancellable(&options, || false).unwrap();
        assert_eq!(prepared.draft_assets.len(), 1);
        assert_eq!(prepared.draft_assets[0].references.len(), 2);
        let draft_source = fs::read_to_string(cache_root.join("render/main.typ")).unwrap();
        assert_eq!(
            draft_source
                .matches("https://draft-preview.typsastra.invalid/")
                .count(),
            2
        );
        assert!(!draft_source.contains("image(\"images/logo.png\""));
    }

    #[test]
    fn preserves_original_source_around_draft_replacements() {
        let source = "before TARGET after";
        let draft = DraftPreparation {
            replacements: vec![crate::render_prepare::draft::DraftReplacement {
                start: 7,
                end: 13,
                generated: "REPLACED".into(),
            }],
            ..DraftPreparation::default()
        };
        let mut sourcemap = SourceMap::new("src.typ".into(), "dest.typ".into());

        let generated = prepare_source_content(source, &draft, &mut sourcemap);

        assert_eq!(generated, "before REPLACED after");
        assert_eq!(sourcemap.generated_to_source(2), Some(2));
        assert_eq!(sourcemap.generated_to_source(18), Some(16));
    }
}
