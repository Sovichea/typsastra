use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use typst_syntax::ast::{Arg, AstNode, ContentBlock, Expr, FuncCall};
use typst_syntax::SyntaxNode;

pub const DRAFT_LINK_PREFIX: &str = "https://draft-preview.typsastra.invalid/";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewContentMode {
    #[default]
    Normal,
    Draft,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftImageReference {
    pub source_path: PathBuf,
    pub from_utf16: usize,
    pub to_utf16: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftImageAsset {
    pub id: String,
    pub path: PathBuf,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub source_bytes: u64,
    pub estimated_decoded_bytes: u64,
    pub references: Vec<DraftImageReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftImageDiagnostic {
    pub source_path: PathBuf,
    pub from_utf16: usize,
    pub to_utf16: usize,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct DraftReplacement {
    pub start: usize,
    pub end: usize,
    pub generated: String,
}

#[derive(Debug, Clone, Default)]
pub struct DraftPreparation {
    pub replacements: Vec<DraftReplacement>,
    pub assets: Vec<DraftImageAsset>,
    pub diagnostics: Vec<DraftImageDiagnostic>,
}

pub fn prepare_draft_images(
    project_root: &Path,
    source_path: &Path,
    _destination_path: &Path,
    _render_dir: &Path,
    source: &str,
) -> DraftPreparation {
    let root = typst_syntax::parse(source);
    let mut calls = Vec::new();
    collect_image_calls(&root, 0, &mut calls);
    calls.sort_by_key(|call| call.replacement_start);

    let mut result = DraftPreparation::default();
    for call in calls {
        let reference = DraftImageReference {
            source_path: source_path.to_path_buf(),
            from_utf16: source[..call.image_start].encode_utf16().count(),
            to_utf16: source[..call.image_end].encode_utf16().count(),
        };
        let Some(raw_path) = call.literal_path.as_deref() else {
            result.diagnostics.push(DraftImageDiagnostic {
                source_path: source_path.to_path_buf(),
                from_utf16: reference.from_utf16,
                to_utf16: reference.to_utf16,
                reason: "The image path is dynamic and cannot be replaced safely.".into(),
            });
            continue;
        };
        if raw_path.starts_with('@') || raw_path.contains("://") || raw_path.contains('\\') {
            result.diagnostics.push(DraftImageDiagnostic {
                source_path: source_path.to_path_buf(),
                from_utf16: reference.from_utf16,
                to_utf16: reference.to_utf16,
                reason: "Only literal local image paths are supported by Draft Preview.".into(),
            });
            continue;
        }

        let source_parent = source_path.parent().unwrap_or_else(|| Path::new(""));
        let unresolved_image_path =
            crate::resolve_typst_dependency(raw_path, source_parent, project_root);
        let Some(image_io_path) = canonical_io_path(&unresolved_image_path) else {
            result.diagnostics.push(DraftImageDiagnostic {
                source_path: source_path.to_path_buf(),
                from_utf16: reference.from_utf16,
                to_utf16: reference.to_utf16,
                reason: "The image file is unavailable.".into(),
            });
            continue;
        };
        let Some(project_io_root) = canonical_io_path(project_root) else {
            result.diagnostics.push(DraftImageDiagnostic {
                source_path: source_path.to_path_buf(),
                from_utf16: reference.from_utf16,
                to_utf16: reference.to_utf16,
                reason: "The workspace root could not be resolved safely.".into(),
            });
            continue;
        };
        if !image_io_path.starts_with(&project_io_root) {
            result.diagnostics.push(DraftImageDiagnostic {
                source_path: source_path.to_path_buf(),
                from_utf16: reference.from_utf16,
                to_utf16: reference.to_utf16,
                reason: "The image resolves outside the current workspace and was not exposed to Draft Preview.".into(),
            });
            continue;
        }
        let image_path = display_path(&image_io_path);
        let Some((width, height, mime_type)) = read_image_dimensions(&image_io_path) else {
            result.diagnostics.push(DraftImageDiagnostic {
                source_path: source_path.to_path_buf(),
                from_utf16: reference.from_utf16,
                to_utf16: reference.to_utf16,
                reason: "The image dimensions or format could not be read, so its aspect ratio was not guessed.".into(),
            });
            continue;
        };
        if width == 0 || height == 0 {
            result.diagnostics.push(DraftImageDiagnostic {
                source_path: source_path.to_path_buf(),
                from_utf16: reference.from_utf16,
                to_utf16: reference.to_utf16,
                reason: "The image has invalid intrinsic dimensions.".into(),
            });
            continue;
        }
        let Ok(metadata) = fs::metadata(&image_io_path) else {
            result.diagnostics.push(DraftImageDiagnostic {
                source_path: source_path.to_path_buf(),
                from_utf16: reference.from_utf16,
                to_utf16: reference.to_utf16,
                reason: "The image file is unavailable.".into(),
            });
            continue;
        };
        let id = draft_asset_id(&image_path);
        let mut block_arguments = call
            .layout_arguments
            .iter()
            .map(|(start, end)| source[*start..*end].trim())
            .filter(|argument| !argument.is_empty())
            .map(|argument| format!("{argument},"))
            .collect::<Vec<_>>();
        let uses_default_width = !call.has_width && !call.has_height;
        if uses_default_width {
            // Match Typst's implicit image layout: an image without either
            // dimension fills the available width and derives its height from
            // the intrinsic aspect ratio.
            block_arguments.push("width: 100%,".into());
        }
        let mut generated = if uses_default_width {
            intrinsic_ratio_draft_placeholder(&id, &raw_path, width, height, &block_arguments, true)
        } else if call.has_width == call.has_height {
            fixed_draft_placeholder(&id, &raw_path, &block_arguments, &call)
        } else {
            intrinsic_ratio_draft_placeholder(
                &id,
                &raw_path,
                width,
                height,
                &block_arguments,
                call.has_width,
            )
        };
        for movement in &call.counter_moves {
            let mut arguments = Vec::new();
            if let Some((start, end)) = movement.dx {
                arguments.push(format!("dx: -({}),", source[start..end].trim()));
            }
            if let Some((start, end)) = movement.dy {
                arguments.push(format!("dy: -({}),", source[start..end].trim()));
            }
            generated = format!("move({} [#{generated}])", arguments.join(" "));
        }
        result.replacements.push(DraftReplacement {
            start: call.replacement_start,
            end: call.replacement_end,
            generated,
        });
        if let Some(asset) = result.assets.iter_mut().find(|asset| asset.id == id) {
            asset.references.push(reference);
        } else {
            result.assets.push(DraftImageAsset {
                id,
                path: image_path,
                mime_type,
                width,
                height,
                source_bytes: metadata.len(),
                estimated_decoded_bytes: u64::from(width)
                    .saturating_mul(u64::from(height))
                    .saturating_mul(4),
                references: vec![reference],
            });
        }
    }
    result
}

fn fixed_draft_placeholder(
    id: &str,
    raw_path: &str,
    block_arguments: &[String],
    call: &ImageCall,
) -> String {
    format!(
        "link(\"{DRAFT_LINK_PREFIX}{id}\", block({arguments}{stroke}{inset}{clip})[#align(center + horizon)[#text(size: 8pt, fill: rgb(\"#505762\"), font: \"New Computer Modern\", \"{label}\")]])",
        arguments = block_arguments.join(" "),
        stroke = if call.has_stroke {
            ""
        } else {
            "stroke: 1pt + rgb(\"#7b8491\"), "
        },
        inset = if call.has_inset { "" } else { "inset: 4pt, " },
        clip = if call.has_clip { "" } else { "clip: true, " },
        label = escape_typst_string(raw_path),
    )
}

fn intrinsic_ratio_draft_placeholder(
    id: &str,
    raw_path: &str,
    width: u32,
    height: u32,
    block_arguments: &[String],
    width_is_explicit: bool,
) -> String {
    let spacer_axis = if width_is_explicit {
        "width: 100%"
    } else {
        "height: 100%"
    };
    let svg =
        format!("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {width} {height}'></svg>");
    format!(
        "link(\"{DRAFT_LINK_PREFIX}{id}\", block({arguments}stroke: 1pt + rgb(\"#7b8491\"), clip: true)[#place(center + horizon)[#text(size: 8pt, fill: rgb(\"#505762\"), font: \"New Computer Modern\", \"{label}\")]#image(bytes(\"{svg}\"), {spacer_axis})])",
        arguments = block_arguments.join(" "),
        label = escape_typst_string(raw_path),
    )
}

#[derive(Debug)]
struct ImageCall {
    image_start: usize,
    image_end: usize,
    replacement_start: usize,
    replacement_end: usize,
    literal_path: Option<String>,
    layout_arguments: Vec<(usize, usize)>,
    has_width: bool,
    has_height: bool,
    has_stroke: bool,
    has_inset: bool,
    has_clip: bool,
    counter_moves: Vec<CounterMove>,
}

#[derive(Debug)]
struct CounterMove {
    dx: Option<(usize, usize)>,
    dy: Option<(usize, usize)>,
}

fn collect_image_calls(node: &SyntaxNode, offset: usize, output: &mut Vec<ImageCall>) {
    if let Some(call) = node.cast::<FuncCall>() {
        if let Some(frame) = image_frame_call(node, call, offset) {
            output.push(frame);
            return;
        }
        if matches!(call.callee(), Expr::Ident(ident) if ident.as_str() == "image") {
            output.push(image_call(node, call, offset));
            return;
        }
    }
    let mut child_offset = offset;
    for child in node.children() {
        collect_image_calls(child, child_offset, output);
        child_offset += child.len();
    }
}

fn image_call(node: &SyntaxNode, call: FuncCall<'_>, offset: usize) -> ImageCall {
    let first = call.args().items().next();
    let literal_path = match first {
        Some(Arg::Pos(Expr::Str(value))) => Some(value.get().to_string()),
        _ => None,
    };
    let mut layout_arguments = Vec::new();
    let mut has_width = false;
    let mut has_height = false;
    for argument in call.args().items() {
        let Arg::Named(named) = argument else {
            continue;
        };
        let name = named.name().as_str();
        if name != "width" && name != "height" {
            continue;
        }
        has_width |= name == "width";
        has_height |= name == "height";
        let argument_node = named.to_untyped();
        if let Some(argument_relative) = relative_node_offset(node, argument_node, 0) {
            layout_arguments.push((
                offset + argument_relative,
                offset + argument_relative + argument_node.len(),
            ));
        }
    }
    ImageCall {
        image_start: offset,
        image_end: offset + node.len(),
        replacement_start: offset,
        replacement_end: offset + node.len(),
        literal_path,
        layout_arguments,
        has_width,
        has_height,
        has_stroke: false,
        has_inset: false,
        has_clip: false,
        counter_moves: Vec::new(),
    }
}

fn image_frame_call(node: &SyntaxNode, call: FuncCall<'_>, offset: usize) -> Option<ImageCall> {
    if !matches!(call.callee(), Expr::Ident(ident) if ident.as_str() == "block") {
        return None;
    }

    let mut body = None;
    let mut layout_arguments = Vec::new();
    let mut has_width = false;
    let mut has_height = false;
    let mut has_stroke = false;
    let mut has_inset = false;
    for argument in call.args().items() {
        match argument {
            Arg::Named(named) => {
                let name = named.name().as_str();
                has_width |= name == "width";
                has_height |= name == "height";
                has_stroke |= name == "stroke";
                has_inset |= name == "inset";
                if name == "width" || name == "height" {
                    let argument_node = named.to_untyped();
                    let relative = relative_node_offset(node, argument_node, 0)?;
                    layout_arguments
                        .push((offset + relative, offset + relative + argument_node.len()));
                }
            }
            Arg::Pos(Expr::ContentBlock(content)) if body.is_none() => body = Some(content),
            Arg::Pos(_) | Arg::Spread(_) => return None,
        }
    }

    // Without an explicit viewport in both axes, replacing the frame would
    // make its size depend on the placeholder label instead of the source.
    if !has_width || !has_height {
        return None;
    }
    // An inset changes the inner viewport dimensions. Without evaluating the
    // Typst length expression, copying the outer width and height could make
    // the interaction block overflow the visible frame again.
    if has_inset {
        return None;
    }
    let wrapped = single_wrapped_image(body?)?;
    let image_node = wrapped.image;
    let image_relative = relative_node_offset(node, image_node, 0)?;
    let image_offset = offset + image_relative;
    let image = image_node.cast::<FuncCall>()?;
    let mut result = image_call(image_node, image, image_offset);
    result.layout_arguments = layout_arguments;
    result.has_width = true;
    result.has_height = true;
    result.has_stroke = has_stroke;
    result.has_inset = false;
    result.has_clip = false;
    result.counter_moves = wrapped
        .moves
        .into_iter()
        .map(|movement| {
            let range = |expression: Option<&SyntaxNode>| {
                expression.and_then(|expression| {
                    let relative = relative_node_offset(node, expression, 0)?;
                    Some((offset + relative, offset + relative + expression.len()))
                })
            };
            CounterMove {
                dx: range(movement.dx),
                dy: range(movement.dy),
            }
        })
        .collect();
    Some(result)
}

struct WrappedImage<'a> {
    image: &'a SyntaxNode,
    moves: Vec<MoveNodes<'a>>,
}

struct MoveNodes<'a> {
    dx: Option<&'a SyntaxNode>,
    dy: Option<&'a SyntaxNode>,
}

fn single_wrapped_image(content: ContentBlock<'_>) -> Option<WrappedImage<'_>> {
    let mut expressions = content
        .body()
        .exprs()
        .filter(|expression| !matches!(expression, Expr::Space(_)));
    let expression = expressions.next()?;
    if expressions.next().is_some() {
        return None;
    }
    wrapped_image(expression)
}

fn wrapped_image(expression: Expr<'_>) -> Option<WrappedImage<'_>> {
    match expression {
        Expr::FuncCall(call) if matches!(call.callee(), Expr::Ident(ident) if ident.as_str() == "image") => {
            Some(WrappedImage {
                image: call.to_untyped(),
                moves: Vec::new(),
            })
        }
        Expr::ContentBlock(content) => single_wrapped_image(content),
        Expr::Parenthesized(group) => wrapped_image(group.expr()),
        Expr::FuncCall(call) if matches!(call.callee(), Expr::Ident(ident) if ident.as_str() == "move") =>
        {
            let mut body = None;
            let mut dx = None;
            let mut dy = None;
            for argument in call.args().items() {
                match argument {
                    Arg::Named(named) if named.name().as_str() == "dx" => {
                        dx = Some(named.expr().to_untyped())
                    }
                    Arg::Named(named) if named.name().as_str() == "dy" => {
                        dy = Some(named.expr().to_untyped())
                    }
                    Arg::Named(_) => return None,
                    Arg::Pos(candidate) if body.is_none() => body = Some(candidate),
                    Arg::Pos(_) => return None,
                    Arg::Spread(_) => return None,
                }
            }
            let mut nested = wrapped_image(body?)?;
            nested.moves.push(MoveNodes { dx, dy });
            Some(nested)
        }
        _ => None,
    }
}

fn relative_node_offset(root: &SyntaxNode, target: &SyntaxNode, offset: usize) -> Option<usize> {
    if std::ptr::eq(root, target) {
        return Some(offset);
    }
    let mut child_offset = offset;
    for child in root.children() {
        if let Some(found) = relative_node_offset(child, target, child_offset) {
            return Some(found);
        }
        child_offset += child.len();
    }
    None
}

fn draft_asset_id(path: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(path.to_string_lossy().as_bytes());
    format!("{:x}", digest.finalize())[..24].to_string()
}

fn canonical_io_path(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn display_path(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

fn read_image_dimensions(path: &Path) -> Option<(u32, u32, String)> {
    use std::io::Read;
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024).read_to_end(&mut bytes).ok()?;
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((
            u32::from_be_bytes(bytes[16..20].try_into().ok()?),
            u32::from_be_bytes(bytes[20..24].try_into().ok()?),
            "image/png".into(),
        ));
    }
    if bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Some((
            u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32,
            u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32,
            "image/gif".into(),
        ));
    }
    if bytes.len() >= 26 && bytes.starts_with(b"BM") {
        return Some((
            i32::from_le_bytes(bytes[18..22].try_into().ok()?).unsigned_abs(),
            i32::from_le_bytes(bytes[22..26].try_into().ok()?).unsigned_abs(),
            "image/bmp".into(),
        ));
    }
    if bytes.len() >= 30
        && bytes.starts_with(b"RIFF")
        && &bytes[8..12] == b"WEBP"
        && &bytes[12..16] == b"VP8X"
    {
        return Some((
            1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]),
            1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]),
            "image/webp".into(),
        ));
    }
    if bytes.starts_with(b"\xff\xd8") {
        if let Some((width, height)) = jpeg_dimensions(&bytes) {
            return Some((width, height, "image/jpeg".into()));
        }
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    if text.trim_start().starts_with("<svg") || text.contains("<svg") {
        if let Some((width, height)) = svg_dimensions(text) {
            return Some((width, height, "image/svg+xml".into()));
        }
    }
    None
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut cursor = 2usize;
    while cursor + 3 < bytes.len() {
        if bytes[cursor] != 0xff {
            cursor += 1;
            continue;
        }
        while cursor < bytes.len() && bytes[cursor] == 0xff {
            cursor += 1;
        }
        let marker = *bytes.get(cursor)?;
        cursor += 1;
        if marker == 0xd8 || marker == 0xd9 || marker == 0x01 {
            continue;
        }
        let length = u16::from_be_bytes(bytes.get(cursor..cursor + 2)?.try_into().ok()?) as usize;
        if length < 2 || cursor + length > bytes.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) && length >= 7
        {
            let height = u16::from_be_bytes(bytes[cursor + 3..cursor + 5].try_into().ok()?) as u32;
            let width = u16::from_be_bytes(bytes[cursor + 5..cursor + 7].try_into().ok()?) as u32;
            return Some((width, height));
        }
        cursor += length;
    }
    None
}

