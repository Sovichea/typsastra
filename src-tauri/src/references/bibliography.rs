use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::project_text::{canonical_root, is_excluded_directory, project_text_read_blocking};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyEntry {
    pub key: String,
    pub entry_type: String,
    pub fields: BTreeMap<String, String>,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<String>,
    pub path: String,
    pub relative_path: String,
    pub from_utf16: usize,
    pub to_utf16: usize,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyFile {
    pub path: String,
    pub relative_path: String,
    pub entry_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyDiagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub path: String,
    pub relative_path: String,
    pub from_utf16: usize,
    pub to_utf16: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyIndex {
    pub workspace_root_path: String,
    pub files: Vec<BibliographyFile>,
    pub entries: Vec<BibliographyEntry>,
    pub diagnostics: Vec<BibliographyDiagnostic>,
}

#[tauri::command]
pub async fn get_project_bibliography(
    workspace_root_path: String,
) -> Result<BibliographyIndex, String> {
    tokio::task::spawn_blocking(move || build_bibliography_index(&workspace_root_path))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn build_bibliography_index(
    workspace_root_path: &str,
) -> Result<BibliographyIndex, String> {
    let (root, bib_files) = discover_bib_files(workspace_root_path)?;
    let workspace_root_path = root.to_string_lossy().to_string();
    let mut files = Vec::new();
    let mut entries = Vec::new();
    let mut diagnostics = Vec::new();
    let mut first_keys: HashMap<String, (String, usize, usize)> = HashMap::new();

    for (path, relative_path) in bib_files {
        let path_string = path.to_string_lossy().to_string();
        let read = match project_text_read_blocking(&workspace_root_path, &path_string) {
            Ok(read) => read,
            Err(error) => {
                diagnostics.push(BibliographyDiagnostic {
                    severity: "error".into(),
                    code: "unreadable-bibliography-file".into(),
                    message: error,
                    path: path_string,
                    relative_path,
                    from_utf16: 0,
                    to_utf16: 0,
                });
                continue;
            }
        };
        let Some(text) = read.text else {
            diagnostics.push(BibliographyDiagnostic {
                severity: "error".into(),
                code: "unreadable-bibliography-file".into(),
                message: read
                    .message
                    .unwrap_or_else(|| "The bibliography file could not be read.".into()),
                path: read.path,
                relative_path: read.relative_path,
                from_utf16: 0,
                to_utf16: 0,
            });
            continue;
        };
        let parsed = parse_bibliography(&text);
        files.push(BibliographyFile {
            path: read.path.clone(),
            relative_path: read.relative_path.clone(),
            entry_count: parsed.entries.len(),
        });

        for entry in parsed.entries {
            let from_utf16 = utf16_len(&text[..entry.start]);
            let to_utf16 = utf16_len(&text[..entry.end]);
            if let Some((first_path, first_from, _)) = first_keys.get(&entry.key) {
                diagnostics.push(BibliographyDiagnostic {
                    severity: "error".into(),
                    code: "duplicate-citation-key".into(),
                    message: format!(
                        "Duplicate citation key '{}'; first defined in {} at UTF-16 offset {}.",
                        entry.key, first_path, first_from
                    ),
                    path: read.path.clone(),
                    relative_path: read.relative_path.clone(),
                    from_utf16,
                    to_utf16,
                });
            } else {
                first_keys.insert(
                    entry.key.clone(),
                    (read.relative_path.clone(), from_utf16, to_utf16),
                );
            }
            entries.push(BibliographyEntry {
                key: entry.key,
                entry_type: entry.entry_type,
                title: entry.title,
                authors: entry.authors,
                year: entry.year,
                fields: entry.fields,
                path: read.path.clone(),
                relative_path: read.relative_path.clone(),
                from_utf16,
                to_utf16,
                raw: text[entry.start..entry.end].to_string(),
            });
        }

        for diagnostic in parsed.diagnostics {
            diagnostics.push(BibliographyDiagnostic {
                severity: "error".into(),
                code: diagnostic.code.into(),
                message: diagnostic.message,
                path: read.path.clone(),
                relative_path: read.relative_path.clone(),
                from_utf16: utf16_len(&text[..diagnostic.start]),
                to_utf16: utf16_len(&text[..diagnostic.end]),
            });
        }
    }

    entries.sort_by(|left, right| {
        left.key
            .to_ascii_lowercase()
            .cmp(&right.key.to_ascii_lowercase())
            .then_with(|| left.relative_path.cmp(&right.relative_path))
            .then_with(|| left.from_utf16.cmp(&right.from_utf16))
    });
    diagnostics.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| left.from_utf16.cmp(&right.from_utf16))
    });

    Ok(BibliographyIndex {
        workspace_root_path,
        files,
        entries,
        diagnostics,
    })
}

