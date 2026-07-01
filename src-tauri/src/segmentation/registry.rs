use super::provider::{LanguageSegmenter, RenderReplacement, SegmentToken, TextAnalysis};
use khmer_segmenter::kdict::KHypDict;
use khmer_segmenter::{KhmerSegmenter, SegmenterConfig};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

const KHMER_DICTIONARY: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_dictionary.kdict");
const KHMER_WORDS: &str = include_str!(
    "../../../third_party/khmer_segmenter/khmer_segmenter/dictionary_data/khmer_dictionary_words.txt"
);
const KHMER_HYPHENATION: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_hyphenation.kdict");

struct KhmerProvider {
    segmenter: KhmerSegmenter,
    words: Vec<String>,
    known: HashSet<String>,
    hyphenation: KHypDict,
}

impl KhmerProvider {
    fn new() -> Result<Self, String> {
        let segmenter =
            KhmerSegmenter::from_bytes(KHMER_DICTIONARY.to_vec(), SegmenterConfig::default())
                .map_err(|error| format!("Failed to load Khmer dictionary: {error}"))?;
        let mut words: Vec<String> = KHMER_WORDS
            .lines()
            .map(str::trim)
            .filter(|word| !word.is_empty())
            .map(str::to_owned)
            .collect();
        words.sort();
        words.dedup();
        let known = words.iter().cloned().collect();
        let hyphenation = KHypDict::from_bytes(KHMER_HYPHENATION.to_vec())
            .map_err(|error| format!("Failed to load Khmer hyphenation dictionary: {error}"))?;
        Ok(Self {
            segmenter,
            words,
            known,
            hyphenation,
        })
    }

    fn has_prefix(&self, prefix: &str) -> bool {
        let index = self
            .words
            .partition_point(|candidate| candidate.as_str() < prefix);
        self.words
            .get(index)
            .is_some_and(|candidate| candidate.starts_with(prefix))
    }
}



fn edit_distance(left: &str, right: &str) -> usize {
    let right_chars: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right_chars.len()).collect();
    for (left_index, left_char) in left.chars().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_char) in right_chars.iter().enumerate() {
            current.push(
                (previous[right_index + 1] + 1)
                    .min(current[right_index] + 1)
                    .min(previous[right_index] + usize::from(left_char != *right_char)),
            );
        }
        previous = current;
    }
    previous[right_chars.len()]
}

