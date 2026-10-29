use super::draft::DraftImageAsset;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{
    DynamicImage, ExtendedColorType, GenericImageView, ImageDecoder, ImageReader, Rgb, RgbImage,
};
use resvg::{tiny_skia, usvg};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const THUMBNAIL_LONGEST_EDGE: u32 = 640;
const THUMBNAIL_TARGET_BYTES: usize = 96 * 1024;
const THUMBNAIL_TRANSFORM_VERSION: &str = "draft-thumbnail-v3-jpeg-640-96k-exif";
const LARGE_SOURCE_BYTES: u64 = 1024 * 1024;
const LARGE_DIMENSION: u32 = 1000;

static THUMBNAIL_EPOCH: AtomicU64 = AtomicU64::new(0);
static THUMBNAIL_WORKER_LOCK: Mutex<()> = Mutex::new(());
static THUMBNAIL_STATE: LazyLock<Mutex<ThumbnailState>> =
    LazyLock::new(|| Mutex::new(ThumbnailState::default()));

#[derive(Default)]
struct ThumbnailState {
    generation: u64,
    workspace_root: PathBuf,
    entries: HashMap<String, ThumbnailEntry>,
}

#[derive(Clone)]
struct ThumbnailEntry {
    cache_path: PathBuf,
    source_path: PathBuf,
    status: ThumbnailStatus,
    mime_type: String,
    width: u32,
    height: u32,
    source_bytes: u64,
    queue_class: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ThumbnailStatus {
    Pending,
    Generating,
    Ready,
    Failed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDraftThumbnailRequest {
    pub generation: u64,
    pub workspace_root: String,
    pub cache_root_path: String,
    pub document_root_path: String,
    pub assets: Vec<DraftImageAsset>,
    pub displayed_page_asset_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftThumbnailQueueSummary {
    pub generation: u64,
    pub cache_hits: usize,
    pub queued: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftThumbnailStatus {
    pub status: String,
    pub path: Option<String>,
    pub mime_type: Option<String>,
    pub source_width: u32,
    pub source_height: u32,
    pub source_bytes: u64,
    pub thumbnail_width: Option<u32>,
    pub thumbnail_height: Option<u32>,
    pub thumbnail_bytes: Option<u64>,
    pub queue_class: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftThumbnailQueueMetric {
    pub generation: u64,
    pub status: String,
    pub total_images: usize,
    pub cache_hits: usize,
    pub generated: usize,
    pub failed: usize,
    pub skipped: usize,
    pub output_bytes: u64,
    pub decode_ms: f64,
    pub resize_ms: f64,
    pub encode_ms: f64,
    pub total_ms: f64,
}

#[derive(Clone)]
struct ThumbnailJob {
    id: String,
    entry: ThumbnailEntry,
}

struct GeneratedThumbnail {
    output_bytes: u64,
    decode_ms: f64,
    resize_ms: f64,
    encode_ms: f64,
}

#[tauri::command]
pub async fn start_draft_thumbnail_generation(
    app: AppHandle,
    request: StartDraftThumbnailRequest,
) -> Result<DraftThumbnailQueueSummary, String> {
    let queue_started = Instant::now();
    let workspace_root = canonical_path(Path::new(&request.workspace_root))
        .ok_or_else(|| "The thumbnail workspace root is unavailable.".to_string())?;
    let managed_cache_root = PathBuf::from(&request.cache_root_path);
    fs::create_dir_all(&managed_cache_root)
        .map_err(|error| format!("Could not create the Draft thumbnail cache: {error}"))?;
    let managed_cache_root = canonical_path(&managed_cache_root)
        .ok_or_else(|| "The Draft thumbnail cache root is unavailable.".to_string())?;
    if managed_cache_root.starts_with(&workspace_root) {
        return Err("The Draft thumbnail cache must live outside the active workspace.".into());
    }
    let document_root_path = canonical_path(Path::new(&request.document_root_path))
        .ok_or_else(|| "The thumbnail document root is unavailable.".to_string())?;
    let cache_namespace = thumbnail_document_namespace(&workspace_root, &document_root_path)?;
    let thumbnail_root = managed_cache_root.join("draft-thumbnails");
    remove_legacy_flat_thumbnail_entries(&thumbnail_root);
    let cache_root = thumbnail_root.join(cache_namespace);
    fs::create_dir_all(&cache_root)
        .map_err(|error| format!("Could not create the Draft thumbnail cache: {error}"))?;
    let epoch = THUMBNAIL_EPOCH.fetch_add(1, Ordering::AcqRel) + 1;
    let displayed_order = request
        .displayed_page_asset_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.clone(), index))
        .collect::<HashMap<_, _>>();
    let displayed = displayed_order.keys().cloned().collect::<HashSet<_>>();

    let indexed = ordered_assets(request.assets, &displayed_order);

    let mut entries = HashMap::new();
    let mut jobs = Vec::new();
    let mut cache_hits = 0;
    let mut cached_output_bytes = 0;
    for (_, asset) in indexed {
        let source_path = canonical_path(&asset.path)
            .ok_or_else(|| format!("Draft image is unavailable: {}", asset.path.display()))?;
        if !source_path.starts_with(&workspace_root) {
            return Err("A Draft thumbnail source resolves outside the active workspace.".into());
        }
        let metadata = fs::metadata(&source_path)
            .map_err(|error| format!("Could not inspect Draft image metadata: {error}"))?;
        let (source_width, source_height) =
            oriented_source_dimensions(&source_path).unwrap_or((asset.width, asset.height));
        let cache_key = thumbnail_cache_key(&source_path, &metadata)?;
        let cache_path = cache_root.join(format!("{cache_key}.jpg"));
        let ready = fs::metadata(&cache_path)
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false);
        let queue_class = if displayed.contains(&asset.id) && is_large(&asset) {
            "displayed-large"
        } else if displayed.contains(&asset.id) {
            "displayed"
        } else {
            "remaining"
        }
        .to_string();
        let entry = ThumbnailEntry {
            cache_path,
            source_path,
            status: if ready {
                ThumbnailStatus::Ready
            } else {
                ThumbnailStatus::Pending
            },
            mime_type: "image/jpeg".into(),
            width: source_width,
            height: source_height,
            source_bytes: asset.source_bytes,
            queue_class,
        };
        if ready {
            cache_hits += 1;
            let output_bytes = fs::metadata(&entry.cache_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            cached_output_bytes += output_bytes;
        } else {
            jobs.push(ThumbnailJob {
                id: asset.id.clone(),
                entry: entry.clone(),
            });
        }
        entries.insert(asset.id, entry);
    }
    let retained_paths = entries
        .values()
        .map(|entry| entry.cache_path.clone())
        .collect::<HashSet<_>>();
    let total_images = entries.len();
    {
        let mut state = THUMBNAIL_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *state = ThumbnailState {
            generation: request.generation,
            workspace_root,
            entries,
        };
    }
    let queued = jobs.len();
    tauri::async_runtime::spawn_blocking(move || {
        run_thumbnail_queue(
            &app,
            epoch,
            request.generation,
            queue_started,
            &cache_root,
            &retained_paths,
            total_images,
            cache_hits,
            cached_output_bytes,
            jobs,
        )
    });
    Ok(DraftThumbnailQueueSummary {
        generation: request.generation,
        cache_hits,
        queued,
    })
}

fn ordered_assets(
    assets: Vec<DraftImageAsset>,
    displayed_order: &HashMap<String, usize>,
) -> Vec<(usize, DraftImageAsset)> {
    let displayed = displayed_order.keys().collect::<HashSet<_>>();
    let mut indexed = assets.into_iter().enumerate().collect::<Vec<_>>();
    indexed.sort_by(|(left_index, left), (right_index, right)| {
        let left_displayed = displayed.contains(&left.id);
        let right_displayed = displayed.contains(&right.id);
        let left_large = is_large(left);
        let right_large = is_large(right);
        let left_class = if left_displayed && left_large {
            0
        } else if left_displayed {
            1
        } else {
            2
        };
        let right_class = if right_displayed && right_large {
            0
        } else if right_displayed {
            1
        } else {
            2
        };
        left_class.cmp(&right_class).then_with(|| {
            if left_class < 2 {
                displayed_order
                    .get(&left.id)
                    .unwrap_or(left_index)
                    .cmp(displayed_order.get(&right.id).unwrap_or(right_index))
            } else {
                right
                    .estimated_decoded_bytes
                    .cmp(&left.estimated_decoded_bytes)
                    .then_with(|| right.source_bytes.cmp(&left.source_bytes))
                    .then_with(|| left_index.cmp(right_index))
            }
        })
    });
    indexed
}

#[tauri::command]
pub fn get_draft_thumbnail_status(
    generation: u64,
    workspace_root: String,
    id: String,
) -> Result<DraftThumbnailStatus, String> {
    let requested_root = canonical_path(Path::new(&workspace_root))
        .ok_or_else(|| "The thumbnail workspace root is unavailable.".to_string())?;
    let state = THUMBNAIL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.generation != generation || state.workspace_root != requested_root {
        return Err("The Draft thumbnail generation is no longer active.".into());
    }
    let entry = state
        .entries
        .get(&id)
        .ok_or_else(|| "The Draft thumbnail is not part of the active manifest.".to_string())?;
    let ready = entry.status == ThumbnailStatus::Ready;
    let thumbnail_dimensions = ready
        .then(|| image::image_dimensions(&entry.cache_path).ok())
        .flatten();
    Ok(DraftThumbnailStatus {
        status: match entry.status {
            ThumbnailStatus::Pending => "pending",
            ThumbnailStatus::Generating => "generating",
            ThumbnailStatus::Ready => "ready",
            ThumbnailStatus::Failed => "failed",
        }
        .into(),
        path: ready.then(|| entry.cache_path.to_string_lossy().to_string()),
        mime_type: ready.then(|| entry.mime_type.clone()),
        source_width: entry.width,
        source_height: entry.height,
        source_bytes: entry.source_bytes,
        thumbnail_width: thumbnail_dimensions.map(|dimensions| dimensions.0),
        thumbnail_height: thumbnail_dimensions.map(|dimensions| dimensions.1),
        thumbnail_bytes: ready
            .then(|| {
                fs::metadata(&entry.cache_path)
                    .ok()
                    .map(|metadata| metadata.len())
            })
            .flatten(),
        queue_class: entry.queue_class.clone(),
    })
}

#[tauri::command]
pub fn cancel_draft_thumbnail_generation() {
    THUMBNAIL_EPOCH.fetch_add(1, Ordering::AcqRel);
    let mut state = THUMBNAIL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *state = ThumbnailState::default();
}

fn run_thumbnail_queue(
    app: &AppHandle,
    epoch: u64,
    generation: u64,
    queue_started: Instant,
    cache_root: &Path,
    retained_paths: &HashSet<PathBuf>,
    total_images: usize,
    cache_hits: usize,
    cached_output_bytes: u64,
    jobs: Vec<ThumbnailJob>,
) {
    let _worker = THUMBNAIL_WORKER_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    remove_stale_cache_entries(cache_root, retained_paths);
    let queued = jobs.len();
    let mut generated = 0;
    let mut failed = 0;
    let mut output_bytes = cached_output_bytes;
    let mut decode_ms = 0.0;
    let mut resize_ms = 0.0;
    let mut encode_ms = 0.0;
    let mut interrupted = false;
    for job in jobs {
        if THUMBNAIL_EPOCH.load(Ordering::Acquire) != epoch {
            interrupted = true;
            break;
        }
        update_status(generation, &job.id, ThumbnailStatus::Generating);
        let result = generate_thumbnail(&job.entry.source_path, &job.entry.cache_path);
        let status = if result.is_ok() {
            ThumbnailStatus::Ready
        } else {
            ThumbnailStatus::Failed
        };
        update_status(generation, &job.id, status);
        match result {
            Ok(result) => {
                generated += 1;
                output_bytes += result.output_bytes;
                decode_ms += result.decode_ms;
                resize_ms += result.resize_ms;
                encode_ms += result.encode_ms;
            }
            Err(_) => failed += 1,
        }
    }
    let current_epoch = THUMBNAIL_EPOCH.load(Ordering::Acquire);
    let current_generation = THUMBNAIL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .generation;
    let status = if !interrupted && current_epoch == epoch {
        "completed"
    } else if current_generation == 0 {
        "cancelled"
    } else {
        "superseded"
    };
    emit_thumbnail_queue_metric(
        app,
        DraftThumbnailQueueMetric {
            generation,
            status: status.into(),
            total_images,
            cache_hits,
            generated,
            failed,
            skipped: queued.saturating_sub(generated + failed),
            output_bytes,
            decode_ms,
            resize_ms,
            encode_ms,
            total_ms: duration_ms(queue_started),
        },
    );
}

fn remove_stale_cache_entries(cache_root: &Path, retained_paths: &HashSet<PathBuf>) {
    let Ok(entries) = fs::read_dir(cache_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && !retained_paths.contains(&path) {
            let _ = fs::remove_file(path);
        }
    }
}

fn remove_legacy_flat_thumbnail_entries(thumbnail_root: &Path) {
    let Ok(entries) = fs::read_dir(thumbnail_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let _ = fs::remove_file(path);
        }
    }
}

fn update_status(generation: u64, id: &str, status: ThumbnailStatus) {
    let mut state = THUMBNAIL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.generation == generation {
        if let Some(entry) = state.entries.get_mut(id) {
            entry.status = status;
        }
    }
}

fn generate_thumbnail(source: &Path, destination: &Path) -> Result<GeneratedThumbnail, String> {
    if destination.is_file() {
        return Ok(GeneratedThumbnail {
            output_bytes: fs::metadata(destination)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            decode_ms: 0.0,
            resize_ms: 0.0,
            encode_ms: 0.0,
        });
    }
    let decode_started = Instant::now();
    let image = if source
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
    {
        render_svg(source)?
    } else {
        decode_oriented_image(source)?
    };
    let decode_ms = duration_ms(decode_started);
    let resize_started = Instant::now();
    let (width, height) = image.dimensions();
    let thumbnail = if width <= THUMBNAIL_LONGEST_EDGE && height <= THUMBNAIL_LONGEST_EDGE {
        image
    } else {
        let (output_width, output_height) =
            scaled_dimensions(width, height, THUMBNAIL_LONGEST_EDGE);
        image.resize_exact(output_width, output_height, FilterType::Triangle)
    };
    let initial_resize_ms = duration_ms(resize_started);
    let encode_started = Instant::now();
    let (encoded, _, _, adaptive_resize_ms) = encode_bounded_jpeg(thumbnail)?;
    let encode_ms = (duration_ms(encode_started) - adaptive_resize_ms).max(0.0);
    let resize_ms = initial_resize_ms + adaptive_resize_ms;
    let temporary = destination.with_extension(format!(
        "jpg.tmp-{}-{}",
        std::process::id(),
        THUMBNAIL_EPOCH.load(Ordering::Acquire)
    ));
    fs::write(&temporary, &encoded)
        .map_err(|error| format!("Could not write thumbnail: {error}"))?;
    if destination.is_file() {
        let _ = fs::remove_file(&temporary);
        return Ok(GeneratedThumbnail {
            output_bytes: fs::metadata(destination)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            decode_ms,
            resize_ms,
            encode_ms,
        });
    }
    fs::rename(&temporary, destination)
        .map_err(|error| format!("Could not commit thumbnail atomically: {error}"))?;
    Ok(GeneratedThumbnail {
        output_bytes: fs::metadata(destination)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        decode_ms,
        resize_ms,
        encode_ms,
    })
}

fn decode_oriented_image(path: &Path) -> Result<DynamicImage, String> {
    let reader = ImageReader::open(path)
        .map_err(|error| format!("Could not open image: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("Could not identify image format: {error}"))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("Could not initialize image decoder: {error}"))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("Could not decode image: {error}"))?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn oriented_source_dimensions(path: &Path) -> Option<(u32, u32)> {
    let reader = ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    Some(match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (height, width),
        Orientation::NoTransforms
        | Orientation::Rotate180
        | Orientation::FlipHorizontal
        | Orientation::FlipVertical => (width, height),
    })
}

fn render_svg(path: &Path) -> Result<DynamicImage, String> {
    let data = fs::read(path).map_err(|error| format!("Could not read SVG: {error}"))?;
    let options = usvg::Options::default();
    let tree = usvg::Tree::from_data(&data, &options)
        .map_err(|error| format!("Could not parse SVG: {error}"))?;
    let size = tree.size();
    let longest = size.width().max(size.height());
    let scale = (THUMBNAIL_LONGEST_EDGE as f32 / longest).min(1.0);
    let width = (size.width() * scale).round().max(1.0) as u32;
    let height = (size.height() * scale).round().max(1.0) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| "Could not allocate an SVG thumbnail surface.".to_string())?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    Ok(DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width, height, pixmap.take())
            .ok_or_else(|| "Could not convert the SVG thumbnail surface.".to_string())?,
    ))
}

