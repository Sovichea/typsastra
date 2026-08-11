use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledFontResult {
    pub directory: PathBuf,
    pub family: String,
    pub scale: f32,
    pub generated_files: Vec<String>,
    pub changed: bool,
    pub alias: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledFontRequest {
    pub family: String,
    pub scale: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledFontSetStatus {
    pub update_required: bool,
    pub generation_required: bool,
    pub variant_limit_warnings: Vec<FontVariantLimitWarning>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontVariantLimitWarning {
    pub family: String,
    pub cached_variants: usize,
    pub requested_scale: f32,
    pub recommended_limit: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledFontVariantIdentity {
    pub family: String,
    pub scale: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledFontCacheVariant {
    pub family: String,
    pub scale: f32,
    pub bytes: u64,
    pub file_count: usize,
    pub generated_at_ms: Option<u64>,
    pub last_used_at_ms: Option<u64>,
    pub source_status: String,
    pub workspace_references: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledFontCacheReport {
    pub root: PathBuf,
    pub total_bytes: u64,
    pub variants: Vec<ScaledFontCacheVariant>,
}

pub const RECOMMENDED_VARIANTS_PER_FONT_FACE: usize = 10;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFontRequest {
    pub family: String,
    pub percent: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFontRecord {
    pub family: String,
    pub alias: String,
    pub percent: u16,
    pub source_status: String,
    pub active: bool,
    pub generated_at_ms: Option<u64>,
}

pub fn prepared_alias(family: &str, percent: u16) -> Result<String, String> {
    let family = family.trim();
    if family.is_empty() {
        return Err("A source font family is required.".into());
    }
    if !(50..=200).contains(&percent) {
        return Err("Prepared font scale must be a whole percent between 50 and 200.".into());
    }
    Ok(if percent == 100 {
        family.to_string()
    } else {
        format!("{family} {percent}")
    })
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFontSelection {
    version: u32,
    fonts: Vec<ScaledFontRequest>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaledFontManifest {
    version: u32,
    family: String,
    #[serde(default)]
    alias: String,
    scale: f32,
    files: Vec<String>,
    #[serde(default)]
    generated_at_ms: Option<u64>,
    #[serde(default)]
    last_used_at_ms: Option<u64>,
    #[serde(default)]
    sources: Vec<ScaledFontSource>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaledFontSource {
    path: Option<PathBuf>,
    bytes: u64,
    modified_at_ms: Option<u64>,
}

fn validate_request(workspace_root: &Path, family: &str, scale: f32) -> Result<(), String> {
    if family.trim().is_empty() {
        return Err("A document font family is required.".into());
    }
    if !scale.is_finite() || !(0.5..=2.0).contains(&scale) {
        return Err("Document font scale must be between 0.5 and 2.0.".into());
    }
    if !workspace_root.is_dir() {
        return Err("The workspace root does not exist.".into());
    }
    Ok(())
}

fn current_manifest(generated_dir: &Path) -> Option<ScaledFontManifest> {
    let manifest: ScaledFontManifest =
        serde_json::from_slice(&fs::read(generated_dir.join("manifest.json")).ok()?).ok()?;
    manifest
        .files
        .iter()
        .all(|file| generated_dir.join(file).is_file())
        .then_some(manifest)
}

fn system_time_ms(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn now_ms() -> u64 {
    system_time_ms(SystemTime::now()).unwrap_or(0)
}

fn source_metadata(path: Option<&Path>, bytes: usize) -> ScaledFontSource {
    let metadata = path.and_then(|path| fs::metadata(path).ok());
    ScaledFontSource {
        path: path.map(Path::to_path_buf),
        bytes: metadata.as_ref().map_or(bytes as u64, fs::Metadata::len),
        modified_at_ms: metadata
            .and_then(|metadata| metadata.modified().ok())
            .and_then(system_time_ms),
    }
}

pub fn global_scaled_font_root(app_local_data_dir: &Path) -> PathBuf {
    app_local_data_dir.join("font-cache").join("scaled")
}

fn path_hash(path: &Path) -> u64 {
    let normalized = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in normalized.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn selection_path(cache_root: &Path, workspace_root: &Path) -> PathBuf {
    cache_root
        .join("workspaces")
        .join(format!("{:016x}.json", path_hash(workspace_root)))
}

fn generated_family_dir(cache_root: &Path, family: &str, scale: f32) -> PathBuf {
    let normalized_family = family.to_ascii_lowercase();
    generated_family_root(cache_root, &normalized_family).join(format!("{:08x}", scale.to_bits()))
}

fn generated_family_root(cache_root: &Path, normalized_family: &str) -> PathBuf {
    cache_root.join("variants").join(format!(
        "{}-{:016x}",
        safe_file_stem(&normalized_family),
        stable_hash(normalized_family.as_bytes(), 0, 1.0)
    ))
}

fn cached_variant_count(cache_root: &Path, family: &str) -> usize {
    let root = generated_family_root(cache_root, &family.to_ascii_lowercase());
    fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir() && current_manifest(&entry.path()).is_some())
        .count()
}

fn requested_scaled_fonts(
    workspace_root: &Path,
    requests: &[ScaledFontRequest],
) -> Result<Vec<ScaledFontRequest>, String> {
    let mut requested = std::collections::BTreeMap::<(String, u32), ScaledFontRequest>::new();
    for request in requests {
        validate_request(workspace_root, &request.family, request.scale)?;
        if (request.scale - 1.0).abs() > 0.0001 {
            requested.insert(
                (request.family.to_lowercase(), request.scale.to_bits()),
                request.clone(),
            );
        }
    }
    Ok(requested.into_values().collect())
}

fn current_selection(cache_root: &Path, workspace_root: &Path) -> Vec<ScaledFontRequest> {
    serde_json::from_slice::<WorkspaceFontSelection>(
        &fs::read(selection_path(cache_root, workspace_root)).unwrap_or_default(),
    )
    .map(|selection| selection.fonts)
    .unwrap_or_default()
}

fn same_requests(left: &[ScaledFontRequest], right: &[ScaledFontRequest]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(left, right)| {
            left.family.eq_ignore_ascii_case(&right.family)
                && (left.scale - right.scale).abs() <= 0.0001
        })
}

pub fn scaled_workspace_font_update_required(
    cache_root: &Path,
    workspace_root: &Path,
    family: &str,
    scale: f32,
) -> Result<bool, String> {
    validate_request(workspace_root, family, scale)?;
    if (scale - 1.0).abs() <= 0.0001 {
        return Ok(false);
    }
    let generated_dir = generated_family_dir(cache_root, family, scale);
    let Some(manifest) = current_manifest(&generated_dir) else {
        return Ok(true);
    };
    Ok(!manifest.family.eq_ignore_ascii_case(family)
        || (manifest.scale - scale).abs() > 0.0001
        || manifest_source_status(&manifest) == "changed")
}

pub fn scaled_workspace_font_set_update_required(
    cache_root: &Path,
    workspace_root: &Path,
    requests: &[ScaledFontRequest],
) -> Result<bool, String> {
    Ok(scaled_workspace_font_set_status(cache_root, workspace_root, requests)?.update_required)
}

pub fn scaled_workspace_font_set_status(
    cache_root: &Path,
    workspace_root: &Path,
    requests: &[ScaledFontRequest],
) -> Result<ScaledFontSetStatus, String> {
    let desired = requested_scaled_fonts(workspace_root, requests)?;
    let generation_required = desired.iter().any(|request| {
        scaled_workspace_font_update_required(
            cache_root,
            workspace_root,
            &request.family,
            request.scale,
        )
        .unwrap_or(true)
    });
    let variant_limit_warnings = desired
        .iter()
        .filter(|request| {
            scaled_workspace_font_update_required(
                cache_root,
                workspace_root,
                &request.family,
                request.scale,
            )
            .unwrap_or(true)
        })
        .filter_map(|request| {
            let cached_variants = cached_variant_count(cache_root, &request.family);
            (cached_variants >= RECOMMENDED_VARIANTS_PER_FONT_FACE).then(|| {
                FontVariantLimitWarning {
                    family: request.family.clone(),
                    cached_variants,
                    requested_scale: request.scale,
                    recommended_limit: RECOMMENDED_VARIANTS_PER_FONT_FACE,
                }
            })
        })
        .collect();
    let selection_changed =
        !same_requests(&desired, &current_selection(cache_root, workspace_root));
    Ok(ScaledFontSetStatus {
        update_required: selection_changed || generation_required,
        generation_required,
        variant_limit_warnings,
    })
}

fn safe_file_stem(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    value.trim_matches('-').to_string()
}

fn stable_hash(bytes: &[u8], face_index: u32, scale: f32) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes
        .iter()
        .copied()
        .chain(face_index.to_be_bytes())
        .chain(scale.to_bits().to_be_bytes())
    {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn read_source(source: &fontdb::Source) -> Result<(Vec<u8>, Option<&Path>), String> {
    match source {
        fontdb::Source::File(path) => fs::read(path)
            .map(|bytes| (bytes, Some(path.as_path())))
            .map_err(|error| format!("Failed to read {}: {error}", path.display())),
        fontdb::Source::Binary(bytes) => Ok((bytes.as_ref().as_ref().to_vec(), None)),
        fontdb::Source::SharedFile(path, bytes) => {
            Ok((bytes.as_ref().as_ref().to_vec(), Some(path.as_path())))
        }
    }
}

pub fn prepare_scaled_workspace_font(
    cache_root: &Path,
    workspace_root: &Path,
    family: &str,
    scale: f32,
    private_font_directories: &[PathBuf],
) -> Result<ScaledFontResult, String> {
    validate_request(workspace_root, family, scale)?;

    let generated_dir = generated_family_dir(cache_root, family, scale);
    if !scaled_workspace_font_update_required(cache_root, workspace_root, family, scale)? {
        let cached = current_manifest(&generated_dir);
        let generated_files = cached
            .as_ref()
            .map(|manifest| manifest.files.clone())
            .unwrap_or_default();
        let alias = cached
            .map(|manifest| {
                if manifest.alias.is_empty() {
                    prepared_alias(family, (scale * 100.0).round() as u16)
                        .unwrap_or_else(|_| family.to_string())
                } else {
                    manifest.alias
                }
            })
            .unwrap_or_else(|| family.to_string());
        return Ok(ScaledFontResult {
            directory: generated_dir,
            family: family.to_string(),
            scale,
            generated_files,
            changed: false,
            alias,
        });
    }
    if generated_dir.exists() {
        fs::remove_dir_all(&generated_dir)
            .map_err(|error| format!("Failed to replace {}: {error}", generated_dir.display()))?;
    }
    if (scale - 1.0).abs() <= 0.0001 {
        return Ok(ScaledFontResult {
            directory: generated_dir,
            family: family.to_string(),
            scale,
            generated_files: Vec::new(),
            changed: true,
            alias: family.to_string(),
        });
    }
    fs::create_dir_all(&generated_dir)
        .map_err(|error| format!("Failed to create {}: {error}", generated_dir.display()))?;

    let mut generated_files = Vec::new();
    let mut sources = Vec::new();
    if (scale - 1.0).abs() > 0.0001 {
        let mut database = fontdb::Database::new();
        database.load_system_fonts();
        for directory in private_font_directories {
            if directory.is_dir() {
                database.load_fonts_dir(directory);
            }
        }
        let faces: Vec<_> = database
            .faces()
            .filter(|face| {
                face.families
                    .iter()
                    .any(|(candidate, _)| candidate.eq_ignore_ascii_case(family))
            })
            .cloned()
            .collect();
        if faces.is_empty() {
            return Err(format!(
                "The system or private local font family {family:?} could not be located."
            ));
        }

        let mut written_sources = BTreeSet::new();
        for face in faces {
            let (bytes, source_path) = read_source(&face.source)?;
            let source_key = source_path
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| format!("binary-{}", stable_hash(&bytes, face.index, 1.0)));
            if !written_sources.insert(source_key) {
                continue;
            }
            sources.push(source_metadata(source_path, bytes.len()));
            if face.index != 0 || bytes.get(..4) == Some(b"ttcf") {
                return Err(format!(
                    "{family:?} is stored in a font collection. Select an individual TTF or OTF face for scaling."
                ));
            }
            let alias = prepared_alias(family, (scale * 100.0).round() as u16)?;
            let scaled = typsastra_font_scaler::scale_and_rename_font(&bytes, scale, &alias)
                .map_err(|error| format!("Failed to scale {family:?}: {error}"))?;
            let extension = source_path
                .and_then(Path::extension)
                .and_then(|extension| extension.to_str())
                .filter(|extension| {
                    matches!(extension.to_ascii_lowercase().as_str(), "ttf" | "otf")
                })
                .unwrap_or("ttf");
            let file_name = format!(
                "{}-{:016x}.{}",
                safe_file_stem(family),
                stable_hash(&bytes, face.index, scale),
                extension
            );
            let destination = generated_dir.join(&file_name);
            let mut temporary = tempfile::NamedTempFile::new_in(&generated_dir)
                .map_err(|error| format!("Failed to stage scaled font: {error}"))?;
            std::io::Write::write_all(&mut temporary, &scaled)
                .map_err(|error| format!("Failed to write scaled font: {error}"))?;
            temporary
                .persist(&destination)
                .map_err(|error| format!("Failed to install scaled font: {}", error.error))?;
            generated_files.push(file_name);
        }
    }

    let generated_at_ms = now_ms();
    let manifest = ScaledFontManifest {
        version: 2,
        family: family.to_string(),
        alias: prepared_alias(family, (scale * 100.0).round() as u16)?,
        scale,
        files: generated_files.clone(),
        generated_at_ms: Some(generated_at_ms),
        last_used_at_ms: Some(generated_at_ms),
        sources,
    };
    fs::write(
        generated_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Failed to write scaled-font manifest: {error}"))?;

    Ok(ScaledFontResult {
        directory: generated_dir,
        family: family.to_string(),
        scale,
        generated_files,
        changed: true,
        alias: prepared_alias(family, (scale * 100.0).round() as u16)?,
    })
}

pub fn prepare_named_workspace_font(
    cache_root: &Path,
    workspace_root: &Path,
    request: &PreparedFontRequest,
    private_font_directories: &[PathBuf],
) -> Result<ScaledFontResult, String> {
    let alias = prepared_alias(&request.family, request.percent)?;
    if request.percent == 100 {
        return Ok(ScaledFontResult {
            directory: PathBuf::new(),
            family: request.family.clone(),
            scale: 1.0,
            generated_files: Vec::new(),
            changed: false,
            alias,
        });
    }
    prepare_scaled_workspace_font(
        cache_root,
        workspace_root,
        &request.family,
        request.percent as f32 / 100.0,
        private_font_directories,
    )
}

pub fn prepared_font_library(cache_root: &Path, workspace_root: &Path) -> Vec<PreparedFontRecord> {
    let active = current_selection(cache_root, workspace_root);
    let mut records = Vec::new();
    for family_dir in fs::read_dir(cache_root.join("variants"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
    {
        for variant_dir in fs::read_dir(family_dir.path())
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            let Some(manifest) = current_manifest(&variant_dir.path()) else {
                continue;
            };
            let percent = (manifest.scale * 100.0).round() as u16;
            let alias = if manifest.alias.is_empty() {
                prepared_alias(&manifest.family, percent)
                    .unwrap_or_else(|_| manifest.family.clone())
            } else {
                manifest.alias.clone()
            };
            records.push(PreparedFontRecord {
                active: active.iter().any(|font| {
                    font.family.eq_ignore_ascii_case(&manifest.family)
                        && (font.scale - manifest.scale).abs() < 0.0001
                }),
                family: manifest.family.clone(),
                alias,
                percent,
                source_status: manifest_source_status(&manifest).to_string(),
                generated_at_ms: manifest.generated_at_ms,
            });
        }
    }
    for selection in &active {
        let already_listed = records.iter().any(|record| {
            record.family.eq_ignore_ascii_case(&selection.family)
                && ((record.percent as f32 / 100.0) - selection.scale).abs() < 0.0001
        });
        if already_listed {
            continue;
        }
        let percent = (selection.scale * 100.0).round() as u16;
        records.push(PreparedFontRecord {
            family: selection.family.clone(),
            alias: prepared_alias(&selection.family, percent)
                .unwrap_or_else(|_| selection.family.clone()),
            percent,
            source_status: "missing".into(),
            active: true,
            generated_at_ms: None,
        });
    }
    records.sort_by(|left, right| left.alias.to_lowercase().cmp(&right.alias.to_lowercase()));
    records
}

pub fn prepared_font_directory(cache_root: &Path, alias: &str) -> Option<PathBuf> {
    for family_dir in fs::read_dir(cache_root.join("variants"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
    {
        for variant_dir in fs::read_dir(family_dir.path())
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            let Some(manifest) = current_manifest(&variant_dir.path()) else {
                continue;
            };
            let percent = (manifest.scale * 100.0).round() as u16;
            let candidate = if manifest.alias.is_empty() {
                let Ok(alias) = prepared_alias(&manifest.family, percent) else {
                    continue;
                };
                alias
            } else {
                manifest.alias
            };
            if candidate.eq_ignore_ascii_case(alias) {
                return Some(variant_dir.path());
            }
        }
    }
    None
}

pub fn activate_scaled_workspace_fonts(
    cache_root: &Path,
    workspace_root: &Path,
    requests: &[ScaledFontRequest],
) -> Result<bool, String> {
    let desired = requested_scaled_fonts(workspace_root, requests)?;
    for request in &desired {
        if scaled_workspace_font_update_required(
            cache_root,
            workspace_root,
            &request.family,
            request.scale,
        )? {
            return Err(format!(
                "The global scaled-font cache for {:?} at {}x is not ready.",
                request.family, request.scale
            ));
        }
    }
    let changed = !same_requests(&desired, &current_selection(cache_root, workspace_root));
    if !changed {
        return Ok(false);
    }
    let path = selection_path(cache_root, workspace_root);
    if desired.is_empty() {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("Failed to clear {}: {error}", path.display()))?;
        }
        return Ok(true);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    fs::write(
        &path,
        serde_json::to_vec_pretty(&WorkspaceFontSelection {
            version: 1,
            fonts: desired,
        })
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(true)
}

pub fn workspace_font_directories(cache_root: &Path, workspace_root: &Path) -> Vec<PathBuf> {
    current_selection(cache_root, workspace_root)
        .into_iter()
        .map(|request| generated_family_dir(cache_root, &request.family, request.scale))
        .filter(|directory| {
            let Some(mut manifest) = current_manifest(directory) else {
                return false;
            };
            let now = now_ms();
            if manifest.last_used_at_ms.map_or(true, |last_used| {
                now.saturating_sub(last_used) >= 60 * 60 * 1000
            }) {
                manifest.last_used_at_ms = Some(now);
                let _ = fs::write(
                    directory.join("manifest.json"),
                    serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
                );
            }
            true
        })
        .collect()
}

fn variant_key(family: &str, scale: f32) -> (String, u32) {
    (family.to_lowercase(), scale.to_bits())
}

fn workspace_variant_references(
    cache_root: &Path,
) -> std::collections::BTreeMap<(String, u32), usize> {
    let mut references = std::collections::BTreeMap::new();
    let root = cache_root.join("workspaces");
    for entry in fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
    {
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(selection) = serde_json::from_slice::<WorkspaceFontSelection>(&bytes) else {
            continue;
        };
        for font in selection.fonts {
            *references
                .entry(variant_key(&font.family, font.scale))
                .or_insert(0) += 1;
        }
    }
    references
}

fn directory_size(path: &Path) -> (u64, usize) {
    let mut bytes = 0;
    let mut files = 0;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if let Ok(metadata) = entry.metadata() {
                bytes += metadata.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

fn manifest_source_status(manifest: &ScaledFontManifest) -> &'static str {
    if manifest.sources.is_empty() || manifest.sources.iter().all(|source| source.path.is_none()) {
        return "unknown";
    }
    let mut changed = false;
    for source in &manifest.sources {
        let Some(path) = &source.path else {
            continue;
        };
        let Ok(metadata) = fs::metadata(path) else {
            return "missing";
        };
        let modified_at_ms = metadata.modified().ok().and_then(system_time_ms);
        if metadata.len() != source.bytes || modified_at_ms != source.modified_at_ms {
            changed = true;
        }
    }
    if changed {
        "changed"
    } else {
        "current"
    }
}

pub fn inspect_scaled_font_cache(cache_root: &Path) -> ScaledFontCacheReport {
    let references = workspace_variant_references(cache_root);
    let mut variants = Vec::new();
    let variants_root = cache_root.join("variants");
    for family_entry in fs::read_dir(&variants_root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
    {
        for variant_entry in fs::read_dir(family_entry.path())
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            let directory = variant_entry.path();
            let Some(manifest) = current_manifest(&directory) else {
                continue;
            };
            let (bytes, file_count) = directory_size(&directory);
            let generated_at_ms = manifest.generated_at_ms.or_else(|| {
                fs::metadata(&directory)
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(system_time_ms)
            });
            variants.push(ScaledFontCacheVariant {
                workspace_references: references
                    .get(&variant_key(&manifest.family, manifest.scale))
                    .copied()
                    .unwrap_or(0),
                source_status: manifest_source_status(&manifest).to_string(),
                family: manifest.family,
                scale: manifest.scale,
                bytes,
                file_count,
                generated_at_ms,
                last_used_at_ms: manifest.last_used_at_ms,
            });
        }
    }
    variants.sort_by(|left, right| {
        left.family
            .to_lowercase()
            .cmp(&right.family.to_lowercase())
            .then_with(|| left.scale.total_cmp(&right.scale))
    });
    ScaledFontCacheReport {
        root: cache_root.to_path_buf(),
        total_bytes: variants.iter().map(|variant| variant.bytes).sum(),
        variants,
    }
}

pub fn delete_scaled_font_variants(
    cache_root: &Path,
    variants: &[ScaledFontVariantIdentity],
) -> Result<usize, String> {
    let mut deleted = 0;
    for variant in variants {
        if variant.family.trim().is_empty()
            || !variant.scale.is_finite()
            || !(0.5..=2.0).contains(&variant.scale)
        {
            return Err("The scaled-font variant identity is invalid.".into());
        }
        let directory = generated_family_dir(cache_root, &variant.family, variant.scale);
        if directory.exists() {
            fs::remove_dir_all(&directory)
                .map_err(|error| format!("Failed to remove {}: {error}", directory.display()))?;
            if let Some(parent) = directory.parent() {
                if fs::read_dir(parent)
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(false)
                {
                    let _ = fs::remove_dir(parent);
                }
            }
            deleted += 1;
        }
    }
    Ok(deleted)
}

pub fn delete_unused_scaled_font_variants(cache_root: &Path) -> Result<usize, String> {
    let report = inspect_scaled_font_cache(cache_root);
    let unused = report
        .variants
        .into_iter()
        .filter(|variant| variant.workspace_references == 0)
        .map(|variant| ScaledFontVariantIdentity {
            family: variant.family,
            scale: variant.scale,
        })
        .collect::<Vec<_>>();
    delete_scaled_font_variants(cache_root, &unused)
}

pub fn renew_scaled_font_variant(
    cache_root: &Path,
    generation_root: &Path,
    family: &str,
    scale: f32,
    private_font_directories: &[PathBuf],
) -> Result<ScaledFontResult, String> {
    let directory = generated_family_dir(cache_root, family, scale);
    let mut font_directories = private_font_directories.to_vec();
    if let Some(manifest) = current_manifest(&directory) {
        for source in manifest.sources {
            let Some(parent) = source
                .path
                .and_then(|path| path.parent().map(Path::to_path_buf))
            else {
                continue;
            };
            if !font_directories.contains(&parent) {
                font_directories.push(parent);
            }
        }
    }
    if directory.exists() {
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("Failed to renew {}: {error}", directory.display()))?;
    }
    prepare_scaled_workspace_font(
        cache_root,
        generation_root,
        family,
        scale,
        &font_directories,
    )
}

pub fn remove_legacy_workspace_fonts(workspace_root: &Path) -> Result<bool, String> {
    let fonts = workspace_root.join(".typsastra").join("fonts");
    if !fonts.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&fonts).map_err(|error| {
        format!(
            "Failed to remove legacy project font cache {}: {error}",
            fonts.display()
        )
    })?;
    Ok(true)
}

pub fn clear_scaled_workspace_fonts(
    cache_root: &Path,
    workspace_root: &Path,
) -> Result<bool, String> {
    if !workspace_root.is_dir() {
        return Err("The workspace root does not exist.".into());
    }
    let mut changed = remove_legacy_workspace_fonts(workspace_root)?;
    let selection = selection_path(cache_root, workspace_root);
    if selection.exists() {
        fs::remove_file(&selection)
            .map_err(|error| format!("Failed to remove {}: {error}", selection.display()))?;
        changed = true;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_aliases_are_deterministic_and_bounded() {
        assert_eq!(prepared_alias("Moul", 95).unwrap(), "Moul 95");
        assert_eq!(prepared_alias("  Moul  ", 100).unwrap(), "Moul");
        assert!(prepared_alias("Moul", 49).is_err());
        assert!(prepared_alias("Moul", 201).is_err());
        assert!(prepared_alias("   ", 95).is_err());
    }

    fn seed_variant(cache: &Path, family: &str, scale: f32) -> PathBuf {
        let generated = generated_family_dir(cache, family, scale);
        fs::create_dir_all(&generated).unwrap();
        fs::write(generated.join("cached.ttf"), b"font").unwrap();
        fs::write(
            generated.join("manifest.json"),
            serde_json::json!({
                "version": 1,
                "family": family,
                "scale": scale,
                "files": ["cached.ttf"]
            })
            .to_string(),
        )
        .unwrap();
        generated
    }

    #[test]
    fn unit_scale_is_a_noop_without_generated_fonts() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        assert!(!scaled_workspace_font_update_required(
            cache.path(),
            workspace.path(),
            "MiSans Khmer",
            1.0
        )
        .unwrap());
        let result =
            prepare_scaled_workspace_font(cache.path(), workspace.path(), "MiSans Khmer", 1.0, &[])
                .unwrap();
        assert!(!result.changed);
        assert!(result.generated_files.is_empty());
        assert!(!result.directory.exists());
    }

    #[test]
    fn cached_variants_survive_workspace_selection_changes() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let generated = seed_variant(cache.path(), "MiSans Khmer", 1.2);
        activate_scaled_workspace_fonts(
            cache.path(),
            workspace.path(),
            &[ScaledFontRequest {
                family: "MiSans Khmer".into(),
                scale: 1.2,
            }],
        )
        .unwrap();
        clear_scaled_workspace_fonts(cache.path(), workspace.path()).unwrap();
        assert!(generated.exists());
        assert!(workspace_font_directories(cache.path(), workspace.path()).is_empty());
    }

    #[test]
    fn prepared_library_reports_active_missing_variants() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let generated = seed_variant(cache.path(), "Moul", 0.95);
        activate_scaled_workspace_fonts(
            cache.path(),
            workspace.path(),
            &[ScaledFontRequest {
                family: "Moul".into(),
                scale: 0.95,
            }],
        )
        .unwrap();
        fs::remove_dir_all(generated).unwrap();

        let library = prepared_font_library(cache.path(), workspace.path());
        assert_eq!(library.len(), 1);
        assert_eq!(library[0].family, "Moul");
        assert_eq!(library[0].alias, "Moul 95");
        assert_eq!(library[0].percent, 95);
        assert_eq!(library[0].source_status, "missing");
        assert!(library[0].active);
    }

    #[test]
    fn cache_report_includes_usage_and_workspace_references() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        seed_variant(cache.path(), "MiSans Khmer", 1.2);
        activate_scaled_workspace_fonts(
            cache.path(),
            workspace.path(),
            &[ScaledFontRequest {
                family: "MiSans Khmer".into(),
                scale: 1.2,
            }],
        )
        .unwrap();

        let report = inspect_scaled_font_cache(cache.path());
        assert_eq!(report.variants.len(), 1);
        assert!(report.total_bytes > 0);
        assert_eq!(report.variants[0].family, "MiSans Khmer");
        assert_eq!(report.variants[0].workspace_references, 1);
        assert_eq!(report.variants[0].source_status, "unknown");
    }

    #[test]
    fn unused_cleanup_preserves_referenced_variants() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let retained = seed_variant(cache.path(), "MiSans Khmer", 1.2);
        let removed = seed_variant(cache.path(), "MiSans Khmer", 0.9);
        activate_scaled_workspace_fonts(
            cache.path(),
            workspace.path(),
            &[ScaledFontRequest {
                family: "MiSans Khmer".into(),
                scale: 1.2,
            }],
        )
        .unwrap();

        assert_eq!(delete_unused_scaled_font_variants(cache.path()).unwrap(), 1);
        assert!(retained.exists());
        assert!(!removed.exists());
    }

    #[test]
    fn matching_global_variant_is_reused_across_workspaces() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let other_workspace = tempfile::tempdir().unwrap();
        let generated = seed_variant(cache.path(), "MiSans Khmer", 1.2);
        let matching = [ScaledFontRequest {
            family: "MiSans Khmer".into(),
            scale: 1.2,
        }];
        let status =
            scaled_workspace_font_set_status(cache.path(), workspace.path(), &matching).unwrap();
        assert!(status.update_required);
        assert!(!status.generation_required);
        activate_scaled_workspace_fonts(cache.path(), workspace.path(), &matching).unwrap();
        activate_scaled_workspace_fonts(cache.path(), other_workspace.path(), &matching).unwrap();
        assert_eq!(
            workspace_font_directories(cache.path(), workspace.path()),
            vec![generated.clone()]
        );
        assert_eq!(
            workspace_font_directories(cache.path(), other_workspace.path()),
            vec![generated]
        );
        assert!(!workspace.path().join(".typsastra/fonts").exists());
        assert!(!other_workspace.path().join(".typsastra/fonts").exists());
    }

    #[test]
    fn warns_before_creating_an_eleventh_variant_for_a_font_face() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        for index in 0..RECOMMENDED_VARIANTS_PER_FONT_FACE {
            seed_variant(cache.path(), "MiSans Khmer", 0.8 + index as f32 * 0.01);
        }

        let requested = [ScaledFontRequest {
            family: "MiSans Khmer".into(),
            scale: 1.2,
        }];
        let status =
            scaled_workspace_font_set_status(cache.path(), workspace.path(), &requested).unwrap();
        assert!(status.generation_required);
        assert_eq!(status.variant_limit_warnings.len(), 1);
        let warning = &status.variant_limit_warnings[0];
        assert_eq!(warning.family, "MiSans Khmer");
        assert_eq!(warning.cached_variants, RECOMMENDED_VARIANTS_PER_FONT_FACE);
        assert_eq!(
            warning.recommended_limit,
            RECOMMENDED_VARIANTS_PER_FONT_FACE
        );
        assert!((warning.requested_scale - 1.2).abs() < 0.0001);

        let cached = [ScaledFontRequest {
            family: "MiSans Khmer".into(),
            scale: 0.8,
        }];
        let cached_status =
            scaled_workspace_font_set_status(cache.path(), workspace.path(), &cached).unwrap();
        assert!(!cached_status.generation_required);
        assert!(cached_status.variant_limit_warnings.is_empty());
    }

    #[test]
    fn allows_multiple_prepared_variants_for_one_internal_family() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let requests = [
            ScaledFontRequest {
                family: "Shared Family".into(),
                scale: 0.9,
            },
            ScaledFontRequest {
                family: "Shared Family".into(),
                scale: 1.0,
            },
        ];
        assert!(scaled_workspace_font_set_update_required(
            cache.path(),
            workspace.path(),
            &requests
        )
        .unwrap());
    }

    #[test]
    fn removes_legacy_project_font_bytes() {
        let workspace = tempfile::tempdir().unwrap();
        let legacy = workspace.path().join(".typsastra/fonts/generated");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("licensed.ttf"), b"font").unwrap();
        assert!(remove_legacy_workspace_fonts(workspace.path()).unwrap());
        assert!(!workspace.path().join(".typsastra/fonts").exists());
    }
}
