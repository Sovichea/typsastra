use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use zip::write::FileOptions;

pub const PROJECT_FORMAT: &str = "com.typstry.project";
pub const PROJECT_SCHEMA_VERSION: u32 = 1;
pub const PROJECT_MANIFEST_PATH: &str = ".typstry/project.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub format: String,
    pub schema_version: u32,
    pub created_by: CreatedBy,
    pub project: ProjectIdentity,
    pub toolchain: ProjectToolchain,
    pub render_environment: RenderEnvironment,
    pub fonts: Vec<ProjectFont>,
    pub integrity: ProjectIntegrity,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedBy {
    pub application: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdentity {
    pub name: String,
    pub main: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectToolchain {
    pub typst_version: String,
    pub tinymist_version: String,
    pub compatibility: ToolchainCompatibility,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolchainCompatibility {
    Exact,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderEnvironment {
    pub fonts_packaged: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFont {
    pub id: String,
    pub family: String,
    pub postscript_name: String,
    pub style: String,
    pub weight: u16,
    pub stretch: u16,
    pub path: String,
    pub sha256: String,
    pub license: ProjectFontLicense,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFontLicense {
    pub name: String,
    pub redistributable: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntegrity {
    pub algorithm: String,
    pub files: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
struct FileSnapshot {
    absolute_path: PathBuf,
    archive_path: String,
    sha256: String,
}

pub struct ProjectExport<'a> {
    pub workspace_root: &'a Path,
    pub archive_path: &'a Path,
    pub main_file_path: &'a Path,
    pub app_version: &'a str,
    pub typst_version: &'a str,
    pub tinymist_version: &'a str,
}

pub fn validate_manifest_compatibility(manifest: &ProjectManifest) -> Result<(), String> {
    if manifest.format != PROJECT_FORMAT {
        return Err(format!(
            "Unsupported project format '{}'. Expected '{}'.",
            manifest.format, PROJECT_FORMAT
        ));
    }
    if manifest.schema_version != PROJECT_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Typstry project schema version {}. This build supports version {}.",
            manifest.schema_version, PROJECT_SCHEMA_VERSION
        ));
    }
    if manifest.created_by.application != "Typstry" || manifest.created_by.version.trim().is_empty()
    {
        return Err("The project creator metadata is invalid.".to_string());
    }
    if manifest.project.name.trim().is_empty() {
        return Err("The project name is empty.".to_string());
    }
    validate_archive_path(&manifest.project.main)?;
    if !manifest.project.main.ends_with(".typ") {
        return Err("The project main file must be a .typ file.".to_string());
    }
    if manifest.toolchain.typst_version.trim().is_empty()
        || manifest.toolchain.tinymist_version.trim().is_empty()
    {
        return Err("The project toolchain versions are incomplete.".to_string());
    }
    semver::Version::parse(&manifest.toolchain.typst_version)
        .map_err(|_| "The project Typst version is invalid.".to_string())?;
    semver::Version::parse(&manifest.toolchain.tinymist_version)
        .map_err(|_| "The project Tinymist version is invalid.".to_string())?;
    if manifest.integrity.algorithm != "sha256" {
        return Err(format!(
            "Unsupported integrity algorithm '{}'.",
            manifest.integrity.algorithm
        ));
    }
    if !manifest
        .integrity
        .files
        .contains_key(&manifest.project.main)
    {
        return Err("The project main file is missing from the integrity manifest.".to_string());
    }
    for (path, digest) in &manifest.integrity.files {
        validate_archive_path(path)?;
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("The integrity digest for '{path}' is not SHA-256."));
        }
    }
    Ok(())
}

pub fn export_source_zip(workspace_root: &Path, archive_path: &Path) -> Result<(), String> {
    let root = canonical_workspace_root(workspace_root)?;
    let excluded_output = canonicalize_if_exists(archive_path);
    let files = collect_workspace_files(&root, excluded_output.as_deref())?;
    write_archive(archive_path, |writer| write_snapshots(writer, &files))
}

pub fn export_typstry_project(options: ProjectExport<'_>) -> Result<ProjectManifest, String> {
    require_extension(options.archive_path, "typstry")?;
    let root = canonical_workspace_root(options.workspace_root)?;
    let main = std::fs::canonicalize(options.main_file_path).map_err(|error| {
        format!(
            "Failed to resolve project main file '{}': {error}",
            options.main_file_path.display()
        )
    })?;
    if !main.is_file() || main.extension().and_then(|value| value.to_str()) != Some("typ") {
        return Err("The project main file must be an existing .typ file.".to_string());
    }
    let main_relative = archive_path_for(&root, &main)?;
    let excluded_output = canonicalize_if_exists(options.archive_path);
    let files = collect_workspace_files(&root, excluded_output.as_deref())?;
    if !files.iter().any(|file| file.archive_path == main_relative) {
        return Err("The project main file was excluded from the archive.".to_string());
    }

    let project_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The workspace folder does not have a valid Unicode name.".to_string())?
        .to_string();
    let integrity_files = files
        .iter()
        .map(|file| (file.archive_path.clone(), file.sha256.clone()))
        .collect();
    let manifest = ProjectManifest {
        format: PROJECT_FORMAT.to_string(),
        schema_version: PROJECT_SCHEMA_VERSION,
        created_by: CreatedBy {
            application: "Typstry".to_string(),
            version: options.app_version.to_string(),
        },
        project: ProjectIdentity {
            name: project_name,
            main: main_relative,
        },
        toolchain: ProjectToolchain {
            typst_version: options.typst_version.to_string(),
            tinymist_version: options.tinymist_version.to_string(),
            compatibility: ToolchainCompatibility::Exact,
        },
        // V1-I.18 through V1-I.24 will replace this explicit capability marker with
        // the verified project-local font payload. Do not infer full render
        // reproducibility while it remains false.
        render_environment: RenderEnvironment {
            fonts_packaged: false,
        },
        fonts: Vec::new(),
        integrity: ProjectIntegrity {
            algorithm: "sha256".to_string(),
            files: integrity_files,
        },
    };
    validate_manifest_compatibility(&manifest)?;
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Failed to serialize project manifest: {error}"))?;
    manifest_bytes.push(b'\n');

    write_archive(options.archive_path, |writer| {
        write_entry(writer, PROJECT_MANIFEST_PATH, &manifest_bytes)?;
        write_snapshots(writer, &files)
    })?;
    Ok(manifest)
}

fn canonical_workspace_root(workspace_root: &Path) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(workspace_root).map_err(|error| {
        format!(
            "Failed to resolve workspace '{}': {error}",
            workspace_root.display()
        )
    })?;
    if !root.is_dir() {
        return Err("Workspace path is not a directory.".to_string());
    }
    Ok(root)
}

fn canonicalize_if_exists(path: &Path) -> Option<PathBuf> {
    path.exists()
        .then(|| std::fs::canonicalize(path).ok())
        .flatten()
}

fn collect_workspace_files(
    root: &Path,
    excluded_output: Option<&Path>,
) -> Result<Vec<FileSnapshot>, String> {
    let mut files = Vec::new();
    collect_directory(root, root, excluded_output, &mut files)?;
    files.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    let mut seen = HashSet::new();
    for file in &files {
        let comparison_key = file.archive_path.to_lowercase();
        if !seen.insert(comparison_key) {
            return Err(format!(
                "The workspace contains archive paths that collide across platforms: '{}'.",
                file.archive_path
            ));
        }
    }
    Ok(files)
}

fn collect_directory(
    root: &Path,
    directory: &Path,
    excluded_output: Option<&Path>,
    files: &mut Vec<FileSnapshot>,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(|error| {
            format!(
                "Failed to read directory '{}': {error}",
                directory.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to enumerate '{}': {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect '{}': {error}", path.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "Symbolic links are not supported in project exports: '{}'.",
                path.display()
            ));
        }
        if file_type.is_dir() {
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| {
                format!(
                    "A workspace directory name is not valid Unicode: '{:?}'.",
                    name
                )
            })?;
            if is_excluded_directory(name) {
                continue;
            }
            collect_directory(root, &path, excluded_output, files)?;
        } else if file_type.is_file() {
            if excluded_output.is_some_and(|output| path == output) {
                continue;
            }
            let archive_path = archive_path_for(root, &path)?;
            validate_archive_path(&archive_path)?;
            let bytes = read_stable_file(&path)?;
            files.push(FileSnapshot {
                absolute_path: path,
                archive_path,
                sha256: sha256_hex(&bytes),
            });
        } else {
            return Err(format!(
                "Unsupported workspace entry type: '{}'.",
                path.display()
            ));
        }
    }
    Ok(())
}

