use ignore::WalkBuilder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

/// Project text search never loads a source larger than this into memory.
pub const PROJECT_TEXT_MAX_BYTES: u64 = 10 * 1024 * 1024;
const BINARY_PROBE_BYTES: usize = 64 * 1024;

static CANCELLED_REQUESTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_requests() -> &'static Mutex<HashSet<String>> {
    CANCELLED_REQUESTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn request_cancelled(request_id: &str) -> bool {
    cancelled_requests()
        .lock()
        .map(|requests| requests.contains(request_id))
        .unwrap_or(false)
}

fn clear_cancelled_request(request_id: &str) {
    if let Ok(mut requests) = cancelled_requests().lock() {
        requests.remove(request_id);
    }
}

#[tauri::command]
pub fn cancel_project_text_request(request_id: String) {
    if let Ok(mut requests) = cancelled_requests().lock() {
        if requests.len() >= 512 {
            requests.clear();
        }
        requests.insert(request_id);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextFileInfo {
    pub path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectTextSkipReason {
    TooLarge,
    Binary,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextSkippedFile {
    pub path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub reason: ProjectTextSkipReason,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextInventory {
    pub workspace_root_path: String,
    pub include_ignored: bool,
    pub files: Vec<ProjectTextFileInfo>,
    pub skipped: Vec<ProjectTextSkippedFile>,
    pub binary_file_count: usize,
    pub too_large_file_count: usize,
    pub unreadable_file_count: usize,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectTextLineEnding {
    None,
    Lf,
    Crlf,
    Cr,
    Mixed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextReadResult {
    pub path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub revision: Option<String>,
    pub text: Option<String>,
    pub has_bom: bool,
    pub line_ending: ProjectTextLineEnding,
    pub skip_reason: Option<ProjectTextSkipReason>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextRevisionInfo {
    pub path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub revision: Option<String>,
    pub skip_reason: Option<ProjectTextSkipReason>,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn project_text_inventory(
    request_id: String,
    workspace_root_path: String,
    include_ignored: bool,
) -> Result<ProjectTextInventory, String> {
    tokio::task::spawn_blocking(move || {
        project_text_inventory_blocking(&request_id, &workspace_root_path, include_ignored)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_text_read(
    workspace_root_path: String,
    path: String,
) -> Result<ProjectTextReadResult, String> {
    tokio::task::spawn_blocking(move || project_text_read_blocking(&workspace_root_path, &path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_text_revision(
    workspace_root_path: String,
    path: String,
) -> Result<ProjectTextRevisionInfo, String> {
    tokio::task::spawn_blocking(move || project_text_revision_blocking(&workspace_root_path, &path))
        .await
        .map_err(|error| error.to_string())?
}

fn canonical_root(workspace_root_path: &str) -> Result<PathBuf, String> {
    let root = dunce::canonicalize(workspace_root_path)
        .map_err(|error| format!("Failed to resolve the workspace: {error}"))?;
    if !root.is_dir() {
        return Err("The workspace root is not a directory.".to_string());
    }
    Ok(root)
}

fn canonical_workspace_file(
    workspace_root_path: &str,
    path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_root(workspace_root_path)?;
    let file = dunce::canonicalize(path)
        .map_err(|error| format!("Failed to resolve the file: {error}"))?;
    if !file.starts_with(&root) {
        return Err("The file is outside the active workspace.".to_string());
    }
    if !file.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    Ok((root, file))
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn is_excluded_directory(entry: &ignore::DirEntry) -> bool {
    if !entry
        .file_type()
        .is_some_and(|file_type| file_type.is_dir())
    {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some(".git" | ".hg" | ".svn" | ".typsastra" | ".typstella")
    )
}

fn is_known_binary_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "bmp"
            | "avif"
            | "tif"
            | "tiff"
            | "heic"
            | "pdf"
            | "ttf"
            | "otf"
            | "woff"
            | "woff2"
            | "ttc"
            | "eot"
            | "zip"
            | "gz"
            | "tar"
            | "rar"
            | "7z"
            | "bz2"
            | "xz"
            | "zst"
            | "docx"
            | "xlsx"
            | "pptx"
            | "epub"
            | "mp3"
            | "wav"
            | "ogg"
            | "flac"
            | "m4a"
            | "aac"
            | "mp4"
            | "mov"
            | "avi"
            | "mkv"
            | "webm"
            | "exe"
            | "dll"
            | "so"
            | "dylib"
            | "bin"
            | "obj"
            | "o"
            | "a"
            | "lib"
            | "class"
            | "jar"
            | "wasm"
            | "db"
            | "sqlite"
            | "sqlite3"
    )
}

fn file_extension(path: &Path) -> &str {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
}

fn probe_plain_text(path: &Path, size_bytes: u64) -> Result<bool, String> {
    let limit = size_bytes.min(BINARY_PROBE_BYTES as u64) as usize;
    let mut bytes = Vec::with_capacity(limit);
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    file.take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    // A fixed-size probe can end in the middle of a multi-byte UTF-8 code
    // point. Trim at most one incomplete trailing character before rejecting
    // an otherwise valid text file.
    if size_bytes > BINARY_PROBE_BYTES as u64 {
        for _ in 0..3 {
            if std::str::from_utf8(&bytes).is_ok() {
                break;
            }
            bytes.pop();
        }
    }
    Ok(crate::is_probably_plain_text_bytes(&bytes))
}

pub fn project_text_inventory_blocking(
    request_id: &str,
    workspace_root_path: &str,
    include_ignored: bool,
) -> Result<ProjectTextInventory, String> {
    clear_cancelled_request(request_id);
    let root = canonical_root(workspace_root_path)?;
    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .parents(true);
    if include_ignored {
        builder
            .standard_filters(false)
            .hidden(false)
            .parents(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false);
    } else {
        builder
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .ignore(true);
    }
    builder.filter_entry(is_excluded_directory);

    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut binary_file_count = 0usize;
    let mut too_large_file_count = 0usize;
    let mut unreadable_file_count = 0usize;
    let mut cancelled = false;

    for entry in builder.build() {
        if request_cancelled(request_id) {
            cancelled = true;
            break;
        }
        let Ok(entry) = entry else {
            continue;
        };
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(path) else {
            continue;
        };
        // Directory symlinks are never traversed. File symlinks are skipped as
        // well so search cannot escape the workspace through a link.
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let size_bytes = metadata.len();
        let relative = relative_path(&root, path);
        if size_bytes > PROJECT_TEXT_MAX_BYTES {
            too_large_file_count += 1;
            skipped.push(ProjectTextSkippedFile {
                path: path.to_string_lossy().to_string(),
                relative_path: relative,
                size_bytes,
                reason: ProjectTextSkipReason::TooLarge,
                message: format!(
                    "Skipped because it is larger than {} MiB.",
                    PROJECT_TEXT_MAX_BYTES / (1024 * 1024)
                ),
            });
            continue;
        }
        if is_known_binary_extension(file_extension(path)) {
            binary_file_count += 1;
            continue;
        }
        match probe_plain_text(path, size_bytes) {
            Ok(true) => files.push(ProjectTextFileInfo {
                path: path.to_string_lossy().to_string(),
                relative_path: relative,
                size_bytes,
                modified_ms: modified_ms(&metadata),
            }),
            Ok(false) => binary_file_count += 1,
            Err(error) => {
                unreadable_file_count += 1;
                skipped.push(ProjectTextSkippedFile {
                    path: path.to_string_lossy().to_string(),
                    relative_path: relative,
                    size_bytes,
                    reason: ProjectTextSkipReason::Unreadable,
                    message: format!("Could not inspect the file: {error}"),
                });
            }
        }
    }

    clear_cancelled_request(request_id);
    files.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
    });
    skipped.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
    });
    Ok(ProjectTextInventory {
        workspace_root_path: root.to_string_lossy().to_string(),
        include_ignored,
        files,
        skipped,
        binary_file_count,
        too_large_file_count,
        unreadable_file_count,
        cancelled,
    })
}

fn line_ending(text: &str) -> ProjectTextLineEnding {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    let cr = text.matches('\r').count() - crlf;
    match (lf > 0, crlf > 0, cr > 0) {
        (false, false, false) => ProjectTextLineEnding::None,
        (true, false, false) => ProjectTextLineEnding::Lf,
        (false, true, false) => ProjectTextLineEnding::Crlf,
        (false, false, true) => ProjectTextLineEnding::Cr,
        _ => ProjectTextLineEnding::Mixed,
    }
}

fn revision_for_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn project_text_read_blocking(
    workspace_root_path: &str,
    path: &str,
) -> Result<ProjectTextReadResult, String> {
    let (root, file) = canonical_workspace_file(workspace_root_path, path)?;
    let relative = relative_path(&root, &file);
    let metadata =
        fs::metadata(&file).map_err(|error| format!("Failed to inspect the file: {error}"))?;
    let size_bytes = metadata.len();
    let modified = modified_ms(&metadata);
    if size_bytes > PROJECT_TEXT_MAX_BYTES {
        return Ok(ProjectTextReadResult {
            path: file.to_string_lossy().to_string(),
            relative_path: relative,
            size_bytes,
            modified_ms: modified,
            revision: None,
            text: None,
            has_bom: false,
            line_ending: ProjectTextLineEnding::None,
            skip_reason: Some(ProjectTextSkipReason::TooLarge),
            message: Some(format!(
                "Skipped because it is larger than {} MiB.",
                PROJECT_TEXT_MAX_BYTES / (1024 * 1024)
            )),
        });
    }

    let bytes = fs::read(&file).map_err(|error| format!("Failed to read the file: {error}"))?;
    if bytes.len() as u64 > PROJECT_TEXT_MAX_BYTES || !crate::is_probably_plain_text_bytes(&bytes) {
        return Ok(ProjectTextReadResult {
            path: file.to_string_lossy().to_string(),
            relative_path: relative,
            size_bytes: bytes.len() as u64,
            modified_ms: modified,
            revision: None,
            text: None,
            has_bom: false,
            line_ending: ProjectTextLineEnding::None,
            skip_reason: if bytes.len() as u64 > PROJECT_TEXT_MAX_BYTES {
                Some(ProjectTextSkipReason::TooLarge)
            } else {
                Some(ProjectTextSkipReason::Binary)
            },
            message: Some(if bytes.len() as u64 > PROJECT_TEXT_MAX_BYTES {
                format!(
                    "Skipped because it is larger than {} MiB.",
                    PROJECT_TEXT_MAX_BYTES / (1024 * 1024)
                )
            } else {
                "Skipped because the file is not valid UTF-8 text.".to_string()
            }),
        });
    }
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| "The file is not valid UTF-8 text.".to_string())?;
    let has_bom = text.starts_with('\u{feff}');
    let line_ending = line_ending(&text);
    let revision = revision_for_bytes(&bytes);
    Ok(ProjectTextReadResult {
        path: file.to_string_lossy().to_string(),
        relative_path: relative,
        size_bytes: bytes.len() as u64,
        modified_ms: modified,
        revision: Some(revision),
        text: Some(text),
        has_bom,
        line_ending,
        skip_reason: None,
        message: None,
    })
}

pub fn project_text_revision_blocking(
    workspace_root_path: &str,
    path: &str,
) -> Result<ProjectTextRevisionInfo, String> {
    let (root, file) = canonical_workspace_file(workspace_root_path, path)?;
    let relative = relative_path(&root, &file);
    let metadata =
        fs::metadata(&file).map_err(|error| format!("Failed to inspect the file: {error}"))?;
    let size_bytes = metadata.len();
    let modified = modified_ms(&metadata);
    if size_bytes > PROJECT_TEXT_MAX_BYTES {
        return Ok(ProjectTextRevisionInfo {
            path: file.to_string_lossy().to_string(),
            relative_path: relative,
            size_bytes,
            modified_ms: modified,
            revision: None,
            skip_reason: Some(ProjectTextSkipReason::TooLarge),
            message: Some("The file is too large for project text search.".to_string()),
        });
    }
    let bytes = fs::read(&file).map_err(|error| format!("Failed to read the file: {error}"))?;
    if !crate::is_probably_plain_text_bytes(&bytes) {
        return Ok(ProjectTextRevisionInfo {
            path: file.to_string_lossy().to_string(),
            relative_path: relative,
            size_bytes,
            modified_ms: modified,
            revision: None,
            skip_reason: Some(ProjectTextSkipReason::Binary),
            message: Some("The file is not valid UTF-8 text.".to_string()),
        });
    }
    Ok(ProjectTextRevisionInfo {
        path: file.to_string_lossy().to_string(),
        relative_path: relative,
        size_bytes: bytes.len() as u64,
        modified_ms: modified,
        revision: Some(revision_for_bytes(&bytes)),
        skip_reason: None,
        message: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn inventory(root: &Path, include_ignored: bool) -> ProjectTextInventory {
        project_text_inventory_blocking("test-inventory", root.to_str().unwrap(), include_ignored)
            .unwrap()
    }

    #[test]
    fn inventory_respects_gitignore_and_always_excludes_private_directories() {
        let workspace = tempdir().unwrap();
        let root = workspace.path();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("main.typ"), "= Main\n").unwrap();
        fs::write(root.join("ignored.txt"), "ignored\n").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "secret\n").unwrap();
        fs::create_dir_all(root.join(".typsastra")).unwrap();
        fs::write(root.join(".typsastra/cache.typ"), "cache\n").unwrap();

        let default_inventory = inventory(root, false);
        assert_eq!(
            default_inventory
                .files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec![".gitignore", "main.typ"]
        );

        let with_ignored = inventory(root, true);
        assert_eq!(
            with_ignored
                .files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec![".gitignore", "ignored.txt", "main.typ"]
        );
        assert!(!with_ignored
            .files
            .iter()
            .any(|file| file.relative_path.contains(".git/")
                || file.relative_path.contains(".typsastra/")));
    }

    #[test]
    fn inventory_reports_binary_and_oversized_skips() {
        let workspace = tempdir().unwrap();
        let root = workspace.path();
        fs::write(root.join("main.typ"), "= Main\n").unwrap();
        fs::write(root.join("photo.png"), [0x89, b'P', b'N', b'G']).unwrap();
        fs::write(root.join("invalid.txt"), [0xff, 0xfe, 0x00]).unwrap();
        fs::write(
            root.join("large.txt"),
            vec![b'a'; PROJECT_TEXT_MAX_BYTES as usize + 1],
        )
        .unwrap();

        let result = inventory(root, false);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].relative_path, "main.typ");
        assert_eq!(result.binary_file_count, 2);
        assert_eq!(result.too_large_file_count, 1);
        assert!(result.skipped.iter().any(|file| {
            file.relative_path == "large.txt" && file.reason == ProjectTextSkipReason::TooLarge
        }));
    }

    #[test]
    fn inventory_does_not_reject_a_multibyte_character_split_by_the_probe() {
        let workspace = tempdir().unwrap();
        let root = workspace.path();
        let mut source = vec![b'a'; BINARY_PROBE_BYTES - 1];
        source.extend_from_slice("😀 tail".as_bytes());
        fs::write(root.join("boundary.txt"), source).unwrap();

        let result = inventory(root, false);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].relative_path, "boundary.txt");
        assert_eq!(result.binary_file_count, 0);
    }

    #[test]
    fn reads_original_bom_and_crlf_text() {
        let workspace = tempdir().unwrap();
        let root = workspace.path();
        let file = root.join("main.typ");
        fs::write(&file, "\u{feff}= Title\r\nText\r\n").unwrap();

        let result =
            project_text_read_blocking(root.to_str().unwrap(), file.to_str().unwrap()).unwrap();
        assert_eq!(result.text.as_deref(), Some("\u{feff}= Title\r\nText\r\n"));
        assert!(result.has_bom);
        assert_eq!(result.line_ending, ProjectTextLineEnding::Crlf);
        assert_eq!(result.revision.as_deref().map(str::len), Some(64));
        assert!(result.skip_reason.is_none());
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let file = outside.path().join("outside.txt");
        fs::write(&file, "outside").unwrap();

        let error =
            project_text_read_blocking(workspace.path().to_str().unwrap(), file.to_str().unwrap())
                .unwrap_err();
        assert!(error.contains("outside the active workspace"));
    }

    #[test]
    fn reports_invalid_utf8_as_binary_during_read() {
        let workspace = tempdir().unwrap();
        let file = workspace.path().join("invalid.txt");
        fs::write(&file, [0xff, 0xfe, 0x00]).unwrap();

        let result =
            project_text_read_blocking(workspace.path().to_str().unwrap(), file.to_str().unwrap())
                .unwrap();
        assert_eq!(result.skip_reason, Some(ProjectTextSkipReason::Binary));
        assert!(result.text.is_none());
    }
}
