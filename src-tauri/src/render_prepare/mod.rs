#![allow(unused_imports)]

pub mod draft;
pub mod draft_thumbnail;
pub mod mirror;
pub mod scanner;
pub mod sourcemap;

pub use draft::{DraftImageAsset, DraftImageDiagnostic, PreviewContentMode};
pub use draft_thumbnail::{
    cancel_draft_thumbnail_generation, get_draft_thumbnail_status, start_draft_thumbnail_generation,
};
pub use mirror::{
    inspect_render_cache_storage, inspect_workspace_render_caches, mirror_project_cancellable,
    prepare_single_in_memory_file, validate_existing_render_cache_owner,
    workspace_render_cache_root, RenderCacheStorageReport, RenderPrepareOptions,
    RenderPrepareResult, RenderPrepareWarning, WorkspaceRenderCacheStorageEntry,
};
pub use sourcemap::SourceMap;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static RENDER_PREPARATION_EPOCH: AtomicU64 = AtomicU64::new(0);
static RENDER_PREPARATION_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn cancel_render_preparation() {
    RENDER_PREPARATION_EPOCH.fetch_add(1, Ordering::AcqRel);
}

#[tauri::command]
pub async fn prepare_render_project(
    options: RenderPrepareOptions,
) -> Result<RenderPrepareResult, String> {
    let epoch = RENDER_PREPARATION_EPOCH.load(Ordering::Acquire);
    tokio::task::spawn_blocking(move || -> Result<RenderPrepareResult, String> {
        let _preparation_guard = RENDER_PREPARATION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        mirror_project_cancellable(&options, || {
            RENDER_PREPARATION_EPOCH.load(Ordering::Acquire) != epoch
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPrepareFileResult {
    pub generated_path: String,
    pub prepared_text: String,
    pub draft_assets: Vec<DraftImageAsset>,
    pub draft_diagnostics: Vec<DraftImageDiagnostic>,
    pub draft_cache_hit: bool,
}

#[tauri::command]
pub async fn prepare_render_file(
    options: RenderPrepareOptions,
    file_path: String,
    source_code: String,
) -> Result<RenderPrepareFileResult, String> {
    let epoch = RENDER_PREPARATION_EPOCH.load(Ordering::Acquire);
    tokio::task::spawn_blocking(move || -> Result<RenderPrepareFileResult, String> {
        let _preparation_guard = RENDER_PREPARATION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if RENDER_PREPARATION_EPOCH.load(Ordering::Acquire) != epoch {
            return Err("Render preparation cancelled.".to_string());
        }
        let path = std::path::Path::new(&file_path);
        let prepared = prepare_single_in_memory_file(&options, path, &source_code)?;
        if RENDER_PREPARATION_EPOCH.load(Ordering::Acquire) != epoch {
            return Err("Render preparation cancelled.".to_string());
        }
        Ok(RenderPrepareFileResult {
            generated_path: prepared.path.to_string_lossy().to_string(),
            prepared_text: prepared.prepared_text,
            draft_assets: prepared.draft.assets,
            draft_diagnostics: prepared.draft.diagnostics,
            draft_cache_hit: prepared.draft_cache_hit,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn map_generated_to_source(
    cache_root: String,
    relative_path: String,
    generated_offset: usize,
) -> Option<usize> {
    let maps_dir = std::path::Path::new(&cache_root).join("maps");
    let mut map_rel = std::path::PathBuf::from(&relative_path);
    let ext = map_rel
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("typ");
    map_rel.set_extension(format!("{}.map.json", ext));
    let map_path = maps_dir.join(map_rel);

    if let Ok(content) = std::fs::read_to_string(map_path) {
        if let Ok(sourcemap) = serde_json::from_str::<SourceMap>(&content) {
            return sourcemap.generated_to_source(generated_offset);
        }
    }
    None
}

#[tauri::command]
pub fn map_source_to_generated(
    cache_root: String,
    relative_path: String,
    source_offset: usize,
) -> Option<usize> {
    let maps_dir = std::path::Path::new(&cache_root).join("maps");
    let mut map_rel = std::path::PathBuf::from(&relative_path);
    let ext = map_rel
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("typ");
    map_rel.set_extension(format!("{}.map.json", ext));
    let map_path = maps_dir.join(map_rel);

    if let Ok(content) = std::fs::read_to_string(map_path) {
        if let Ok(sourcemap) = serde_json::from_str::<SourceMap>(&content) {
            return sourcemap.source_to_generated(source_offset);
        }
    }
    None
}
