use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

pub const RECOVERY_RECORD_VERSION: u32 = 1;
pub const RECOVERY_STORAGE_LIMIT_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub version: u32,
    pub document_id: String,
    pub workspace_root: Option<String>,
    pub path: Option<String>,
    pub text: String,
    pub saved_text_hash: String,
    pub revision: u64,
    pub timestamp_ms: u64,
    pub selection_anchor: usize,
    pub selection_head: usize,
    pub scroll_top: f64,
    pub scroll_left: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecordSummary {
    pub version: u32,
    pub document_id: String,
    pub workspace_root: Option<String>,
    pub path: Option<String>,
    pub revision: u64,
    pub timestamp_ms: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCorruptRecord {
    pub file_name: String,
    pub bytes: u64,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryListing {
    pub records: Vec<RecoveryRecordSummary>,
    pub corrupt: Vec<RecoveryCorruptRecord>,
    pub total_bytes: u64,
    pub limit_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryWriteResult {
    pub written: bool,
    pub reason: Option<String>,
    pub revision: u64,
    pub current_revision: Option<u64>,
    pub bytes: u64,
    pub total_bytes: u64,
    pub limit_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDeleteResult {
    pub deleted: bool,
    pub reason: Option<String>,
    pub current_revision: Option<u64>,
}

pub fn recovery_root(app_local_data_dir: &Path) -> PathBuf {
    app_local_data_dir.join("recovery")
}

fn records_root(root: &Path) -> PathBuf {
    root.join("records")
}

fn record_key(document_id: &str) -> String {
    let digest = Sha256::digest(document_id.as_bytes());
    digest[..24]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn record_path(root: &Path, document_id: &str) -> PathBuf {
    records_root(root).join(format!("{}.json", record_key(document_id)))
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("bak")
}

fn is_hex_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_record(record: &RecoveryRecord) -> Result<(), String> {
    if record.version != RECOVERY_RECORD_VERSION {
        return Err(format!(
            "Unsupported recovery record version {}",
            record.version
        ));
    }
    if record.document_id.trim().is_empty() {
        return Err("Recovery record has no document ID".to_string());
    }
    if record.document_id.len() > 512 {
        return Err("Recovery record document ID is too long".to_string());
    }
    if !is_hex_hash(&record.saved_text_hash) {
        return Err("Recovery record has an invalid saved-content hash".to_string());
    }
    if record.revision == 0 {
        return Err("Recovery record revision must be positive".to_string());
    }
    if !record.scroll_top.is_finite() || !record.scroll_left.is_finite() {
        return Err("Recovery record has an invalid editor scroll position".to_string());
    }
    Ok(())
}

fn read_record_file(path: &Path) -> Result<RecoveryRecord, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read recovery record: {error}"))?;
    let record = serde_json::from_slice::<RecoveryRecord>(&bytes)
        .map_err(|error| format!("Failed to parse recovery record: {error}"))?;
    validate_record(&record)?;
    Ok(record)
}

fn total_record_bytes(root: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(records_root(root)) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.ends_with(".json") && !name.ends_with(".bak") {
                return None;
            }
            entry.metadata().ok().map(|metadata| metadata.len())
        })
        .sum()
}

fn recover_orphan_backups(records_dir: &Path) {
    let Ok(entries) = fs::read_dir(records_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("bak") {
            continue;
        }
        let target = path.with_extension("json");
        if target.is_file() {
            if read_record_file(&target).is_ok() {
                let _ = fs::remove_file(&path);
            }
            continue;
        }
        if read_record_file(&path).is_ok() {
            let _ = fs::rename(&path, &target);
        }
    }
}

pub fn list_recovery_records(root: &Path) -> Result<RecoveryListing, String> {
    let records_dir = records_root(root);
    recover_orphan_backups(&records_dir);
    let mut records = Vec::new();
    let mut corrupt = Vec::new();
    let total_bytes = total_record_bytes(root);
    if records_dir.is_dir() {
        let entries = fs::read_dir(&records_dir)
            .map_err(|error| format!("Failed to list recovery records: {error}"))?;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.to_ascii_lowercase().ends_with(".json") {
                continue;
            }
            let bytes = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            match read_record_file(&entry.path()) {
                Ok(record) => records.push(RecoveryRecordSummary {
                    version: record.version,
                    document_id: record.document_id,
                    workspace_root: record.workspace_root,
                    path: record.path,
                    revision: record.revision,
                    timestamp_ms: record.timestamp_ms,
                    bytes,
                }),
                Err(error) => corrupt.push(RecoveryCorruptRecord {
                    file_name,
                    bytes,
                    error,
                }),
            }
        }
    }
    records.sort_by(|left, right| right.timestamp_ms.cmp(&left.timestamp_ms));
    Ok(RecoveryListing {
        records,
        corrupt,
        total_bytes,
        limit_bytes: RECOVERY_STORAGE_LIMIT_BYTES,
    })
}

pub fn read_recovery_record(
    root: &Path,
    document_id: &str,
) -> Result<Option<RecoveryRecord>, String> {
    let path = record_path(root, document_id);
    if !path.is_file() {
        return Ok(None);
    }
    read_record_file(&path).map(Some)
}

pub fn write_recovery_record(
    root: &Path,
    record: RecoveryRecord,
) -> Result<RecoveryWriteResult, String> {
    write_recovery_record_with_limit(root, record, RECOVERY_STORAGE_LIMIT_BYTES)
}

fn write_recovery_record_with_limit(
    root: &Path,
    record: RecoveryRecord,
    limit_bytes: u64,
) -> Result<RecoveryWriteResult, String> {
    validate_record(&record)?;
    let records_dir = records_root(root);
    fs::create_dir_all(&records_dir)
        .map_err(|error| format!("Failed to create recovery storage: {error}"))?;
    let target = record_path(root, &record.document_id);
    let existing = read_record_file(&target).ok();
    if let Some(existing) = existing.as_ref() {
        if existing.revision >= record.revision {
            return Ok(RecoveryWriteResult {
                written: false,
                reason: Some("stale-revision".to_string()),
                revision: record.revision,
                current_revision: Some(existing.revision),
                bytes: 0,
                total_bytes: total_record_bytes(root),
                limit_bytes,
            });
        }
    }

    let bytes = serde_json::to_vec(&record)
        .map_err(|error| format!("Failed to encode recovery record: {error}"))?;
    let existing_bytes = fs::metadata(&target)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let total_bytes = total_record_bytes(root);
    let next_total = total_bytes
        .saturating_sub(existing_bytes)
        .saturating_add(bytes.len() as u64);
    if next_total > limit_bytes {
        return Ok(RecoveryWriteResult {
            written: false,
            reason: Some("quota-exceeded".to_string()),
            revision: record.revision,
            current_revision: existing.as_ref().map(|record| record.revision),
            bytes: bytes.len() as u64,
            total_bytes,
            limit_bytes,
        });
    }

    let mut temporary = NamedTempFile::new_in(&records_dir)
        .map_err(|error| format!("Failed to create recovery snapshot: {error}"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file_mut().sync_all())
        .map_err(|error| format!("Failed to write recovery snapshot: {error}"))?;

    let backup = backup_path(&target);
    if target.is_file() {
        if backup.is_file() {
            let _ = fs::remove_file(&backup);
        }
        fs::rename(&target, &backup)
            .map_err(|error| format!("Failed to stage the previous recovery snapshot: {error}"))?;
    }
    match temporary.persist(&target) {
        Ok(file) => {
            let _ = file.sync_all();
            if backup.is_file() {
                let _ = fs::remove_file(&backup);
            }
            Ok(RecoveryWriteResult {
                written: true,
                reason: None,
                revision: record.revision,
                current_revision: Some(record.revision),
                bytes: bytes.len() as u64,
                total_bytes: next_total,
                limit_bytes,
            })
        }
        Err(error) => {
            if backup.is_file() {
                let _ = fs::rename(&backup, &target);
            }
            Err(format!("Failed to publish recovery snapshot: {error}"))
        }
    }
}

pub fn delete_corrupt_recovery_record(root: &Path, file_name: &str) -> Result<(), String> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name == "."
        || file_name == ".."
    {
        return Err("Invalid recovery record file name.".to_string());
    }
    let target = records_root(root).join(file_name);
    if !target.is_file() {
        return Ok(());
    }
    if read_record_file(&target).is_ok() {
        return Err("Refusing to discard a valid recovery record as corrupt.".to_string());
    }
    fs::remove_file(&target).map_err(|error| format!("Failed to delete recovery record: {error}"))
}

pub fn delete_recovery_record(
    root: &Path,
    document_id: &str,
    expected_revision: Option<u64>,
) -> Result<RecoveryDeleteResult, String> {
    let target = record_path(root, document_id);
    if !target.is_file() {
        return Ok(RecoveryDeleteResult {
            deleted: false,
            reason: Some("missing".to_string()),
            current_revision: None,
        });
    }
    let current = read_record_file(&target).ok();
    if let Some(expected) = expected_revision {
        let Some(current) = current.as_ref() else {
            return Ok(RecoveryDeleteResult {
                deleted: false,
                reason: Some("invalid-record".to_string()),
                current_revision: None,
            });
        };
        if current.revision > expected {
            return Ok(RecoveryDeleteResult {
                deleted: false,
                reason: Some("newer-revision".to_string()),
                current_revision: Some(current.revision),
            });
        }
    }
    fs::remove_file(&target)
        .map_err(|error| format!("Failed to delete recovery snapshot: {error}"))?;
    let backup = backup_path(&target);
    if backup.is_file() {
        let _ = fs::remove_file(backup);
    }
    Ok(RecoveryDeleteResult {
        deleted: true,
        reason: None,
        current_revision: current.map(|record| record.revision),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, revision: u64, text: &str) -> RecoveryRecord {
        RecoveryRecord {
            version: RECOVERY_RECORD_VERSION,
            document_id: id.to_string(),
            workspace_root: Some("C:/project".to_string()),
            path: Some("C:/project/main.typ".to_string()),
            text: text.to_string(),
            saved_text_hash: "a".repeat(64),
            revision,
            timestamp_ms: revision * 1000,
            selection_anchor: 4,
            selection_head: 4,
            scroll_top: 12.5,
            scroll_left: 0.0,
        }
    }

    #[test]
    fn writes_lists_reads_and_deletes_records() {
        let directory = tempfile::tempdir().unwrap();
        let root = recovery_root(directory.path());
        let written = write_recovery_record(&root, record("doc-1", 1, "first")).unwrap();
        assert!(written.written);
        let listing = list_recovery_records(&root).unwrap();
        assert_eq!(listing.records.len(), 1);
        assert_eq!(listing.records[0].document_id, "doc-1");
        assert_eq!(
            read_recovery_record(&root, "doc-1").unwrap().unwrap().text,
            "first"
        );
        assert!(
            delete_recovery_record(&root, "doc-1", Some(1))
                .unwrap()
                .deleted
        );
        assert!(read_recovery_record(&root, "doc-1").unwrap().is_none());
    }

    #[test]
    fn rejects_stale_revisions_and_keeps_the_previous_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let root = recovery_root(directory.path());
        assert!(
            write_recovery_record(&root, record("doc-1", 2, "newer"))
                .unwrap()
                .written
        );
        let stale = write_recovery_record(&root, record("doc-1", 1, "older")).unwrap();
        assert!(!stale.written);
        assert_eq!(stale.reason.as_deref(), Some("stale-revision"));
        assert_eq!(
            read_recovery_record(&root, "doc-1").unwrap().unwrap().text,
            "newer"
        );
    }

    #[test]
    fn deleting_does_not_remove_a_newer_unsaved_revision() {
        let directory = tempfile::tempdir().unwrap();
        let root = recovery_root(directory.path());
        assert!(
            write_recovery_record(&root, record("doc-1", 3, "newer"))
                .unwrap()
                .written
        );
        let deletion = delete_recovery_record(&root, "doc-1", Some(2)).unwrap();
        assert!(!deletion.deleted);
        assert_eq!(deletion.reason.as_deref(), Some("newer-revision"));
        assert!(read_recovery_record(&root, "doc-1").unwrap().is_some());
    }

    #[test]
    fn refuses_to_exceed_the_storage_limit_and_keeps_the_previous_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let root = recovery_root(directory.path());
        assert!(
            write_recovery_record_with_limit(&root, record("doc-1", 1, "old"), 10_000)
                .unwrap()
                .written
        );
        let denied = write_recovery_record_with_limit(
            &root,
            record("doc-1", 2, &"x".repeat(20_000)),
            10_000,
        )
        .unwrap();
        assert!(!denied.written);
        assert_eq!(denied.reason.as_deref(), Some("quota-exceeded"));
        assert_eq!(
            read_recovery_record(&root, "doc-1").unwrap().unwrap().text,
            "old"
        );
    }

    #[test]
    fn restores_an_orphaned_backup_after_an_interrupted_publish() {
        let directory = tempfile::tempdir().unwrap();
        let root = recovery_root(directory.path());
        let records_dir = records_root(&root);
        fs::create_dir_all(&records_dir).unwrap();
        let target = record_path(&root, "doc-1");
        let backup = backup_path(&target);
        fs::write(
            &backup,
            serde_json::to_vec(&record("doc-1", 7, "previous")).unwrap(),
        )
        .unwrap();

        let listing = list_recovery_records(&root).unwrap();
        assert_eq!(listing.records.len(), 1);
        assert_eq!(listing.records[0].revision, 7);
        assert!(target.is_file());
        assert!(!backup.exists());
    }

    #[test]
    fn corrupt_records_do_not_block_valid_records() {
        let directory = tempfile::tempdir().unwrap();
        let root = recovery_root(directory.path());
        assert!(
            write_recovery_record(&root, record("valid", 1, "ok"))
                .unwrap()
                .written
        );
        fs::write(records_root(&root).join("broken.json"), b"{not json").unwrap();
        let listing = list_recovery_records(&root).unwrap();
        assert_eq!(listing.records.len(), 1);
        assert_eq!(listing.records[0].document_id, "valid");
        assert_eq!(listing.corrupt.len(), 1);
        assert!(listing.total_bytes > 0);
    }
}