fn is_large(asset: &DraftImageAsset) -> bool {
    asset.width >= LARGE_DIMENSION
        || asset.height >= LARGE_DIMENSION
        || asset.source_bytes >= LARGE_SOURCE_BYTES
}

fn scaled_dimensions(width: u32, height: u32, longest_edge: u32) -> (u32, u32) {
    let scale = longest_edge as f64 / f64::from(width.max(height));
    (
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    )
}

fn encode_bounded_jpeg(image: DynamicImage) -> Result<(Vec<u8>, u32, u32, f64), String> {
    let mut rgb = flatten_to_rgb(image);
    let mut adaptive_resize_ms = 0.0;
    let mut quality = 68u8;
    loop {
        let (width, height) = rgb.dimensions();
        let mut encoded = Vec::new();
        JpegEncoder::new_with_quality(&mut encoded, quality)
            .encode(&rgb, width, height, ExtendedColorType::Rgb8)
            .map_err(|error| format!("Could not encode thumbnail: {error}"))?;
        if encoded.len() <= THUMBNAIL_TARGET_BYTES {
            return Ok((encoded, width, height, adaptive_resize_ms));
        }
        if width.max(height) <= 1 {
            return Err("Could not satisfy the Draft thumbnail byte budget.".into());
        }
        let resize_started = Instant::now();
        let current_edge = width.max(height);
        let next_edge = ((current_edge as f64 * 0.78).round() as u32)
            .min(current_edge - 1)
            .max(1);
        let (next_width, next_height) = scaled_dimensions(width, height, next_edge);
        rgb = image::imageops::resize(&rgb, next_width, next_height, FilterType::Triangle);
        adaptive_resize_ms += duration_ms(resize_started);
        quality = quality.saturating_sub(8).max(36);
    }
}