fn is_excluded_directory(name: &str) -> bool {
    matches!(name, ".git" | ".typstry" | "node_modules" | "target")
}

fn archive_path_for(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        format!(
            "Project file '{}' is outside workspace '{}'.",
            path.display(),
            root.display()
        )
    })?;
    let components = relative
        .components()
        .map(|component| {
            component.as_os_str().to_str().ok_or_else(|| {
                format!(
                    "A workspace path is not valid Unicode: '{}'.",
                    path.display()
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(components.join("/"))
}

fn validate_archive_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("Invalid project archive path: '{path}'."));
    }
    Ok(())
}

fn require_extension(path: &Path, expected: &str) -> Result<(), String> {
    let actual = path.extension().and_then(|value| value.to_str());
    if actual.is_some_and(|value| value.eq_ignore_ascii_case(expected)) {
        Ok(())
    } else {
        Err(format!(
            "Typstry project exports must use the .{expected} extension."
        ))
    }
}

fn read_stable_file(path: &Path) -> Result<Vec<u8>, String> {
    let before = std::fs::metadata(path)
        .map_err(|error| format!("Failed to inspect '{}': {error}", path.display()))?;
    let mut file = File::open(path)
        .map_err(|error| format!("Failed to open '{}': {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read '{}': {error}", path.display()))?;
    let after = file
        .metadata()
        .map_err(|error| format!("Failed to recheck '{}': {error}", path.display()))?;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || after.len() != bytes.len() as u64
    {
        return Err(format!(
            "Project file changed during export: '{}'. Save it and retry.",
            path.display()
        ));
    }
    Ok(bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn deterministic_file_options() -> FileOptions<'static, ()> {
    FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644)
}

fn write_archive(
    archive_path: &Path,
    write_contents: impl FnOnce(&mut zip::ZipWriter<File>) -> Result<(), String>,
) -> Result<(), String> {
    let parent = archive_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create export directory '{}': {error}",
            parent.display()
        )
    })?;
    let temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to stage project export: {error}"))?;
    let file = temporary
        .reopen()
        .map_err(|error| format!("Failed to open staged project export: {error}"))?;
    let mut writer = zip::ZipWriter::new(file);
    write_contents(&mut writer)?;
    writer
        .finish()
        .map_err(|error| format!("Failed to finish project archive: {error}"))?;
    temporary.persist(archive_path).map_err(|error| {
        format!(
            "Failed to publish project export '{}': {}",
            archive_path.display(),
            error.error
        )
    })?;
    Ok(())
}