fn svg_dimensions(text: &str) -> Option<(u32, u32)> {
    let svg_start = text.find("<svg")?;
    let tag_end = text[svg_start..].find('>')? + svg_start;
    let tag = &text[svg_start..=tag_end];
    if let Some(view_box) = xml_attribute(tag, "viewBox") {
        let values = view_box
            .split(|character: char| character.is_ascii_whitespace() || character == ',')
            .filter_map(|value| value.parse::<f64>().ok())
            .collect::<Vec<_>>();
        if values.len() == 4 && values[2] > 0.0 && values[3] > 0.0 {
            return Some((values[2].round() as u32, values[3].round() as u32));
        }
    }
    let width = numeric_svg_attribute(tag, "width")?;
    let height = numeric_svg_attribute(tag, "height")?;
    Some((width, height))
}

fn numeric_svg_attribute(tag: &str, name: &str) -> Option<u32> {
    let value = xml_attribute(tag, name)?;
    let number = value
        .trim()
        .trim_end_matches(|character: char| character.is_ascii_alphabetic() || character == '%')
        .parse::<f64>()
        .ok()?;
    (number > 0.0).then_some(number.round() as u32)
}

fn xml_attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!("{name}=");
    let start = tag.find(&marker)? + marker.len();
    let quote = tag.as_bytes().get(start).copied()?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let content_start = start + 1;
    let end = tag[content_start..].find(quote as char)? + content_start;
    Some(&tag[content_start..end])
}