fn discover_bib_files(
    workspace_root_path: &str,
) -> Result<(PathBuf, Vec<(PathBuf, String)>), String> {
    let root = canonical_root(workspace_root_path)?;
    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true);
    builder.filter_entry(is_excluded_directory);

    let mut files = Vec::new();
    for entry in builder.build() {
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
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if is_bib_path(path) {
            files.push((path.to_path_buf(), relative_path(&root, path)));
        }
    }
    files.sort_by(|left, right| left.1.cmp(&right.1));
    Ok((root, files))
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn is_bib_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("bib"))
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[derive(Debug)]
struct ParsedEntry {
    key: String,
    entry_type: String,
    fields: BTreeMap<String, String>,
    title: String,
    authors: Vec<String>,
    year: Option<String>,
    start: usize,
    end: usize,
}

#[derive(Debug)]
struct ParsedDiagnostic {
    code: &'static str,
    message: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Default)]
struct ParsedBibliography {
    entries: Vec<ParsedEntry>,
    diagnostics: Vec<ParsedDiagnostic>,
}

fn parse_bibliography(text: &str) -> ParsedBibliography {
    BibParser::new(text).parse()
}

struct BibParser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    pos: usize,
    macros: HashMap<String, String>,
    result: ParsedBibliography,
}

impl<'a> BibParser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            bytes: text.as_bytes(),
            pos: 0,
            macros: HashMap::new(),
            result: ParsedBibliography::default(),
        }
    }

    fn parse(mut self) -> ParsedBibliography {
        while self.pos < self.bytes.len() {
            self.skip_ws();
            if self.pos >= self.bytes.len() {
                break;
            }
            if self.bytes[self.pos] == b'@' {
                let start = self.pos;
                if let Err(message) = self.parse_entry() {
                    let end = self.next_entry_start(self.pos.max(start + 1));
                    self.result.diagnostics.push(ParsedDiagnostic {
                        code: "malformed-bib-entry",
                        message,
                        start,
                        end,
                    });
                    self.pos = end;
                }
            } else if let Some(offset) = self.text[self.pos..].find('@') {
                self.pos += offset;
            } else {
                self.pos = self.bytes.len();
            }
        }
        self.result
    }

    fn skip_ws(&mut self) {
        loop {
            while self.pos < self.bytes.len()
                && matches!(self.bytes[self.pos], b' ' | b'\t' | b'\r' | b'\n' | 0x0c)
            {
                self.pos += 1;
            }
            if self.pos < self.bytes.len() && self.bytes[self.pos] == b'%' {
                while self.pos < self.bytes.len() && self.bytes[self.pos] != b'\n' {
                    self.pos += 1;
                }
                continue;
            }
            if self.pos + 3 <= self.bytes.len()
                && self.bytes[self.pos..self.pos + 3] == [0xef, 0xbb, 0xbf]
            {
                self.pos += 3;
                continue;
            }
            break;
        }
    }

    fn parse_entry(&mut self) -> Result<(), String> {
        let start = self.pos;
        self.pos += 1;
        self.skip_ws();
        let type_start = self.pos;
        while self.pos < self.bytes.len()
            && (self.bytes[self.pos].is_ascii_alphanumeric()
                || self.bytes[self.pos] == b'_'
                || self.bytes[self.pos] == b'-')
        {
            self.pos += 1;
        }
        let entry_type = self.text[type_start..self.pos].to_ascii_lowercase();
        if entry_type.is_empty() {
            return Err("Expected a bibliography entry type after '@'.".into());
        }
        self.skip_ws();
        let open = *self
            .bytes
            .get(self.pos)
            .ok_or_else(|| "Bibliography entry is missing an opening delimiter.".to_string())?;
        if open != b'{' && open != b'(' {
            return Err("Bibliography entry must use '{' or '('.".into());
        }
        let close = if open == b'{' { b'}' } else { b')' };
        self.pos += 1;

        match entry_type.as_str() {
            "comment" | "preamble" => {
                self.skip_balanced(open, close)?;
                return Ok(());
            }
            "string" => {
                self.parse_string_entry(close)?;
                return Ok(());
            }
            _ => {}
        }

        self.skip_ws();
        let key_start = self.pos;
        while self.pos < self.bytes.len()
            && self.bytes[self.pos] != b','
            && self.bytes[self.pos] != close
        {
            self.pos += 1;
        }
        let key = self.text[key_start..self.pos].trim().to_string();
        if key.is_empty() {
            return Err("Bibliography entry is missing a citation key.".into());
        }
        if self.pos >= self.bytes.len() {
            return Err("Bibliography entry is unterminated.".into());
        }
        if self.bytes[self.pos] == close {
            self.pos += 1;
            self.push_entry(key, entry_type, BTreeMap::new(), start, self.pos);
            return Ok(());
        }
        if self.bytes[self.pos] != b',' {
            return Err("Expected ',' or a closing delimiter after the citation key.".into());
        }
        self.pos += 1;

        let mut fields = BTreeMap::new();
        loop {
            self.skip_ws();
            if self.pos >= self.bytes.len() {
                return Err("Bibliography entry is unterminated.".into());
            }
            if self.bytes[self.pos] == close {
                self.pos += 1;
                break;
            }
            let name_start = self.pos;
            while self.pos < self.bytes.len()
                && (self.bytes[self.pos].is_ascii_alphanumeric()
                    || self.bytes[self.pos] == b'_'
                    || self.bytes[self.pos] == b'-')
            {
                self.pos += 1;
            }
            let name = self.text[name_start..self.pos].to_ascii_lowercase();
            if name.is_empty() {
                return Err("Expected a bibliography field name.".into());
            }
            self.skip_ws();
            if self.bytes.get(self.pos) != Some(&b'=') {
                return Err(format!("Expected '=' after bibliography field '{name}'."));
            }
            self.pos += 1;
            let value = self.parse_value()?;
            fields.insert(name, value);
            self.skip_ws();
            match self.bytes.get(self.pos) {
                Some(&b',') => self.pos += 1,
                Some(&byte) if byte == close => {
                    self.pos += 1;
                    break;
                }
                Some(_) => {
                    return Err("Expected ',' or a closing delimiter after a field value.".into())
                }
                None => return Err("Bibliography entry is unterminated.".into()),
            }
        }

        self.push_entry(key, entry_type, fields, start, self.pos);
        Ok(())
    }

    fn parse_string_entry(&mut self, close: u8) -> Result<(), String> {
        loop {
            self.skip_ws();
            if self.bytes.get(self.pos) == Some(&close) {
                self.pos += 1;
                return Ok(());
            }
            let name_start = self.pos;
            while self.pos < self.bytes.len()
                && (self.bytes[self.pos].is_ascii_alphanumeric()
                    || self.bytes[self.pos] == b'_'
                    || self.bytes[self.pos] == b'-')
            {
                self.pos += 1;
            }
            let name = self.text[name_start..self.pos].to_ascii_lowercase();
            if name.is_empty() {
                return Err("Expected a name in an @string entry.".into());
            }
            self.skip_ws();
            if self.bytes.get(self.pos) != Some(&b'=') {
                return Err(format!("Expected '=' after @string name '{name}'."));
            }
            self.pos += 1;
            let value = self.parse_value()?;
            self.macros.insert(name, value);
            self.skip_ws();
            match self.bytes.get(self.pos) {
                Some(&b',') => self.pos += 1,
                Some(&byte) if byte == close => {
                    self.pos += 1;
                    return Ok(());
                }
                Some(_) => return Err("Expected ',' or '}' in an @string entry.".into()),
                None => return Err("@string entry is unterminated.".into()),
            }
        }
    }

    fn parse_value(&mut self) -> Result<String, String> {
        let mut value = String::new();
        loop {
            self.skip_ws();
            let term = match self.bytes.get(self.pos) {
                Some(&b'{') => {
                    let content_start = self.pos + 1;
                    let mut depth = 1usize;
                    self.pos += 1;
                    while self.pos < self.bytes.len() {
                        if self.bytes[self.pos] == b'\\' {
                            self.pos = (self.pos + 2).min(self.bytes.len());
                            continue;
                        }
                        if self.bytes[self.pos] == b'{' {
                            depth += 1;
                        } else if self.bytes[self.pos] == b'}' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        self.pos += 1;
                    }
                    if depth != 0 || self.pos >= self.bytes.len() {
                        return Err("Unterminated braced bibliography value.".into());
                    }
                    let term = self.text[content_start..self.pos].to_string();
                    self.pos += 1;
                    term
                }
                Some(&b'"') => {
                    let content_start = self.pos + 1;
                    self.pos += 1;
                    while self.pos < self.bytes.len() {
                        if self.bytes[self.pos] == b'\\' {
                            self.pos = (self.pos + 2).min(self.bytes.len());
                            continue;
                        }
                        if self.bytes[self.pos] == b'"' {
                            break;
                        }
                        self.pos += 1;
                    }
                    if self.pos >= self.bytes.len() {
                        return Err("Unterminated quoted bibliography value.".into());
                    }
                    let term = self.text[content_start..self.pos].to_string();
                    self.pos += 1;
                    term
                }
                Some(&byte) if byte.is_ascii_digit() => {
                    let start = self.pos;
                    while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_digit() {
                        self.pos += 1;
                    }
                    self.text[start..self.pos].to_string()
                }
                Some(&byte) if byte.is_ascii_alphabetic() || byte == b'_' => {
                    let start = self.pos;
                    while self.pos < self.bytes.len()
                        && (self.bytes[self.pos].is_ascii_alphanumeric()
                            || self.bytes[self.pos] == b'_'
                            || self.bytes[self.pos] == b'-')
                    {
                        self.pos += 1;
                    }
                    let name = &self.text[start..self.pos];
                    self.macros
                        .get(&name.to_ascii_lowercase())
                        .cloned()
                        .unwrap_or_else(|| name.to_string())
                }
                _ => return Err("Expected a bibliography field value.".into()),
            };
            value.push_str(&term);
            self.skip_ws();
            if self.bytes.get(self.pos) == Some(&b'#') {
                self.pos += 1;
                continue;
            }
            return Ok(value);
        }
    }

    fn skip_balanced(&mut self, open: u8, close: u8) -> Result<(), String> {
        let mut depth = 1usize;
        while self.pos < self.bytes.len() {
            if self.bytes[self.pos] == b'\\' {
                self.pos = (self.pos + 2).min(self.bytes.len());
                continue;
            }
            if self.bytes[self.pos] == open {
                depth += 1;
            } else if self.bytes[self.pos] == close {
                depth -= 1;
                if depth == 0 {
                    self.pos += 1;
                    return Ok(());
                }
            }
            self.pos += 1;
        }
        Err("Bibliography entry is unterminated.".into())
    }

    fn push_entry(
        &mut self,
        key: String,
        entry_type: String,
        fields: BTreeMap<String, String>,
        start: usize,
        end: usize,
    ) {
        let title = fields
            .get("title")
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let authors = fields
            .get("author")
            .or_else(|| fields.get("editor"))
            .map(|value| split_authors(value))
            .unwrap_or_default();
        let year = entry_year(&fields);
        self.result.entries.push(ParsedEntry {
            key,
            entry_type,
            fields,
            title,
            authors,
            year,
            start,
            end,
        });
    }

    fn next_entry_start(&self, from: usize) -> usize {
        let mut search = from.min(self.text.len());
        while let Some(offset) = self.text[search..].find('@') {
            let at = search + offset;
            let line_start = self.text[..at].rfind('\n').map_or(0, |index| index + 1);
            if self.text[line_start..at].trim().is_empty() {
                return at;
            }
            search = at + 1;
        }
        self.text.len()
    }
}