fn write_snapshots(
    writer: &mut zip::ZipWriter<File>,
    files: &[FileSnapshot],
) -> Result<(), String> {
    for snapshot in files {
        let bytes = read_stable_file(&snapshot.absolute_path)?;
        let actual_hash = sha256_hex(&bytes);
        if actual_hash != snapshot.sha256 {
            return Err(format!(
                "Project file changed during export: '{}'. Save it and retry.",
                snapshot.absolute_path.display()
            ));
        }
        write_entry(writer, &snapshot.archive_path, &bytes)?;
    }
    Ok(())
}

fn write_entry<W: Write + Seek>(
    writer: &mut zip::ZipWriter<W>,
    path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    writer
        .start_file(path, deterministic_file_options())
        .map_err(|error| format!("Failed to add '{path}' to project archive: {error}"))?;
    writer
        .write_all(bytes)
        .map_err(|error| format!("Failed to write '{path}' to project archive: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn create_workspace() -> tempfile::TempDir {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("main.typ"), "= Hello\n").unwrap();
        std::fs::create_dir(workspace.path().join("chapters")).unwrap();
        std::fs::write(workspace.path().join("chapters").join("ខ្មែរ.typ"), "= ខ្មែរ\n").unwrap();
        std::fs::create_dir(workspace.path().join(".typstry")).unwrap();
        std::fs::write(workspace.path().join(".typstry").join("cache.txt"), "skip").unwrap();
        workspace
    }

    fn export_project(workspace: &Path, destination: &Path) -> ProjectManifest {
        export_typstry_project(ProjectExport {
            workspace_root: workspace,
            archive_path: destination,
            main_file_path: &workspace.join("main.typ"),
            app_version: "1.0.0",
            typst_version: "0.13.1",
            tinymist_version: "0.13.10",
        })
        .unwrap()
    }

    #[test]
    fn project_manifest_round_trips_and_validates() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("manifest-test.typstry");
        let manifest = export_project(workspace.path(), &archive);
        let encoded = serde_json::to_string(&manifest).unwrap();
        let decoded: ProjectManifest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, manifest);
        assert!(validate_manifest_compatibility(&decoded).is_ok());
        assert_eq!(decoded.project.main, "main.typ");
        assert_eq!(decoded.toolchain.typst_version, "0.13.1");
        assert!(!decoded.render_environment.fonts_packaged);
    }

    #[test]
    fn invalid_schema_versions_paths_and_hashes_are_rejected() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("validation.typstry");
        let manifest = export_project(workspace.path(), &archive);

        let mut invalid = manifest.clone();
        invalid.schema_version += 1;
        assert!(validate_manifest_compatibility(&invalid).is_err());

        let mut invalid = manifest.clone();
        invalid.project.main = "../main.typ".to_string();
        assert!(validate_manifest_compatibility(&invalid).is_err());

        let mut invalid = manifest;
        invalid
            .integrity
            .files
            .insert("main.typ".to_string(), "invalid".to_string());
        assert!(validate_manifest_compatibility(&invalid).is_err());
    }

    #[test]
    fn export_is_sorted_unicode_safe_and_excludes_generated_directories() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("unicode-test.typstry");
        export_project(workspace.path(), &archive);
        let file = File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let names = (0..zip.len())
            .map(|index| zip.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        assert_eq!(names[0], PROJECT_MANIFEST_PATH);
        assert!(names.contains(&"chapters/ខ្មែរ.typ".to_string()));
        assert!(!names.iter().any(|name| name.contains("cache.txt")));
    }

    #[test]
    fn manifest_hashes_match_archive_contents() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("hash-test.typstry");
        let manifest = export_project(workspace.path(), &archive);
        let file = File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        for (name, expected_hash) in manifest.integrity.files {
            let mut entry = zip.by_name(&name).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            assert_eq!(sha256_hex(&bytes), expected_hash);
        }
    }

    #[test]
    fn identical_inputs_produce_identical_archives() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let first = output.path().join("deterministic-a.typstry");
        let second = output.path().join("deterministic-b.typstry");
        export_project(workspace.path(), &first);
        export_project(workspace.path(), &second);
        assert_eq!(
            std::fs::read(&first).unwrap(),
            std::fs::read(&second).unwrap()
        );
    }

    #[test]
    fn source_zip_has_no_manifest_and_replaces_existing_destination() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("source.zip");
        std::fs::write(&archive, "old").unwrap();
        export_source_zip(workspace.path(), &archive).unwrap();
        let file = File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        assert!(zip.by_name("main.typ").is_ok());
        assert!(zip.by_name(PROJECT_MANIFEST_PATH).is_err());
    }

    #[test]
    fn changed_snapshot_is_rejected_before_archive_publication() {
        let workspace = create_workspace();
        let files = collect_workspace_files(workspace.path(), None).unwrap();
        std::fs::write(workspace.path().join("main.typ"), "= Changed\n").unwrap();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("changed.zip");
        let error = write_archive(&archive, |writer| write_snapshots(writer, &files)).unwrap_err();
        assert!(error.contains("changed during export"));
        assert!(!archive.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let workspace = create_workspace();
        symlink(
            workspace.path().join("main.typ"),
            workspace.path().join("link.typ"),
        )
        .unwrap();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("symlink-test.zip");
        let error = export_source_zip(workspace.path(), &archive).unwrap_err();
        assert!(error.contains("Symbolic links"));
    }
}