fn escape_typst_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_ratio_preserving_placeholder_for_literal_image() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("main.typ");
        let destination = workspace.path().join("cache/render/main.typ");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let image = workspace.path().join("wide.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1600u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let prepared = prepare_draft_images(
            workspace.path(),
            &source,
            &destination,
            &workspace.path().join("cache/render"),
            "#image(\"wide.png\", width: 80%, height: 6cm, fit: \"cover\")",
        );
        assert_eq!(prepared.assets[0].width, 1600);
        assert_eq!(prepared.assets[0].height, 900);
        assert!(prepared.replacements[0]
            .generated
            .contains("link(\"https://draft-preview.typsastra.invalid/"));
        assert!(prepared.replacements[0].generated.contains("width: 80%"));
        assert!(prepared.replacements[0].generated.contains("height: 6cm"));
        assert!(prepared.replacements[0]
            .generated
            .contains("font: \"New Computer Modern\", \"wide.png\""));
        assert!(!prepared.replacements[0].generated.contains("#raw("));
        assert!(prepared.replacements[0]
            .generated
            .contains("text(size: 8pt"));
        assert!(!prepared.replacements[0].generated.contains("fit:"));
    }

    #[test]
    fn uses_full_available_width_when_image_size_is_implicit() {
        let workspace = tempfile::tempdir().unwrap();
        let image = workspace.path().join("wide.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1600u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            "#image(\"wide.png\")",
        );
        let generated = &prepared.replacements[0].generated;
        assert!(generated.contains("block(width: 100%,"));
        assert!(generated.contains("viewBox='0 0 1600 900'"));
        assert!(generated.contains("#image(bytes("));
        assert!(generated.contains("width: 100%)"));
        assert!(!generated.contains("height: 100pt"));
        let parsed = typst_syntax::parse(&format!("#{generated}"));
        assert!(
            parsed.errors_and_warnings().0.is_empty(),
            "generated implicit-size placeholder must remain valid Typst syntax"
        );
    }

    #[test]
    fn preserves_intrinsic_ratio_for_width_only_grid_images() {
        let workspace = tempfile::tempdir().unwrap();
        let image = workspace.path().join("wide.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1600u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            "#grid(columns: (1fr, 1fr), image(\"wide.png\", width: 100%))",
        );

        let generated = &prepared.replacements[0].generated;
        assert!(generated.contains("block(width: 100%,"));
        assert!(generated.contains("viewBox='0 0 1600 900'"));
        assert!(generated.contains("#image(bytes("));
        assert!(generated.contains("width: 100%)"));
        assert!(generated.contains("font: \"New Computer Modern\""));
        assert!(!generated.contains("#raw("));
        assert!(!generated.contains("height: 100pt"));
        let parsed = typst_syntax::parse(&format!("#{generated}"));
        assert!(
            parsed.errors_and_warnings().0.is_empty(),
            "generated width-only placeholder must remain valid Typst syntax"
        );
    }

    #[test]
    fn preserves_intrinsic_ratio_for_height_only_images() {
        let workspace = tempfile::tempdir().unwrap();
        let image = workspace.path().join("tall.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&600u32.to_be_bytes());
        png[20..24].copy_from_slice(&1200u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            "#image(\"tall.png\", height: 6cm)",
        );

        let generated = &prepared.replacements[0].generated;
        assert!(generated.contains("block(height: 6cm,"));
        assert!(generated.contains("viewBox='0 0 600 1200'"));
        assert!(generated.contains("height: 100%)"));
        assert!(!generated.contains("width: 50.000000pt"));
    }

    #[test]
    fn uses_a_dedicated_image_frame_as_the_placeholder_boundary() {
        let workspace = tempfile::tempdir().unwrap();
        let image = workspace.path().join("wide.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1600u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let source = "#block(width: 100%, height: 10cm, above: 0pt, below: 0pt, clip: true, stroke: 1pt + black)[\n  #move(dy: -2cm, [#image(\"wide.png\", width: 100%, height: 12cm, fit: \"cover\")])\n]";
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            source,
        );

        assert_eq!(prepared.replacements.len(), 1);
        let replacement = &prepared.replacements[0];
        assert_eq!(replacement.start, source.find("image(").unwrap());
        assert!(source[replacement.start..replacement.end].starts_with("image("));
        assert!(replacement.generated.contains("width: 100%"));
        assert!(replacement.generated.contains("height: 10cm"));
        assert_eq!(replacement.generated.matches("clip: true").count(), 1);
        assert_eq!(replacement.generated.matches("stroke:").count(), 0);
        assert!(replacement.generated.contains("move(dy: -(-2cm),"));
        assert!(!replacement.generated.contains("height: 12cm"));
        let parsed = typst_syntax::parse(&format!("#{}", replacement.generated));
        assert!(
            parsed.errors_and_warnings().0.is_empty(),
            "generated frame placeholder must remain valid Typst syntax"
        );
        assert_eq!(
            prepared.assets[0].references[0].from_utf16,
            source[..source.find("image(").unwrap()]
                .encode_utf16()
                .count()
        );
    }

    #[test]
    fn keeps_image_level_replacement_for_mixed_content_blocks() {
        let workspace = tempfile::tempdir().unwrap();
        let image = workspace.path().join("wide.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1600u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let source = "#block(width: 100%, height: 10cm, clip: true)[\n  #move(dy: -2cm, [#image(\"wide.png\", height: 12cm)])\n  Caption\n]";
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            source,
        );

        assert_eq!(prepared.replacements.len(), 1);
        assert_eq!(
            prepared.replacements[0].start,
            source.find("image(").unwrap()
        );
        assert!(prepared.replacements[0].generated.contains("height: 12cm"));
    }

    #[test]
    fn replaces_images_beyond_the_legacy_windows_path_limit() {
        let workspace = tempfile::tempdir().unwrap();
        let destination = workspace.path().join("cache/render/main.typ");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let long_relative = (0..9).fold(PathBuf::from("images"), |path, index| {
            path.join(format!("descriptive-image-directory-{index:02}"))
        });
        let workspace_io = fs::canonicalize(workspace.path()).unwrap();
        let long_directory_io = workspace_io.join(&long_relative);
        fs::create_dir_all(&long_directory_io).unwrap();
        let image_io = long_directory_io.join("photo.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1280u32.to_be_bytes());
        png[20..24].copy_from_slice(&960u32.to_be_bytes());
        fs::write(&image_io, png).unwrap();
        let literal = long_relative
            .join("photo.png")
            .to_string_lossy()
            .replace('\\', "/");
        let source_text = format!("#image(\"{literal}\")");

        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &destination,
            &workspace.path().join("cache/render"),
            &source_text,
        );

        assert!(
            workspace.path().join(&long_relative).as_os_str().len() > 260,
            "the fixture must exercise a path beyond the legacy Windows limit"
        );
        assert_eq!(prepared.replacements.len(), 1);
        assert_eq!(prepared.assets.len(), 1);
        assert!(prepared.diagnostics.is_empty());
    }

    #[test]
    fn leaves_dynamic_images_unmodified() {
        let workspace = tempfile::tempdir().unwrap();
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            "#let path = \"wide.png\"\n#image(path)",
        );
        assert!(prepared.replacements.is_empty());
        assert_eq!(prepared.diagnostics.len(), 1);
    }

    #[test]
    fn ignores_image_text_in_comments_and_strings() {
        let workspace = tempfile::tempdir().unwrap();
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            "// #image(\"missing.png\")\n#let example = \"#image(\\\"missing.png\\\")\"",
        );
        assert!(prepared.replacements.is_empty());
        assert!(prepared.diagnostics.is_empty());
    }

    #[test]
    fn rejects_images_outside_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let image = outside.path().join("private.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&400u32.to_be_bytes());
        png[20..24].copy_from_slice(&300u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let source = format!("#image(\"{}\")", image.to_string_lossy().replace('\\', "/"));
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            &source,
        );
        assert!(prepared.replacements.is_empty());
        assert!(prepared.diagnostics[0].reason.contains("outside"));
    }
}
