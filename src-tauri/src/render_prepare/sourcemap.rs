use serde::{Deserialize, Serialize};

pub const SOURCE_MAP_VERSION: u32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MappingKind {
    Original,
    GeneratedWrapper,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextMapping {
    pub generated_start: usize,
    pub generated_end: usize,
    pub source_start: usize,
    pub source_end: usize,
    pub kind: MappingKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceMap {
    pub version: u32,
    pub source_file: String,
    pub generated_file: String,
    #[serde(default)]
    pub source_digest: String,
    pub mappings: Vec<TextMapping>,
    #[serde(default)]
    pub preview_content_mode: String,
}

impl SourceMap {
    pub fn new(source_file: String, generated_file: String) -> Self {
        Self {
            version: SOURCE_MAP_VERSION,
            source_file,
            generated_file,
            source_digest: String::new(),
            mappings: Vec::new(),
            preview_content_mode: "normal".into(),
        }
    }

    pub fn add_mapping(
        &mut self,
        generated_start: usize,
        generated_end: usize,
        source_start: usize,
        source_end: usize,
        kind: MappingKind,
    ) {
        self.mappings.push(TextMapping {
            generated_start,
            generated_end,
            source_start,
            source_end,
            kind,
        });
    }

    pub fn generated_to_source(&self, generated_offset: usize) -> Option<usize> {
        let idx = self.mappings.binary_search_by(|m| {
            if generated_offset < m.generated_start {
                std::cmp::Ordering::Greater
            } else if generated_offset >= m.generated_end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        });
        match idx {
            Ok(i) => {
                let m = &self.mappings[i];
                match m.kind {
                    MappingKind::Original => {
                        let offset_in_mapping = generated_offset - m.generated_start;
                        Some(m.source_start + offset_in_mapping)
                    }
                    MappingKind::GeneratedWrapper => Some(m.source_start),
                }
            }
            Err(_) => {
                if self.mappings.is_empty() {
                    return None;
                }
                if generated_offset >= self.mappings.last().unwrap().generated_end {
                    return Some(self.mappings.last().unwrap().source_end);
                }
                if generated_offset <= self.mappings.first().unwrap().generated_start {
                    return Some(self.mappings.first().unwrap().source_start);
                }
                let insert_idx = self
                    .mappings
                    .partition_point(|m| m.generated_start <= generated_offset);
                if insert_idx > 0 {
                    let prev = &self.mappings[insert_idx - 1];
                    Some(prev.source_end)
                } else {
                    None
                }
            }
        }
    }

    pub fn source_to_generated(&self, source_offset: usize) -> Option<usize> {
        for m in &self.mappings {
            if m.kind == MappingKind::Original
                && source_offset >= m.source_start
                && source_offset < m.source_end
            {
                let offset_in_mapping = source_offset - m.source_start;
                return Some(m.generated_start + offset_in_mapping);
            }
        }
        for m in &self.mappings {
            if source_offset == m.source_start {
                return Some(m.generated_start);
            }
        }
        if let Some(last) = self.mappings.last() {
            if source_offset >= last.source_end {
                return Some(last.generated_end);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sourcemap_lookups() {
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());

        map.add_mapping(0, 3, 0, 3, MappingKind::Original);
        map.add_mapping(3, 10, 3, 8, MappingKind::GeneratedWrapper);
        map.add_mapping(10, 13, 8, 11, MappingKind::Original);

        assert_eq!(map.generated_to_source(1), Some(1));
        assert_eq!(map.generated_to_source(5), Some(3));
        assert_eq!(map.generated_to_source(11), Some(9));

        assert_eq!(map.source_to_generated(1), Some(1));
        assert_eq!(map.source_to_generated(3), Some(3));
        assert_eq!(map.source_to_generated(9), Some(11));
        assert_eq!(map.source_to_generated(11), Some(13));
    }
}