fn split_authors(value: &str) -> Vec<String> {
    let bytes = value.as_bytes();
    let mut authors = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => depth += 1,
            b'}' => depth = depth.saturating_sub(1),
            _ if depth == 0
                && index + 5 <= bytes.len()
                && bytes[index..index + 5].eq_ignore_ascii_case(b" and ") =>
            {
                let author = value[start..index].trim();
                if !author.is_empty() {
                    authors.push(author.to_string());
                }
                index += 5;
                start = index;
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    let author = value[start..].trim();
    if !author.is_empty() {
        authors.push(author.to_string());
    }
    authors
}

fn entry_year(fields: &BTreeMap<String, String>) -> Option<String> {
    fields
        .get("year")
        .or_else(|| fields.get("date"))
        .map(|value| {
            let value = value.trim();
            let candidate = value
                .split(|character: char| character == '-' || character == '/')
                .next()
                .unwrap_or(value)
                .trim();
            if candidate.is_empty() {
                String::new()
            } else {
                candidate.chars().take(4).collect()
            }
        })
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entries_fields_and_utf8_content() {
        let text = r#"
@article{khmer2026,
  author = {Sovichea and Dara},
  title = {A {Nested} Khmer Title},
  year = {2026},
  journal = {Journal of Tests},
}

@book{other,
  editor = {Editor One},
  title = "Quoted title",
  date = {2024-05},
}
"#;
        let parsed = parse_bibliography(text);
        assert_eq!(parsed.entries.len(), 2);
        assert!(parsed.diagnostics.is_empty());
        let first = &parsed.entries[0];
        assert_eq!(first.key, "khmer2026");
        assert_eq!(first.entry_type, "article");
        assert_eq!(first.title, "A {Nested} Khmer Title");
        assert_eq!(first.authors, vec!["Sovichea", "Dara"]);
        assert_eq!(first.year.as_deref(), Some("2026"));
        assert_eq!(
            first.fields.get("journal").map(String::as_str),
            Some("Journal of Tests")
        );
        let second = &parsed.entries[1];
        assert_eq!(second.title, "Quoted title");
        assert_eq!(second.authors, vec!["Editor One"]);
        assert_eq!(second.year.as_deref(), Some("2024"));
    }

    #[test]
    fn expands_string_macros_and_concatenation() {
        let text = r#"
@string{jtest = "Journal of Tests"}
@article{one,
  title = "Part " # {Two},
  journal = jtest,
  year = 2026,
}
"#;
        let parsed = parse_bibliography(text);
        assert_eq!(parsed.entries.len(), 1);
        let entry = &parsed.entries[0];
        assert_eq!(
            entry.fields.get("title").map(String::as_str),
            Some("Part Two")
        );
        assert_eq!(
            entry.fields.get("journal").map(String::as_str),
            Some("Journal of Tests")
        );
        assert_eq!(entry.year.as_deref(), Some("2026"));
    }

    #[test]
    fn ignores_comments_strings_and_preamble() {
        let text = r#"
% a comment
@comment{ignored @article{fake, title={Fake}}}
@preamble{"\newcommand{\foo}{bar}"}
@article{real, title={Real}}
"#;
        let parsed = parse_bibliography(text);
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].key, "real");
        assert!(parsed.diagnostics.is_empty());
    }

    #[test]
    fn reports_malformed_entry_and_recovers() {
        let text = r#"
@article{bad, title "missing equals"}
@article{good, title={Good}}
"#;
        let parsed = parse_bibliography(text);
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].key, "good");
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].code, "malformed-bib-entry");
    }

    #[test]
    fn tracks_entry_ranges_in_utf16() {
        let text = "@article{one, title={Tiêu đề}}\n@book{two, title={Second}}";
        let parsed = parse_bibliography(text);
        assert_eq!(parsed.entries.len(), 2);
        let first = &parsed.entries[0];
        assert_eq!(
            &text[first.start..first.end],
            "@article{one, title={Tiêu đề}}"
        );
        assert_eq!(utf16_len(&text[..first.start]), 0);
        assert_eq!(
            utf16_len(&text[..first.end]),
            "@article{one, title={Tiêu đề}}".encode_utf16().count()
        );
    }

    #[test]
    fn discovers_bib_files_and_reports_duplicate_keys() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        std::fs::write(
            root.join("refs.bib"),
            "@article{one, title={First}}\n@article{shared, title={Shared A}}",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(
            root.join("chapters").join("more.bib"),
            "@book{shared, title={Shared B}}\n@book{two, title={Second}}",
        )
        .unwrap();
        std::fs::write(root.join("notes.txt"), "not a bibliography").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.bib\n").unwrap();
        std::fs::write(root.join("ignored.bib"), "@book{ignored, title={Ignored}}").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("config"), "").unwrap();

        let index = build_bibliography_index(root.to_str().unwrap()).unwrap();
        assert_eq!(index.files.len(), 2);
        assert_eq!(index.entries.len(), 4);
        assert!(index.entries.iter().any(|entry| entry.key == "one"));
        assert!(index.entries.iter().any(|entry| entry.key == "two"));
        assert!(!index.entries.iter().any(|entry| entry.key == "ignored"));
        assert_eq!(
            index
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "duplicate-citation-key")
                .count(),
            1
        );
    }

    #[test]
    fn reports_unreadable_bibliography_files() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        std::fs::write(root.join("bad.bib"), b"\xff\xfe\x00binary").unwrap();
        let index = build_bibliography_index(root.to_str().unwrap()).unwrap();
        assert!(index.files.is_empty());
        assert_eq!(index.diagnostics.len(), 1);
        assert_eq!(index.diagnostics[0].code, "unreadable-bibliography-file");
    }
}