fn flatten_to_rgb(image: DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let pixel = rgba.get_pixel(x, y).0;
        let alpha = u16::from(pixel[3]);
        let blend =
            |channel: u8| ((u16::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])])
    })
}

fn duration_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn emit_thumbnail_queue_metric(app: &AppHandle, metric: DraftThumbnailQueueMetric) {
    let _ = app.emit("draft-thumbnail-queue-metric", metric);
}

fn thumbnail_cache_key(path: &Path, metadata: &fs::Metadata) -> Result<String, String> {
    let modified = metadata
        .modified()
        .map_err(|error| format!("Could not read the image modification time: {error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Image modification time is invalid: {error}"))?
        .as_nanos();
    let mut digest = Sha256::new();
    digest.update(path.to_string_lossy().as_bytes());
    digest.update(metadata.len().to_le_bytes());
    digest.update(modified.to_le_bytes());
    digest.update(THUMBNAIL_TRANSFORM_VERSION.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn thumbnail_document_namespace(
    workspace_root: &Path,
    document_root_path: &Path,
) -> Result<String, String> {
    let workspace_root = canonical_path(workspace_root)
        .ok_or_else(|| "The thumbnail workspace root is unavailable.".to_string())?;
    let document_root_path = canonical_path(document_root_path)
        .ok_or_else(|| "The thumbnail document root is unavailable.".to_string())?;
    let relative = document_root_path
        .strip_prefix(&workspace_root)
        .map_err(|_| "The Draft thumbnail document root is outside the active workspace.")?;
    let identity = relative.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let identity = identity.to_lowercase();
    let mut digest = Sha256::new();
    digest.update(identity.as_bytes());
    Ok(format!("{:x}", digest.finalize())[..24].to_string())
}

fn canonical_path(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageFormat;
    fn asset(
        id: &str,
        width: u32,
        height: u32,
        source_bytes: u64,
        decoded_bytes: u64,
    ) -> DraftImageAsset {
        DraftImageAsset {
            id: id.into(),
            path: PathBuf::from(format!("{id}.png")),
            mime_type: "image/png".into(),
            width,
            height,
            source_bytes,
            estimated_decoded_bytes: decoded_bytes,
            references: Vec::new(),
        }
    }

    #[test]
    fn builds_one_immutable_queue_in_required_priority_order() {
        let assets = vec![
            asset("remaining-small", 100, 100, 10, 40_000),
            asset("displayed-small-b", 500, 500, 20, 1_000_000),
            asset("remaining-largest", 900, 900, 30, 4_000_000),
            asset("displayed-large-b", 1200, 700, 40, 3_360_000),
            asset("displayed-small-a", 400, 400, 50, 640_000),
            asset("displayed-large-a", 800, 800, LARGE_SOURCE_BYTES, 2_560_000),
            asset("remaining-medium", 700, 700, 60, 1_960_000),
        ];
        let displayed = [
            ("displayed-small-a".to_string(), 0),
            ("displayed-large-a".to_string(), 1),
            ("displayed-small-b".to_string(), 2),
            ("displayed-large-b".to_string(), 3),
        ]
        .into_iter()
        .collect::<HashMap<_, _>>();

        let ordered = ordered_assets(assets, &displayed)
            .into_iter()
            .map(|(_, asset)| asset.id)
            .collect::<Vec<_>>();

        assert_eq!(
            ordered,
            [
                "displayed-large-a",
                "displayed-large-b",
                "displayed-small-a",
                "displayed-small-b",
                "remaining-largest",
                "remaining-medium",
                "remaining-small",
            ]
        );
    }

    #[test]
    fn generates_a_ratio_preserving_thumbnail_without_upscaling() {
        let workspace = tempfile::tempdir().unwrap();
        let large_source = workspace.path().join("large.png");
        let large_destination = workspace.path().join("large-thumbnail.jpg");
        let detailed = RgbImage::from_fn(1600, 900, |x, y| {
            Rgb([
                ((x * 31 + y * 17) % 256) as u8,
                ((x * 7 + y * 43) % 256) as u8,
                ((x * 53 + y * 3) % 256) as u8,
            ])
        });
        DynamicImage::ImageRgb8(detailed)
            .save_with_format(&large_source, ImageFormat::Png)
            .unwrap();

        generate_thumbnail(&large_source, &large_destination).unwrap();
        let large_thumbnail = ImageReader::open(&large_destination)
            .unwrap()
            .decode()
            .unwrap();
        assert!(large_thumbnail.width() <= THUMBNAIL_LONGEST_EDGE);
        assert!(large_thumbnail.height() <= THUMBNAIL_LONGEST_EDGE);
        let source_ratio = 1600.0 / 900.0;
        let thumbnail_ratio =
            f64::from(large_thumbnail.width()) / f64::from(large_thumbnail.height());
        assert!((source_ratio - thumbnail_ratio).abs() < 0.01);
        assert!(fs::metadata(&large_destination).unwrap().len() < 100 * 1024);

        let small_source = workspace.path().join("small.png");
        let small_destination = workspace.path().join("small-thumbnail.jpg");
        DynamicImage::new_rgba8(320, 180)
            .save_with_format(&small_source, ImageFormat::Png)
            .unwrap();

        generate_thumbnail(&small_source, &small_destination).unwrap();
        let small_thumbnail = ImageReader::open(&small_destination)
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!(small_thumbnail.dimensions(), (320, 180));
    }

    #[test]
    fn removes_obsolete_thumbnail_versions_and_stale_sources() {
        let workspace = tempfile::tempdir().unwrap();
        let retained = workspace.path().join("current.jpg");
        let old_png = workspace.path().join("old.png");
        let stale_jpeg = workspace.path().join("stale.jpg");
        fs::write(&retained, b"current").unwrap();
        fs::write(&old_png, b"old").unwrap();
        fs::write(&stale_jpeg, b"stale").unwrap();

        remove_stale_cache_entries(workspace.path(), &[retained.clone()].into_iter().collect());

        assert!(retained.is_file());
        assert!(!old_png.exists());
        assert!(!stale_jpeg.exists());
    }

    #[test]
    fn applies_exif_orientation_before_generating_the_thumbnail() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("rotated-camera.jpg");
        let destination = workspace.path().join("rotated-camera-thumbnail.jpg");
        let pixels = RgbImage::from_fn(40, 20, |x, y| Rgb([(x * 5) as u8, (y * 10) as u8, 120]));
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 90)
            .encode(&pixels, 40, 20, ExtendedColorType::Rgb8)
            .unwrap();
        let mut exif = Vec::new();
        exif.extend_from_slice(b"Exif\0\0II");
        exif.extend_from_slice(&42u16.to_le_bytes());
        exif.extend_from_slice(&8u32.to_le_bytes());
        exif.extend_from_slice(&1u16.to_le_bytes());
        exif.extend_from_slice(&0x0112u16.to_le_bytes());
        exif.extend_from_slice(&3u16.to_le_bytes());
        exif.extend_from_slice(&1u32.to_le_bytes());
        exif.extend_from_slice(&6u16.to_le_bytes());
        exif.extend_from_slice(&0u16.to_le_bytes());
        exif.extend_from_slice(&0u32.to_le_bytes());
        let mut oriented_jpeg = Vec::new();
        oriented_jpeg.extend_from_slice(&jpeg[..2]);
        oriented_jpeg.extend_from_slice(&[0xff, 0xe1]);
        oriented_jpeg.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented_jpeg.extend_from_slice(&exif);
        oriented_jpeg.extend_from_slice(&jpeg[2..]);
        fs::write(&source, oriented_jpeg).unwrap();

        assert_eq!(oriented_source_dimensions(&source), Some((20, 40)));
        generate_thumbnail(&source, &destination).unwrap();
        assert_eq!(image::image_dimensions(&destination).unwrap(), (20, 40));
    }

    #[test]
    fn cache_key_changes_when_source_metadata_changes() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("source.png");
        fs::write(&source, b"first").unwrap();
        let first_metadata = fs::metadata(&source).unwrap();
        let first = thumbnail_cache_key(&source, &first_metadata).unwrap();

        fs::write(&source, b"second-and-longer").unwrap();
        let second_metadata = fs::metadata(&source).unwrap();
        let second = thumbnail_cache_key(&source, &second_metadata).unwrap();

        assert_ne!(first, second);
    }

    #[test]
    fn isolates_thumbnail_namespaces_for_unrelated_main_files() {
        let workspace = tempfile::tempdir().unwrap();
        let first = workspace.path().join("first.typ");
        let second = workspace.path().join("chapters/second.typ");
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        fs::write(&first, "= First").unwrap();
        fs::write(&second, "= Second").unwrap();

        let first_namespace = thumbnail_document_namespace(workspace.path(), &first).unwrap();
        let second_namespace = thumbnail_document_namespace(workspace.path(), &second).unwrap();

        assert_ne!(first_namespace, second_namespace);
        assert_eq!(
            first_namespace,
            thumbnail_document_namespace(workspace.path(), &first).unwrap()
        );
        assert_eq!(first_namespace.len(), 24);
        assert_eq!(second_namespace.len(), 24);
    }

    #[test]
    fn rejects_thumbnail_namespaces_outside_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let main = external.path().join("main.typ");
        fs::write(&main, "= External").unwrap();

        assert!(thumbnail_document_namespace(workspace.path(), &main).is_err());
    }
}
