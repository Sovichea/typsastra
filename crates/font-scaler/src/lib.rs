use std::fmt;

const CHECKSUM_MAGIC: u32 = 0xB1B0_AFBA;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScaleError {
    UnsupportedCollection,
    InvalidFont,
    MissingHeadTable,
    InvalidScale,
    MissingNameTable,
}

impl fmt::Display for ScaleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::UnsupportedCollection => "font collections are not supported",
            Self::InvalidFont => "invalid or truncated OpenType font",
            Self::MissingHeadTable => "font has no valid head table",
            Self::InvalidScale => "scale must be between 0.5 and 2.0",
            Self::MissingNameTable => "font has no valid name table",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ScaleError {}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn write_u16(bytes: &mut [u8], offset: usize, value: u16) -> Result<(), ScaleError> {
    bytes
        .get_mut(offset..offset + 2)
        .ok_or(ScaleError::InvalidFont)?
        .copy_from_slice(&value.to_be_bytes());
    Ok(())
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) -> Result<(), ScaleError> {
    bytes
        .get_mut(offset..offset + 4)
        .ok_or(ScaleError::InvalidFont)?
        .copy_from_slice(&value.to_be_bytes());
    Ok(())
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

/// Uniformly scale an individual OpenType face by changing its units-per-em.
/// All coordinates and metrics remain internally consistent because shaping
/// engines interpret every font-unit value against the new em square.
pub fn scale_font_uniform(bytes: &[u8], scale: f32) -> Result<Vec<u8>, ScaleError> {
    if !scale.is_finite() || !(0.5..=2.0).contains(&scale) {
        return Err(ScaleError::InvalidScale);
    }
    if bytes.get(..4) == Some(b"ttcf") {
        return Err(ScaleError::UnsupportedCollection);
    }
    if !matches!(bytes.get(..4), Some(b"\0\x01\0\0" | b"OTTO" | b"true")) {
        return Err(ScaleError::InvalidFont);
    }

    let table_count = read_u16(bytes, 4).ok_or(ScaleError::InvalidFont)? as usize;
    let directory_end = 12usize
        .checked_add(table_count.checked_mul(16).ok_or(ScaleError::InvalidFont)?)
        .ok_or(ScaleError::InvalidFont)?;
    if directory_end > bytes.len() {
        return Err(ScaleError::InvalidFont);
    }

    let mut head_record = None;
    for index in 0..table_count {
        let record = 12 + index * 16;
        if bytes.get(record..record + 4) == Some(b"head") {
            let offset = read_u32(bytes, record + 8).ok_or(ScaleError::InvalidFont)? as usize;
            let length = read_u32(bytes, record + 12).ok_or(ScaleError::InvalidFont)? as usize;
            if length < 20
                || offset
                    .checked_add(length)
                    .is_none_or(|end| end > bytes.len())
            {
                return Err(ScaleError::MissingHeadTable);
            }
            head_record = Some((record, offset, length));
            break;
        }
    }
    let (record, head_offset, head_length) = head_record.ok_or(ScaleError::MissingHeadTable)?;
    let original_upem = read_u16(bytes, head_offset + 18).ok_or(ScaleError::MissingHeadTable)?;
    let scaled_upem = ((original_upem as f32) / scale)
        .round()
        .clamp(16.0, 16_384.0) as u16;

    let mut output = bytes.to_vec();
    write_u16(&mut output, head_offset + 18, scaled_upem)?;
    write_u32(&mut output, head_offset + 8, 0)?;
    let head_checksum = checksum(&output[head_offset..head_offset + head_length]);
    write_u32(&mut output, record + 4, head_checksum)?;
    let adjustment = CHECKSUM_MAGIC.wrapping_sub(checksum(&output));
    write_u32(&mut output, head_offset + 8, adjustment)?;
    Ok(output)
}

/// Scale a face and give it a distinct family identity. Prepared variants must
/// not retain the source family: otherwise font selection collapses multiple
/// percentages into whichever face the platform font database finds first.
pub fn scale_and_rename_font(
    bytes: &[u8],
    scale: f32,
    family: &str,
) -> Result<Vec<u8>, ScaleError> {
    let scaled = scale_font_uniform(bytes, scale)?;
    rewrite_name_table(&scaled, family)
}

fn rewrite_name_table(bytes: &[u8], family: &str) -> Result<Vec<u8>, ScaleError> {
    let table_count = read_u16(bytes, 4).ok_or(ScaleError::InvalidFont)? as usize;
    let mut tables = Vec::<([u8; 4], Vec<u8>)>::new();
    let mut found_name = false;
    for index in 0..table_count {
        let record = 12 + index * 16;
        let tag: [u8; 4] = bytes
            .get(record..record + 4)
            .ok_or(ScaleError::InvalidFont)?
            .try_into()
            .map_err(|_| ScaleError::InvalidFont)?;
        let offset = read_u32(bytes, record + 8).ok_or(ScaleError::InvalidFont)? as usize;
        let length = read_u32(bytes, record + 12).ok_or(ScaleError::InvalidFont)? as usize;
        let data = bytes
            .get(offset..offset.checked_add(length).ok_or(ScaleError::InvalidFont)?)
            .ok_or(ScaleError::InvalidFont)?;
        let data = if &tag == b"name" {
            found_name = true;
            renamed_name_table(data, family)?
        } else {
            data.to_vec()
        };
        tables.push((tag, data));
    }
    if !found_name {
        return Err(ScaleError::MissingNameTable);
    }

    let directory_len = 12 + tables.len() * 16;
    let mut output = vec![0u8; directory_len];
    output[..12].copy_from_slice(bytes.get(..12).ok_or(ScaleError::InvalidFont)?);
    let mut cursor = directory_len;
    let mut head_offset = None;
    for (index, (tag, data)) in tables.iter().enumerate() {
        cursor = (cursor + 3) & !3;
        output.resize(cursor, 0);
        let offset = cursor;
        output.extend_from_slice(data);
        cursor += data.len();
        let record = 12 + index * 16;
        output[record..record + 4].copy_from_slice(tag);
        write_u32(&mut output, record + 4, checksum(data))?;
        write_u32(&mut output, record + 8, offset as u32)?;
        write_u32(&mut output, record + 12, data.len() as u32)?;
        if tag == b"head" {
            head_offset = Some((record, offset, data.len()));
        }
    }
    output.resize((output.len() + 3) & !3, 0);
    let (head_record, head, head_len) = head_offset.ok_or(ScaleError::MissingHeadTable)?;
    write_u32(&mut output, head + 8, 0)?;
    let head_checksum = checksum(&output[head..head + head_len]);
    write_u32(&mut output, head_record + 4, head_checksum)?;
    let adjustment = CHECKSUM_MAGIC.wrapping_sub(checksum(&output));
    write_u32(&mut output, head + 8, adjustment)?;
    Ok(output)
}

fn renamed_name_table(table: &[u8], family: &str) -> Result<Vec<u8>, ScaleError> {
    let format = read_u16(table, 0).ok_or(ScaleError::MissingNameTable)?;
    let count = read_u16(table, 2).ok_or(ScaleError::MissingNameTable)? as usize;
    let storage = read_u16(table, 4).ok_or(ScaleError::MissingNameTable)? as usize;
    if format > 1 || storage > table.len() || 6 + count * 12 > table.len() {
        return Err(ScaleError::MissingNameTable);
    }
    let mut records = Vec::with_capacity(count);
    let mut strings = Vec::new();
    for index in 0..count {
        let offset = 6 + index * 12;
        let platform = read_u16(table, offset).ok_or(ScaleError::MissingNameTable)?;
        let encoding = read_u16(table, offset + 2).ok_or(ScaleError::MissingNameTable)?;
        let language = read_u16(table, offset + 4).ok_or(ScaleError::MissingNameTable)?;
        let name_id = read_u16(table, offset + 6).ok_or(ScaleError::MissingNameTable)?;
        let length = read_u16(table, offset + 8).ok_or(ScaleError::MissingNameTable)? as usize;
        let old_offset = read_u16(table, offset + 10).ok_or(ScaleError::MissingNameTable)? as usize;
        let old = table
            .get(storage + old_offset..storage + old_offset + length)
            .ok_or(ScaleError::MissingNameTable)?;
        let replace = matches!(name_id, 1 | 4 | 6 | 16);
        let value = if replace {
            encode_name(family, platform, name_id == 6)
        } else {
            old.to_vec()
        };
        let string_offset = u16::try_from(strings.len()).map_err(|_| ScaleError::InvalidFont)?;
        let string_length = u16::try_from(value.len()).map_err(|_| ScaleError::InvalidFont)?;
        strings.extend_from_slice(&value);
        records.push((
            platform,
            encoding,
            language,
            name_id,
            string_length,
            string_offset,
        ));
    }
    let header_len = 6 + records.len() * 12;
    let mut output = vec![0u8; header_len];
    write_u16(&mut output, 0, 0)?; // Drop format-1 language tags; records remain valid.
    write_u16(&mut output, 2, records.len() as u16)?;
    write_u16(&mut output, 4, header_len as u16)?;
    for (index, record) in records.into_iter().enumerate() {
        let offset = 6 + index * 12;
        for (field, value) in [record.0, record.1, record.2, record.3, record.4, record.5]
            .into_iter()
            .enumerate()
        {
            write_u16(&mut output, offset + field * 2, value)?;
        }
    }
    output.extend_from_slice(&strings);
    Ok(output)
}

fn encode_name(value: &str, platform: u16, postscript: bool) -> Vec<u8> {
    let value = if postscript {
        value
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>()
    } else {
        value.to_string()
    };
    if platform == 0 || platform == 3 {
        value.encode_utf16().flat_map(u16::to_be_bytes).collect()
    } else {
        value
            .bytes()
            .map(|byte| if byte.is_ascii() { byte } else { b'?' })
            .collect()
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn scale_font_uniform_wasm(bytes: &[u8], scale: f32) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    scale_font_uniform(bytes, scale)
        .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_font() -> Vec<u8> {
        let mut bytes = vec![0u8; 12 + 16 + 54];
        bytes[..4].copy_from_slice(b"\0\x01\0\0");
        bytes[4..6].copy_from_slice(&1u16.to_be_bytes());
        bytes[12..16].copy_from_slice(b"head");
        bytes[20..24].copy_from_slice(&28u32.to_be_bytes());
        bytes[24..28].copy_from_slice(&54u32.to_be_bytes());
        bytes[46..48].copy_from_slice(&1000u16.to_be_bytes());
        bytes
    }

    #[test]
    fn scales_the_whole_em_square() {
        let scaled = scale_font_uniform(&minimal_font(), 1.05).unwrap();
        assert_eq!(read_u16(&scaled, 46), Some(952));
        assert_ne!(read_u32(&scaled, 36), Some(0));
    }

    #[test]
    fn rejects_collections_and_unsafe_scales() {
        assert_eq!(
            scale_font_uniform(b"ttcf", 1.0),
            Err(ScaleError::UnsupportedCollection)
        );
        assert_eq!(
            scale_font_uniform(&minimal_font(), 0.1),
            Err(ScaleError::InvalidScale)
        );
    }

    #[test]
    fn scales_a_real_opentype_font() {
        let source = include_bytes!("../../../src-tauri/fonts/MiSansLatin-Regular.ttf");
        let scaled = scale_font_uniform(source, 1.05).unwrap();
        assert_eq!(scaled.len(), source.len());
        assert_ne!(scaled, source);
        let face = ttf_parser::Face::parse(&scaled, 0).unwrap();
        assert_eq!(face.units_per_em(), 952);
    }

    #[test]
    fn assigns_a_distinct_prepared_family_name() {
        let source = include_bytes!("../../../src-tauri/fonts/MiSansLatin-Regular.ttf");
        let scaled = scale_and_rename_font(source, 0.95, "MiSans Latin 95").unwrap();
        let face = ttf_parser::Face::parse(&scaled, 0).unwrap();
        assert_eq!(face.units_per_em(), 1053);
        assert!(face.names().into_iter().any(|name| {
            name.name_id == ttf_parser::name_id::FAMILY
                && name.to_string().as_deref() == Some("MiSans Latin 95")
        }));
    }
}