impl LanguageSegmenter for KhmerProvider {
    fn id(&self) -> &'static str {
        "khmer-segmenter"
    }

    fn pattern(&self) -> &'static str {
        "[\u{1780}-\u{17ff}]+"
    }

    fn supports(&self, text: &str) -> bool {
        text.chars()
            .any(|character| ('\u{1780}'..='\u{17ff}').contains(&character))
    }

    fn analyze(&self, text: &str) -> Result<TextAnalysis, String> {
        let result = self
            .segmenter
            .segment_detailed(text)
            .map_err(|error| error.to_string())?;
        let normalized = result.normalized();
        let clean_text: String = text
            .chars()
            .filter(|&c| c != '\u{200b}' && c != '\u{200c}' && c != '\u{200d}')
            .collect();
        let normalized_changed = normalized != clean_text;

        let tokens = if normalized_changed {
            Vec::new()
        } else {
            // Build norm_to_orig_char_idx
            let mut norm_to_orig_char_idx = Vec::with_capacity(normalized.chars().count() + 1);
            let mut orig_char_idx = 0;
            for c in text.chars() {
                if c == '\u{200b}' || c == '\u{200c}' || c == '\u{200d}' {
                    orig_char_idx += 1;
                    continue;
                }
                norm_to_orig_char_idx.push(orig_char_idx);
                orig_char_idx += 1;
            }
            norm_to_orig_char_idx.push(orig_char_idx);

            // Build char_to_utf16 for original text
            let mut char_to_utf16 = Vec::with_capacity(text.chars().count() + 1);
            let mut current_utf16 = 0;
            for c in text.chars() {
                char_to_utf16.push(current_utf16);
                current_utf16 += c.len_utf16();
            }
            char_to_utf16.push(current_utf16);

            // Build norm_byte_to_char for normalized text
            let mut norm_byte_to_char = Vec::with_capacity(normalized.len() + 1);
            let mut current_char = 0;
            for c in normalized.chars() {
                let len = c.len_utf8();
                for _ in 0..len {
                    norm_byte_to_char.push(current_char);
                }
                current_char += 1;
            }
            norm_byte_to_char.push(current_char);

            let is_spelling_char = |c: char| c >= '\u{1780}' && c <= '\u{17d3}';

            result
                .ranges()
                .iter()
                .map(|range| {
                    let token = &normalized[range.clone()];
                    let known = !token.chars().any(is_spelling_char)
                        || self.known.contains(token);

                    let norm_char_start = norm_byte_to_char[range.start];
                    let norm_char_end = norm_byte_to_char[range.end];
                    
                    let orig_char_start = norm_to_orig_char_idx[norm_char_start];
                    let orig_char_end = norm_to_orig_char_idx[norm_char_end];

                    let from_utf16 = char_to_utf16[orig_char_start];
                    let to_utf16 = char_to_utf16[orig_char_end];

                    SegmentToken {
                        text: token.to_owned(),
                        from: from_utf16,
                        to: to_utf16,
                        known,
                        known_prefix: known || self.has_prefix(token),
                    }
                })
                .collect()
        };
        Ok(TextAnalysis {
            provider: self.id(),
            normalized_changed,
            tokens,
        })
    }

    fn suggestions(&self, word: &str, limit: usize) -> Vec<String> {
        let first = word.chars().next();
        let length = word.chars().count();
        let mut candidates: Vec<(usize, &str)> = self
            .words
            .iter()
            .map(String::as_str)
            .filter(|candidate| candidate.chars().next() == first)
            .filter(|candidate| candidate.chars().count().abs_diff(length) <= 2)
            .map(|candidate| (edit_distance(word, candidate), candidate))
            .filter(|(distance, _)| *distance <= 3)
            .collect();
        candidates.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.len().cmp(&right.1.len()))
        });
        candidates.dedup_by(|left, right| left.1 == right.1);
        candidates
            .into_iter()
            .take(limit)
            .map(|(_, candidate)| candidate.to_owned())
            .collect()
    }

    fn autocomplete(&self, prefix: &str, limit: usize) -> Vec<String> {
        if prefix.is_empty() {
            return Vec::new();
        }
        let index = self
            .words
            .partition_point(|candidate| candidate.as_str() < prefix);
        self.words
            .iter()
            .skip(index)
            .take_while(|candidate| candidate.starts_with(prefix))
            .cloned()
            .take(limit)
            .collect()
    }

    fn render_replacements(&self, text: &str) -> Vec<RenderReplacement> {
        let mut runs = Vec::new();
        let mut start = None;
        for (index, character) in text.char_indices() {
            let is_khmer = ('\u{1780}'..='\u{17ff}').contains(&character);
            match (start, is_khmer) {
                (None, true) => start = Some(index),
                (Some(from), false) => {
                    runs.push(&text[from..index]);
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(from) = start {
            runs.push(&text[from..]);
        }

        runs.into_iter()
            .filter_map(|source| {
                let segmentation = self.segmenter.segment_detailed(source).ok()?;
                if segmentation.normalized() != source {
                    return None;
                }
                let segmented = segmentation.join("\u{200b}");
                let hyphenated = segmentation
                    .tokens()
                    .map(|token| {
                        self.hyphenation
                            .lookup(token)
                            .map(|value| value.replace('\u{200b}', "\u{00ad}"))
                            .unwrap_or_else(|| token.to_owned())
                    })
                    .collect::<Vec<_>>()
                    .join("\u{200b}");
                (segmented != source || hyphenated != source).then(|| RenderReplacement {
                    source: source.to_owned(),
                    segmented,
                    hyphenated,
                })
            })
            .collect()
    }
}

pub struct SegmentationRegistry {
    providers: Vec<Arc<dyn LanguageSegmenter>>,
    cache: Arc<std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (std::time::SystemTime, Vec<Vec<RenderReplacement>>)>>>,
}

fn collect_replacements(
    root: &std::path::Path,
    active_path: &std::path::Path,
    active_contents: &str,
    providers: &[Arc<dyn LanguageSegmenter>],
    cache: &std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (std::time::SystemTime, Vec<Vec<RenderReplacement>>)>>,
    all_replacements: &mut Vec<Vec<RenderReplacement>>,
) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            if name != ".git" && name != "target" && name != "node_modules" {
                collect_replacements(&path, active_path, active_contents, providers, cache, all_replacements);
            }
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("typ")
            && !path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .contains("typstry-preview")
        {
            let is_active = path.to_string_lossy().to_lowercase() == active_path.to_string_lossy().to_lowercase();
            if is_active {
                let replacements: Vec<Vec<RenderReplacement>> = providers
                    .iter()
                    .map(|provider| provider.render_replacements(active_contents))
                    .collect();
                for (i, reps) in replacements.into_iter().enumerate() {
                    all_replacements[i].extend(reps);
                }
            } else {
                let modified = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .unwrap_or_else(|_| std::time::SystemTime::now());
                
                let cached_reps = {
                    let lock = cache.lock().unwrap();
                    if let Some((time, cached)) = lock.get(&path) {
                        if *time == modified {
                            Some(cached.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                let replacements = if let Some(reps) = cached_reps {
                    reps
                } else if let Ok(source) = std::fs::read_to_string(&path) {
                    let reps: Vec<Vec<RenderReplacement>> = providers
                        .iter()
                        .map(|provider| provider.render_replacements(&source))
                        .collect();
                    let mut lock = cache.lock().unwrap();
                    lock.insert(path.clone(), (modified, reps.clone()));
                    reps
                } else {
                    continue;
                };

                for (i, reps) in replacements.into_iter().enumerate() {
                    all_replacements[i].extend(reps);
                }
            }
        }
    }
}

fn typst_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

impl SegmentationRegistry {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            providers: vec![Arc::new(KhmerProvider::new()?)],
            cache: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        })
    }
}

#[tauri::command]
pub async fn analyze_text(
    registry: tauri::State<'_, SegmentationRegistry>,
    text: String,
) -> Result<Option<TextAnalysis>, String> {
    let providers = registry.providers.clone();
    tokio::task::spawn_blocking(move || -> Result<Option<TextAnalysis>, String> {
        let provider = providers
            .iter()
            .find(|provider| provider.supports(&text));
        
        if let Some(provider) = provider {
            provider.analyze(&text).map(Some)
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn spelling_suggestions(
    registry: tauri::State<'_, SegmentationRegistry>,
    word: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let providers = registry.providers.clone();
    tokio::task::spawn_blocking(move || -> Vec<String> {
        let provider = providers
            .iter()
            .find(|provider| provider.supports(&word));
            
        if let Some(provider) = provider {
            provider.suggestions(&word, limit.unwrap_or(5).min(10))
        } else {
            Vec::new()
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn autocomplete_khmer(
    registry: tauri::State<'_, SegmentationRegistry>,
    prefix: String,
    limit: usize,
) -> Result<Vec<String>, String> {
    let providers = registry.providers.clone();
    tokio::task::spawn_blocking(move || -> Vec<String> {
        let provider = providers
            .iter()
            .find(|provider| provider.supports(&prefix));
            
        if let Some(provider) = provider {
            provider.autocomplete(&prefix, limit.min(50))
        } else {
            Vec::new()
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn segmentation_prelude(
    registry: tauri::State<'_, SegmentationRegistry>,
    workspace_root_path: String,
    active_file_path: String,
    active_contents: String,
) -> Result<String, String> {
    let providers = registry.providers.clone();
    let cache = registry.cache.clone();
    
    tokio::task::spawn_blocking(move || -> String {
        let mut all_replacements = vec![Vec::new(); providers.len()];
        collect_replacements(
            &PathBuf::from(workspace_root_path),
            &PathBuf::from(active_file_path),
            &active_contents,
            &providers,
            &cache,
            &mut all_replacements,
        );
        
        let mut prelude = String::new();
        for (index, provider) in providers.iter().enumerate() {
            let mut replacements = std::mem::take(&mut all_replacements[index]);
            replacements.sort_by(|left, right| left.source.cmp(&right.source));
            replacements.dedup_by(|left, right| left.source == right.source);

            if replacements.is_empty() {
                continue;
            }

            let dict_entries = replacements
                .into_iter()
                .map(|replacement| {
                    format!(
                        "{}: ({}, {}),",
                        typst_string(&replacement.source),
                        typst_string(&replacement.hyphenated),
                        typst_string(&replacement.segmented),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n  ");
                
            prelude.push_str(&format!(
                "#let __typstry_segs_{} = (\n  {}\n)\n",
                index, dict_entries
            ));
            prelude.push_str(&format!(
                "#show regex({}): it => {{\n  if it.text in __typstry_segs_{} {{\n    let rep = __typstry_segs_{}.at(it.text)\n    text(rep.at(1))\n  }} else {{\n    it\n  }}\n}}\n",
                typst_string(provider.pattern()), index, index
            ));
        }
        prelude
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzes_khmer_with_editor_safe_ranges() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        let analysis = provider.analyze("ក្រុមហ៊ុនទទួលបានប្រាក់ចំណូល").expect("analysis");
        assert!(!analysis.normalized_changed);
        assert!(!analysis.tokens.is_empty());
        assert!(analysis.tokens.iter().all(|token| token.from <= token.to));
    }

    #[test]
    fn emits_discretionary_hyphenation_for_typst() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        let replacements = provider.render_replacements("កក្រើករំជួល");
        assert!(replacements
            .iter()
            .any(|replacement| replacement.hyphenated.contains('\u{00ad}')));
    }
}
