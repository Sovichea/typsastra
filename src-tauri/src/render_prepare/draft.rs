use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use typst_syntax::ast::{
    Arg, AstNode, ContentBlock, Expr, FuncCall, Imports, LetBinding, LetBindingKind, ModuleImport,
    Param, Pattern,
};
use typst_syntax::{SyntaxKind, SyntaxNode};

pub const DRAFT_LINK_PREFIX: &str = "https://draft-preview.typsastra.invalid/";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewContentMode {
    #[default]
    Normal,
    Draft,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DraftAssetKind {
    #[default]
    Image,
    Diagram,
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
    #[serde(default)]
    pub kind: DraftAssetKind,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub diagram_kind: Option<String>,
    #[serde(default)]
    pub diagram_expression: Option<String>,
    #[serde(default)]
    pub diagram_imports: Option<String>,
    #[serde(default)]
    pub diagram_setup: Option<String>,
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
    let mut wrappers = HashMap::new();
    collect_image_wrappers(&root, 0, &mut wrappers);
    let mut calls = Vec::new();
    collect_image_calls(&root, 0, &wrappers, source, &mut calls);
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
            .map(|argument| argument.trim())
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
                kind: DraftAssetKind::Image,
                name: String::new(),
                diagram_kind: None,
                diagram_expression: None,
                diagram_imports: None,
                diagram_setup: None,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiagramKind {
    Fletcher,
    Cetz,
}

impl DiagramKind {
    fn key(self) -> &'static str {
        match self {
            Self::Fletcher => "fletcher",
            Self::Cetz => "cetz",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Fletcher => "Fletcher diagram",
            Self::Cetz => "Cetz canvas",
        }
    }
}

#[derive(Default)]
struct DiagramContext {
    namespaces: HashMap<String, DiagramKind>,
    unqualified: HashMap<String, DiagramKind>,
    aliases: HashMap<String, DiagramKind>,
}

#[derive(Clone)]
struct DiagramBindingCandidate<'a> {
    name: String,
    init: Option<Expr<'a>>,
    init_offset: usize,
}

/// Replaces statically resolvable Fletcher/Cetz diagram bindings with labeled
/// placeholders while preserving the binding name and surrounding markup.
#[cfg(test)]
pub fn prepare_draft_diagrams(source_path: &Path, source: &str) -> DraftPreparation {
    prepare_draft_diagrams_with_size_lookup(
        Path::new("C:/project"),
        Path::new("C:/project/main.typ"),
        source_path,
        source,
        |_, _, _, _| None,
    )
}

/// Like [`prepare_draft_diagrams`], but uses cached diagram measurements to
/// preserve the original layout size when one is available.
pub fn prepare_draft_diagrams_with_size_lookup<F>(
    project_root: &Path,
    document_root: &Path,
    source_path: &Path,
    source: &str,
    mut size_lookup: F,
) -> DraftPreparation
where
    F: FnMut(&str, &str, &str, &str) -> Option<(f64, f64)>,
{
    let setup = diagram_setup_block(document_root, project_root);
    let root = typst_syntax::parse(source);
    let mut context = DiagramContext::default();
    // Many documents re-export the Fletcher/Cetz factories through a template
    // wildcard import, so assume the canonical names when no local import or
    // binding overrides them.
    context
        .unqualified
        .insert("diagram".to_string(), DiagramKind::Fletcher);
    context
        .unqualified
        .insert("canvas".to_string(), DiagramKind::Cetz);
    collect_diagram_imports(&root, 0, &mut context);
    let mut candidates = Vec::new();
    collect_diagram_bindings(&root, 0, &mut candidates);

    let mut concrete = Vec::new();
    let mut skip_ranges = Vec::new();
    let mut skip_until = 0usize;
    for candidate in candidates {
        if candidate.init_offset < skip_until {
            continue;
        }
        let resolved = candidate
            .init
            .and_then(|init| diagram_func_call(init, candidate.init_offset))
            .and_then(|(call, call_offset)| {
                resolve_diagram_callee(&call, call_offset, source, &context)
            });
        match resolved {
            Some((kind, partial)) => {
                if let Some(init) = candidate.init {
                    // Locals declared inside a diagram expression are scoped to
                    // that diagram and must not shadow later factories.
                    let init_end = candidate.init_offset + init.to_untyped().len();
                    skip_until = skip_until.max(init_end);
                    skip_ranges.push((candidate.init_offset, init_end));
                }
                if partial {
                    context.aliases.insert(candidate.name.clone(), kind);
                    context.unqualified.remove(&candidate.name);
                } else {
                    // A concrete diagram replaces any prior function binding
                    // with the same name, so later calls cannot resolve it as a
                    // factory.
                    context.aliases.remove(&candidate.name);
                    context.unqualified.remove(&candidate.name);
                    concrete.push((candidate, kind));
                }
            }
            None => {
                // Any other binding shadows a same-named imported function.
                context.aliases.remove(&candidate.name);
                context.unqualified.remove(&candidate.name);
            }
        }
    }

    let mut result = DraftPreparation::default();
    for (candidate, kind) in concrete {
        let Some(init) = candidate.init else {
            continue;
        };
        let start = candidate.init_offset;
        let end = start + init.to_untyped().len();
        if end > source.len() {
            continue;
        }
        let id = draft_diagram_asset_id(source_path, &candidate.name, &source[start..end]);
        let label = format!("{} · {}", kind.label(), candidate.name);
        let dimensions = size_lookup(&id, &candidate.name, kind.key(), &setup);
        result.replacements.push(DraftReplacement {
            start,
            end,
            generated: draft_diagram_placeholder(&id, &label, dimensions),
        });
        result.assets.push(DraftImageAsset {
            id,
            kind: DraftAssetKind::Diagram,
            name: candidate.name,
            diagram_kind: Some(kind.key().to_string()),
            diagram_expression: None,
            diagram_imports: None,
            diagram_setup: Some(setup.clone()),
            path: source_path.to_path_buf(),
            mime_type: String::new(),
            width: 0,
            height: 0,
            source_bytes: fs::metadata(source_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            estimated_decoded_bytes: 0,
            references: vec![DraftImageReference {
                source_path: source_path.to_path_buf(),
                from_utf16: source[..start].encode_utf16().count(),
                to_utf16: source[..end].encode_utf16().count(),
            }],
        });
    }

    let imports = diagram_import_block(&root, source, source_path, project_root);
    let mut inline = Vec::new();
    collect_inline_diagram_calls(&root, 0, source, &context, &skip_ranges, &mut inline);
    for (call, offset, kind) in inline {
        let start = offset;
        let end = start + call.to_untyped().len();
        if end > source.len() {
            continue;
        }
        let expression = source[start..end].trim().to_string();
        if expression.is_empty() {
            continue;
        }
        let line = 1 + source[..start]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count();
        let name = format!("inline-line-{line}-{start}");
        let id = draft_diagram_asset_id(source_path, &format!("inline:{start}"), &expression);
        let label = format!("{} · line {}", kind.label(), line);
        let dimensions = size_lookup(&id, &name, kind.key(), &setup);
        result.replacements.push(DraftReplacement {
            start,
            end,
            generated: draft_diagram_placeholder(&id, &label, dimensions),
        });
        result.assets.push(DraftImageAsset {
            id,
            kind: DraftAssetKind::Diagram,
            name,
            diagram_kind: Some(kind.key().to_string()),
            diagram_expression: Some(expression),
            diagram_imports: Some(imports.clone()),
            diagram_setup: Some(setup.clone()),
            path: source_path.to_path_buf(),
            mime_type: String::new(),
            width: 0,
            height: 0,
            source_bytes: fs::metadata(source_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            estimated_decoded_bytes: 0,
            references: vec![DraftImageReference {
                source_path: source_path.to_path_buf(),
                from_utf16: source[..start].encode_utf16().count(),
                to_utf16: source[..end].encode_utf16().count(),
            }],
        });
    }
    result
}

pub fn merge_draft_preparations(
    mut base: DraftPreparation,
    extra: DraftPreparation,
) -> DraftPreparation {
    base.replacements.extend(extra.replacements);
    base.assets.extend(extra.assets);
    base.diagnostics.extend(extra.diagnostics);
    base.replacements
        .sort_by_key(|replacement| (replacement.start, std::cmp::Reverse(replacement.end)));
    let mut merged = Vec::new();
    for replacement in base.replacements {
        if merged.last().is_some_and(|last: &DraftReplacement| {
            replacement.start >= last.start && replacement.end <= last.end
        }) {
            continue;
        }
        merged.push(replacement);
    }
    base.replacements = merged;
    base
}

fn collect_diagram_imports(node: &SyntaxNode, offset: usize, context: &mut DiagramContext) {
    if let Some(import) = ModuleImport::from_untyped(node) {
        if let Expr::Str(path) = import.source() {
            let spec = path.get();
            let kind = if spec.starts_with("@preview/cetz") {
                Some(DiagramKind::Cetz)
            } else if spec.starts_with("@preview/fletcher") {
                Some(DiagramKind::Fletcher)
            } else {
                None
            };
            if let Some(kind) = kind {
                match import.imports() {
                    None => {
                        let name = import
                            .new_name()
                            .map(|name| name.as_str().to_string())
                            .or_else(|| import.bare_name().ok().map(|name| name.to_string()));
                        if let Some(name) = name {
                            context.namespaces.insert(name, kind);
                        }
                    }
                    Some(imports) => {
                        if let Some(name) = import.new_name() {
                            context.namespaces.insert(name.as_str().to_string(), kind);
                        }
                        match imports {
                            Imports::Wildcard => {
                                let name = if kind == DiagramKind::Fletcher {
                                    "diagram"
                                } else {
                                    "canvas"
                                };
                                context.unqualified.insert(name.to_string(), kind);
                            }
                            Imports::Items(items) => {
                                for item in items.iter() {
                                    let original = item.original_name().as_str();
                                    let bound = item.bound_name().as_str();
                                    if (kind == DiagramKind::Fletcher && original == "diagram")
                                        || (kind == DiagramKind::Cetz && original == "canvas")
                                    {
                                        context.unqualified.insert(bound.to_string(), kind);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut child_offset = offset;
    for child in node.children() {
        collect_diagram_imports(child, child_offset, context);
        child_offset += child.len();
    }
}

fn collect_diagram_bindings<'a>(
    node: &'a SyntaxNode,
    offset: usize,
    output: &mut Vec<DiagramBindingCandidate<'a>>,
) {
    if let Some(binding) = LetBinding::from_untyped(node) {
        match binding.kind() {
            LetBindingKind::Normal(pattern) => {
                let bindings = pattern.bindings();
                let mut collected = false;
                if bindings.len() == 1 {
                    if let Some(init) = binding.init() {
                        if let Some(init_offset) =
                            relative_node_offset(node, init.to_untyped(), offset)
                        {
                            output.push(DiagramBindingCandidate {
                                name: bindings[0].as_str().to_string(),
                                init: Some(init),
                                init_offset,
                            });
                            collected = true;
                        }
                    }
                }
                if !collected {
                    for ident in bindings {
                        output.push(DiagramBindingCandidate {
                            name: ident.as_str().to_string(),
                            init: None,
                            init_offset: offset,
                        });
                    }
                }
            }
            LetBindingKind::Closure(ident) => {
                // Closure helpers are dynamic. Track the name so it shadows an
                // imported diagram factory, but never replace the function body.
                output.push(DiagramBindingCandidate {
                    name: ident.as_str().to_string(),
                    init: None,
                    init_offset: offset,
                });
            }
        }
    }

    let mut child_offset = offset;
    for child in node.children() {
        collect_diagram_bindings(child, child_offset, output);
        child_offset += child.len();
    }
}

fn diagram_import_block(
    root: &SyntaxNode,
    source: &str,
    source_path: &Path,
    project_root: &Path,
) -> String {
    let mut imports = Vec::new();
    collect_diagram_import_block(root, 0, 0, source, source_path, project_root, &mut imports);
    imports.join("\n")
}

fn diagram_setup_block(document_root: &Path, project_root: &Path) -> String {
    let Ok(source) = fs::read_to_string(document_root) else {
        return String::new();
    };
    let root = typst_syntax::parse(&source);
    let imports = diagram_import_block(&root, &source, document_root, project_root);
    let mut setup = Vec::new();
    collect_document_setup(&root, 0, 0, &source, &mut setup);
    if imports.is_empty() {
        setup.join("\n")
    } else {
        format!("{imports}\n{}", setup.join("\n"))
    }
}

fn collect_document_setup(
    node: &SyntaxNode,
    offset: usize,
    depth: usize,
    source: &str,
    output: &mut Vec<String>,
) {
    if depth == 1
        && matches!(
            node.kind(),
            SyntaxKind::LetBinding | SyntaxKind::SetRule | SyntaxKind::ShowRule
        )
    {
        let start = offset;
        let end = offset + node.len();
        if end <= source.len() {
            let hash_start = if start > 0 && source.as_bytes().get(start - 1) == Some(&b'#') {
                start - 1
            } else {
                start
            };
            output.push(source[hash_start..end].to_string());
        }
    }

    let mut child_offset = offset;
    for child in node.children() {
        collect_document_setup(child, child_offset, depth + 1, source, output);
        child_offset += child.len();
    }
}

fn collect_diagram_import_block(
    node: &SyntaxNode,
    offset: usize,
    depth: usize,
    source: &str,
    source_path: &Path,
    project_root: &Path,
    imports: &mut Vec<String>,
) {
    if depth == 1 {
        if let Some(import) = ModuleImport::from_untyped(node) {
            if let Expr::Str(path) = import.source() {
                let spec = path.get();
                if !spec.starts_with('@') && !spec.starts_with('/') {
                    let base = source_path.parent().unwrap_or(project_root);
                    let resolved = base.join(spec.as_str());
                    let root = dunce::canonicalize(project_root)
                        .unwrap_or_else(|_| project_root.to_path_buf());
                    let rewritten = dunce::canonicalize(&resolved).ok().and_then(|path| {
                        path.strip_prefix(&root).ok().map(|relative| {
                            format!("/{}", relative.to_string_lossy().replace('\\', "/"))
                        })
                    });
                    if let Some(rewritten) = rewritten {
                        let import_start = offset;
                        let import_end = offset + node.len();
                        let hash_start = if import_start > 0
                            && source.as_bytes().get(import_start - 1) == Some(&b'#')
                        {
                            import_start - 1
                        } else {
                            import_start
                        };
                        let string_node = path.to_untyped();
                        if let Some(string_start) =
                            relative_node_offset(node, string_node, import_start)
                        {
                            let string_end = string_start + string_node.len();
                            if string_end <= import_end && import_end <= source.len() {
                                let mut statement = String::new();
                                statement.push_str(&source[hash_start..string_start]);
                                statement.push('"');
                                statement.push_str(&escape_typst_string(&rewritten));
                                statement.push('"');
                                statement.push_str(&source[string_end..import_end]);
                                imports.push(statement);
                            }
                        }
                    }
                } else {
                    let import_start = offset;
                    let hash_start = if import_start > 0
                        && source.as_bytes().get(import_start - 1) == Some(&b'#')
                    {
                        import_start - 1
                    } else {
                        import_start
                    };
                    imports.push(source[hash_start..offset + node.len()].to_string());
                }
            }
        }
    }

    let mut child_offset = offset;
    for child in node.children() {
        collect_diagram_import_block(
            child,
            child_offset,
            depth + 1,
            source,
            source_path,
            project_root,
            imports,
        );
        child_offset += child.len();
    }
}

fn collect_inline_diagram_calls<'a>(
    node: &'a SyntaxNode,
    offset: usize,
    source: &str,
    context: &DiagramContext,
    skip_ranges: &[(usize, usize)],
    output: &mut Vec<(FuncCall<'a>, usize, DiagramKind)>,
) {
    let node_start = offset;
    let node_end = offset + node.len();
    if skip_ranges
        .iter()
        .any(|(start, end)| node_start >= *start && node_end <= *end)
    {
        return;
    }
    if let Some(call) = FuncCall::from_untyped(node) {
        if let Some((kind, partial)) = resolve_diagram_callee(&call, offset, source, context) {
            if !partial {
                output.push((call, offset, kind));
            }
            return;
        }
    }

    let mut child_offset = offset;
    for child in node.children() {
        collect_inline_diagram_calls(child, child_offset, source, context, skip_ranges, output);
        child_offset += child.len();
    }
}

fn diagram_func_call<'a>(expression: Expr<'a>, offset: usize) -> Option<(FuncCall<'a>, usize)> {
    match expression {
        Expr::FuncCall(call) => Some((call, offset)),
        Expr::Parenthesized(group) => {
            let inner = group.expr();
            let inner_offset =
                relative_node_offset(group.to_untyped(), inner.to_untyped(), offset)?;
            diagram_func_call(inner, inner_offset)
        }
        _ => None,
    }
}

fn resolve_diagram_callee(
    call: &FuncCall<'_>,
    call_offset: usize,
    source: &str,
    context: &DiagramContext,
) -> Option<(DiagramKind, bool)> {
    let callee = call.callee();
    let callee_offset = relative_node_offset(call.to_untyped(), callee.to_untyped(), call_offset)?;
    let callee_text = source.get(callee_offset..callee_offset + callee.to_untyped().len())?;
    let (base, partial) = if let Some(base) = callee_text.strip_suffix(".with") {
        (base, true)
    } else {
        (callee_text, false)
    };
    let parts = base.split('.').collect::<Vec<_>>();
    if parts.is_empty() {
        return None;
    }
    if let Some(kind) = context.namespaces.get(parts[0]) {
        if parts.len() >= 2
            && ((*kind == DiagramKind::Cetz && parts[1] == "canvas")
                || (*kind == DiagramKind::Fletcher && parts[1] == "diagram"))
        {
            return Some((*kind, partial));
        }
    }
    if parts.len() == 1 {
        if let Some(kind) = context
            .aliases
            .get(parts[0])
            .or_else(|| context.unqualified.get(parts[0]))
        {
            return Some((*kind, partial));
        }
    }
    None
}

fn draft_diagram_asset_id(path: &Path, name: &str, source: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(path.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(name.as_bytes());
    digest.update([0]);
    digest.update(source.as_bytes());
    format!("{:x}", digest.finalize())[..24].to_string()
}

fn format_points(value: f64) -> String {
    let formatted = format!("{value:.4}");
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn draft_diagram_placeholder(id: &str, label: &str, dimensions: Option<(f64, f64)>) -> String {
    let size = dimensions
        .filter(|(width, height)| *width > 0.0 && *height > 0.0)
        .map(|(width, height)| {
            format!(
                "width: {}pt, height: {}pt",
                format_points(width),
                format_points(height)
            )
        })
        .unwrap_or_else(|| "width: 6cm, height: 3cm".to_string());
    format!(
        "link(\"{DRAFT_LINK_PREFIX}{id}\", box({size}, stroke: 1pt + rgb(\"#7b8491\"), inset: 4pt)[#align(center + horizon)[#set par(justify: false)\n#text(size: 8pt, fill: rgb(\"#505762\"), font: \"New Computer Modern\", \"{label}\")]])",
        label = escape_typst_string(label),
    )
}

fn fixed_draft_placeholder(
    id: &str,
    raw_path: &str,
    block_arguments: &[String],
    call: &ImageCall,
) -> String {
    format!(
        "link(\"{DRAFT_LINK_PREFIX}{id}\", block({arguments}{stroke}{inset}{clip})[#align(center + horizon)[#set par(justify: false)\n#text(size: 8pt, fill: rgb(\"#505762\"), font: \"New Computer Modern\", \"{label}\")]])",
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
        "link(\"{DRAFT_LINK_PREFIX}{id}\", block({arguments}stroke: 1pt + rgb(\"#7b8491\"), clip: true)[#place(center + horizon)[#set par(justify: false)\n#text(size: 8pt, fill: rgb(\"#505762\"), font: \"New Computer Modern\", \"{label}\")]#image(bytes(\"{svg}\"), {spacer_axis})])",
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
    layout_arguments: Vec<String>,
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

#[derive(Debug, Clone)]
struct ImageWrapper<'a> {
    parameters: Vec<WrapperParameter<'a>>,
    body: Expr<'a>,
    body_offset: usize,
}

#[derive(Debug, Clone)]
struct WrapperParameter<'a> {
    name: String,
    positional: bool,
    default: Option<Expr<'a>>,
    default_offset: usize,
}

#[derive(Debug, Clone)]
struct BoundValue {
    literal: Option<String>,
    text: String,
}

#[derive(Debug)]
struct ResolvedWrapperImage {
    literal_path: String,
    layout_arguments: Vec<String>,
    has_width: bool,
    has_height: bool,
}

fn collect_image_wrappers<'a>(
    node: &'a SyntaxNode,
    offset: usize,
    output: &mut HashMap<String, ImageWrapper<'a>>,
) {
    if let Some(binding) = LetBinding::from_untyped(node) {
        if let LetBindingKind::Closure(name) = binding.kind() {
            if let Some(Expr::Closure(closure)) = binding.init() {
                let mut parameters = Vec::new();
                let mut supported = true;
                for param in closure.params().children() {
                    match param {
                        Param::Pos(Pattern::Normal(Expr::Ident(parameter))) => {
                            parameters.push(WrapperParameter {
                                name: parameter.as_str().to_string(),
                                positional: true,
                                default: None,
                                default_offset: 0,
                            });
                        }
                        Param::Named(named) => {
                            let default = named.expr();
                            let Some(relative) =
                                relative_node_offset(node, default.to_untyped(), 0)
                            else {
                                supported = false;
                                break;
                            };
                            parameters.push(WrapperParameter {
                                name: named.name().as_str().to_string(),
                                positional: false,
                                default: Some(default),
                                default_offset: offset + relative,
                            });
                        }
                        Param::Pos(_) | Param::Spread(_) => {
                            supported = false;
                            break;
                        }
                    }
                }
                if supported && !parameters.is_empty() {
                    let body = closure.body();
                    if let Some(relative) = relative_node_offset(node, body.to_untyped(), 0) {
                        output.insert(
                            name.as_str().to_string(),
                            ImageWrapper {
                                parameters,
                                body,
                                body_offset: offset + relative,
                            },
                        );
                    }
                }
            }
        }
    }

    let mut child_offset = offset;
    for child in node.children() {
        collect_image_wrappers(child, child_offset, output);
        child_offset += child.len();
    }
}

fn bound_literal(expression: Expr<'_>, bindings: &HashMap<String, BoundValue>) -> Option<String> {
    match expression {
        Expr::Str(value) => Some(value.get().to_string()),
        Expr::Ident(identifier) => bindings
            .get(identifier.as_str())
            .and_then(|value| value.literal.clone()),
        Expr::Parenthesized(group) => bound_literal(group.expr(), bindings),
        _ => None,
    }
}

fn expression_text(
    expression: Expr<'_>,
    offset: usize,
    bindings: &HashMap<String, BoundValue>,
    source: &str,
) -> Option<String> {
    node_text(expression.to_untyped(), offset, bindings, source, 0)
}

fn contains_bound_identifier(node: &SyntaxNode, bindings: &HashMap<String, BoundValue>) -> bool {
    if let Some(identifier) = node.cast::<typst_syntax::ast::Ident>() {
        if bindings.contains_key(identifier.as_str()) {
            return true;
        }
    }
    node.children()
        .any(|child| contains_bound_identifier(child, bindings))
}

fn node_text(
    node: &SyntaxNode,
    offset: usize,
    bindings: &HashMap<String, BoundValue>,
    source: &str,
    depth: usize,
) -> Option<String> {
    if depth > 32 {
        return None;
    }
    if let Some(identifier) = node.cast::<typst_syntax::ast::Ident>() {
        if let Some(value) = bindings.get(identifier.as_str()) {
            return Some(value.text.clone());
        }
    }
    if !contains_bound_identifier(node, bindings) {
        return source.get(offset..offset + node.len()).map(str::to_string);
    }
    let mut result = String::new();
    let mut child_offset = offset;
    for child in node.children() {
        result.push_str(&node_text(
            child,
            child_offset,
            bindings,
            source,
            depth + 1,
        )?);
        child_offset += child.len();
    }
    Some(result)
}

fn argument_value(
    expression: Expr<'_>,
    offset: usize,
    bindings: &HashMap<String, BoundValue>,
    source: &str,
) -> Option<BoundValue> {
    Some(BoundValue {
        literal: bound_literal(expression, bindings),
        text: expression_text(expression, offset, bindings, source)?,
    })
}

fn bind_wrapper_parameters<'a>(
    call: FuncCall<'a>,
    call_offset: usize,
    wrapper: &ImageWrapper<'a>,
    bindings: &HashMap<String, BoundValue>,
    source: &str,
) -> Option<HashMap<String, BoundValue>> {
    let mut next = HashMap::new();
    let mut positional = 0usize;
    for argument in call.args().items() {
        match argument {
            Arg::Pos(expression) => {
                if let Some(parameter) = wrapper
                    .parameters
                    .iter()
                    .filter(|parameter| parameter.positional)
                    .nth(positional)
                {
                    let offset = relative_node_offset(
                        call.to_untyped(),
                        expression.to_untyped(),
                        call_offset,
                    )?;
                    let value = argument_value(expression, offset, bindings, source)?;
                    next.insert(parameter.name.clone(), value);
                }
                positional += 1;
            }
            Arg::Named(named) => {
                let name = named.name().as_str();
                let Some(parameter) = wrapper
                    .parameters
                    .iter()
                    .find(|parameter| parameter.name == name)
                else {
                    continue;
                };
                let expression = named.expr();
                let offset =
                    relative_node_offset(call.to_untyped(), expression.to_untyped(), call_offset)?;
                let value = argument_value(expression, offset, bindings, source)?;
                next.insert(parameter.name.clone(), value);
            }
            Arg::Spread(_) => return None,
        }
    }
    for parameter in &wrapper.parameters {
        if next.contains_key(&parameter.name) {
            continue;
        }
        let Some(default) = parameter.default else {
            return None;
        };
        let value = argument_value(default, parameter.default_offset, &next, source)?;
        next.insert(parameter.name.clone(), value);
    }
    Some(next)
}

fn resolve_wrapper_image<'a>(
    call: FuncCall<'a>,
    call_offset: usize,
    wrappers: &HashMap<String, ImageWrapper<'a>>,
    bindings: &HashMap<String, BoundValue>,
    source: &str,
    depth: usize,
) -> Option<ResolvedWrapperImage> {
    if depth > 32 {
        return None;
    }
    let Expr::Ident(callee) = call.callee() else {
        return None;
    };
    let callee = callee.as_str();
    if callee == "image" {
        let first = call.args().items().find_map(|argument| match argument {
            Arg::Pos(expression) => Some(expression),
            _ => None,
        })?;
        let literal_path = bound_literal(first, bindings)?;
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
            let expression = named.expr();
            let offset =
                relative_node_offset(call.to_untyped(), expression.to_untyped(), call_offset)?;
            let text = expression_text(expression, offset, bindings, source)?;
            layout_arguments.push(format!("{name}: {}", text.trim()));
        }
        return Some(ResolvedWrapperImage {
            literal_path,
            layout_arguments,
            has_width,
            has_height,
        });
    }

    let wrapper = wrappers.get(callee)?;
    let next_bindings = bind_wrapper_parameters(call, call_offset, wrapper, bindings, source)?;
    match wrapper.body {
        Expr::FuncCall(inner) => resolve_wrapper_image(
            inner,
            wrapper.body_offset,
            wrappers,
            &next_bindings,
            source,
            depth + 1,
        ),
        Expr::Parenthesized(group) => {
            let inner = group.expr();
            let Expr::FuncCall(call) = inner else {
                return None;
            };
            let inner_offset = relative_node_offset(
                wrapper.body.to_untyped(),
                inner.to_untyped(),
                wrapper.body_offset,
            )?;
            resolve_wrapper_image(
                call,
                inner_offset,
                wrappers,
                &next_bindings,
                source,
                depth + 1,
            )
        }
        _ => None,
    }
}

fn collect_image_calls<'a>(
    node: &'a SyntaxNode,
    offset: usize,
    wrappers: &HashMap<String, ImageWrapper<'a>>,
    source: &str,
    output: &mut Vec<ImageCall>,
) {
    if let Some(binding) = LetBinding::from_untyped(node) {
        if matches!(binding.kind(), LetBindingKind::Closure(_)) {
            return;
        }
    }

    if let Some(call) = node.cast::<FuncCall>() {
        if let Some(frame) = image_frame_call(node, call, offset, source) {
            output.push(frame);
            return;
        }
        if matches!(call.callee(), Expr::Ident(ident) if ident.as_str() == "image") {
            output.push(image_call(node, call, offset, source));
            return;
        }
        if let Expr::Ident(ident) = call.callee() {
            if wrappers.contains_key(ident.as_str()) {
                if let Some(resolved) =
                    resolve_wrapper_image(call, offset, wrappers, &HashMap::new(), source, 0)
                {
                    output.push(ImageCall {
                        image_start: offset,
                        image_end: offset + node.len(),
                        replacement_start: offset,
                        replacement_end: offset + node.len(),
                        literal_path: Some(resolved.literal_path),
                        layout_arguments: resolved.layout_arguments,
                        has_width: resolved.has_width,
                        has_height: resolved.has_height,
                        has_stroke: false,
                        has_inset: false,
                        has_clip: false,
                        counter_moves: Vec::new(),
                    });
                    return;
                }
            }
        }
    }
    let mut child_offset = offset;
    for child in node.children() {
        collect_image_calls(child, child_offset, wrappers, source, output);
        child_offset += child.len();
    }
}

fn image_call(node: &SyntaxNode, call: FuncCall<'_>, offset: usize, source: &str) -> ImageCall {
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
            let start = offset + argument_relative;
            let end = start + argument_node.len();
            if let Some(argument) = source.get(start..end) {
                layout_arguments.push(argument.to_string());
            }
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

fn image_frame_call(
    node: &SyntaxNode,
    call: FuncCall<'_>,
    offset: usize,
    source: &str,
) -> Option<ImageCall> {
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
                    let start = offset + relative;
                    let end = start + argument_node.len();
                    layout_arguments.push(source.get(start..end)?.to_string());
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
    let mut result = image_call(image_node, image, image_offset, source);
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

pub(crate) fn svg_dimensions_f64(text: &str) -> Option<(f64, f64)> {
    let svg_start = text.find("<svg")?;
    let tag_end = text[svg_start..].find('>')? + svg_start;
    let tag = &text[svg_start..=tag_end];
    if let Some(view_box) = xml_attribute(tag, "viewBox") {
        let values = view_box
            .split(|character: char| character.is_ascii_whitespace() || character == ',')
            .filter_map(|value| value.parse::<f64>().ok())
            .collect::<Vec<_>>();
        if values.len() == 4 && values[2] > 0.0 && values[3] > 0.0 {
            return Some((values[2], values[3]));
        }
    }
    let width = numeric_svg_attribute(tag, "width")?;
    let height = numeric_svg_attribute(tag, "height")?;
    Some((width, height))
}

pub(crate) fn svg_dimensions(text: &str) -> Option<(u32, u32)> {
    svg_dimensions_f64(text).map(|(width, height)| (width.round() as u32, height.round() as u32))
}

fn numeric_svg_attribute(tag: &str, name: &str) -> Option<f64> {
    let value = xml_attribute(tag, name)?;
    let number = value
        .trim()
        .trim_end_matches(|character: char| character.is_ascii_alphabetic() || character == '%')
        .parse::<f64>()
        .ok()?;
    (number > 0.0).then_some(number)
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
        assert!(prepared.replacements[0]
            .generated
            .contains("#set par(justify: false)"));
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
    fn resolves_multi_level_image_helper_calls() {
        let workspace = tempfile::tempdir().unwrap();
        let image = workspace.path().join("wide.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1600u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let source = "#let x(url) = image(url)\n#let y(url) = x(url)\n\n#y(\"wide.png\")";
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            source,
        );

        assert_eq!(prepared.replacements.len(), 1);
        let replacement = &prepared.replacements[0];
        let call_start = source.find("y(\"wide.png\")").unwrap();
        assert_eq!(replacement.start, call_start);
        assert_eq!(replacement.end, call_start + "y(\"wide.png\")".len());
        assert!(replacement.generated.contains("width: 100%"));
        assert!(replacement.generated.contains("viewBox='0 0 1600 900'"));
        assert_eq!(prepared.assets.len(), 1);
        assert_eq!(prepared.assets[0].width, 1600);
        assert_eq!(prepared.assets[0].height, 900);
        assert!(prepared.diagnostics.is_empty());
        assert_eq!(
            prepared.assets[0].references[0].from_utf16,
            source[..call_start].encode_utf16().count()
        );
    }

    #[test]
    fn preserves_helper_layout_arguments_through_multiple_levels() {
        let workspace = tempfile::tempdir().unwrap();
        let image = workspace.path().join("wide.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1600u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let source = "#let x(url) = image(url, width: 50%, height: 4cm)\n#let y(url) = x(url)\n#y(\"wide.png\")";
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            source,
        );

        assert_eq!(prepared.replacements.len(), 1);
        let generated = &prepared.replacements[0].generated;
        assert!(generated.contains("width: 50%"));
        assert!(generated.contains("height: 4cm"));
        assert!(prepared.diagnostics.is_empty());
    }

    fn write_test_png(directory: &Path, name: &str, width: u32, height: u32) -> PathBuf {
        let image = directory.join(name);
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&width.to_be_bytes());
        png[20..24].copy_from_slice(&height.to_be_bytes());
        fs::write(&image, png).unwrap();
        image
    }

    #[test]
    fn forwards_helper_layout_parameters() {
        let workspace = tempfile::tempdir().unwrap();
        write_test_png(workspace.path(), "wide.png", 1600, 900);
        let source = "\
#let frame(src, width: 55%, height: 4cm) = image(src, width: width, height: height)
#let cover(src) = frame(src, width: 46%, height: 5cm)
#cover(\"wide.png\")";
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            source,
        );

        assert_eq!(prepared.replacements.len(), 1);
        let replacement = &prepared.replacements[0];
        let call_start = source.find("cover(\"wide.png\")").unwrap();
        assert_eq!(replacement.start, call_start);
        assert_eq!(replacement.end, call_start + "cover(\"wide.png\")".len());
        assert!(replacement.generated.contains("width: 46%"));
        assert!(replacement.generated.contains("height: 5cm"));
        assert!(prepared.diagnostics.is_empty());
    }

    #[test]
    fn binds_positional_parameters_by_declaration_kind() {
        let workspace = tempfile::tempdir().unwrap();
        write_test_png(workspace.path(), "wide.png", 1600, 900);
        let source = "\
#let frame(width, src) = image(src, width: width)
#let cover(src) = frame(46%, src)
#cover(\"wide.png\")";
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            source,
        );

        assert_eq!(prepared.replacements.len(), 1);
        assert!(prepared.replacements[0].generated.contains("width: 46%"));
        assert!(prepared.diagnostics.is_empty());
    }

    #[test]
    fn uses_helper_parameter_defaults_and_named_path_arguments() {
        let workspace = tempfile::tempdir().unwrap();
        write_test_png(workspace.path(), "wide.png", 1600, 900);
        let source = "\
#let frame(src, width: 55%) = image(src, width: width)
#let cover(src) = frame(src)
#cover(src: \"wide.png\")";
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            source,
        );

        assert_eq!(prepared.replacements.len(), 1);
        assert!(prepared.replacements[0].generated.contains("width: 55%"));
        assert!(prepared.diagnostics.is_empty());
    }

    #[test]
    fn substitutes_helper_parameters_inside_layout_expressions() {
        let workspace = tempfile::tempdir().unwrap();
        write_test_png(workspace.path(), "wide.png", 1600, 900);
        let source = "\
#let frame(src, scale: 50%) = image(src, width: scale * 2)
#let cover(src) = frame(src, scale: 40%)
#cover(\"wide.png\")";
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            source,
        );

        assert_eq!(prepared.replacements.len(), 1);
        assert!(prepared.replacements[0]
            .generated
            .contains("width: 40% * 2"));
        let parsed = typst_syntax::parse(&format!("#{}", prepared.replacements[0].generated));
        assert!(
            parsed.errors_and_warnings().0.is_empty(),
            "substituted helper layout must remain valid Typst syntax"
        );
    }

    #[test]
    fn replaces_only_the_helper_call_inside_a_figure() {
        let workspace = tempfile::tempdir().unwrap();
        write_test_png(workspace.path(), "wide.png", 1600, 900);
        let source = "\
#let frame(src, width: 46%) = image(src, width: width)
#let cover(src) = frame(src)
#figure(cover(\"wide.png\"), caption: [A cover.])";
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            source,
        );

        assert_eq!(prepared.replacements.len(), 1);
        let replacement = &prepared.replacements[0];
        let call_start = source.find("cover(\"wide.png\")").unwrap();
        assert_eq!(replacement.start, call_start);
        assert_eq!(replacement.end, call_start + "cover(\"wide.png\")".len());
        assert!(replacement.generated.contains("width: 46%"));
    }

    #[test]
    fn prepares_the_bundled_image_helper_example() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/examples/06-preview-and-media/02-image-helper-chains");
        let source_path = workspace.join("main.typ");
        let source = fs::read_to_string(&source_path).expect("read bundled example");
        let prepared = prepare_draft_images(
            &workspace,
            &source_path,
            &workspace.join("cache/render/main.typ"),
            &workspace.join("cache/render"),
            &source,
        );

        assert_eq!(prepared.replacements.len(), 2);
        assert!(prepared
            .replacements
            .iter()
            .any(|replacement| replacement.generated.contains("width: 46%")));
        assert!(prepared
            .replacements
            .iter()
            .any(|replacement| replacement.generated.contains("width: 58%")));
        assert!(prepared.diagnostics.is_empty());
    }

    #[test]
    fn leaves_dynamic_helper_calls_unmodified() {
        let workspace = tempfile::tempdir().unwrap();
        let prepared = prepare_draft_images(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &workspace.path().join("cache/render/main.typ"),
            &workspace.path().join("cache/render"),
            "#let x(url) = image(url)\n#let path = \"wide.png\"\n#x(path)",
        );
        assert!(prepared.replacements.is_empty());
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
        let parent = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir_in(parent.path()).unwrap();
        let outside = tempfile::tempdir_in(parent.path()).unwrap();
        let image = outside.path().join("private.png");
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&400u32.to_be_bytes());
        png[20..24].copy_from_slice(&300u32.to_be_bytes());
        fs::write(&image, png).unwrap();
        let relative_outside = Path::new("..")
            .join(outside.path().file_name().unwrap())
            .join("private.png");
        let source = format!(
            "#image(\"{}\")",
            relative_outside.to_string_lossy().replace('\\', "/")
        );
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

    #[test]
    fn prepares_fletcher_and_cetz_diagram_bindings() {
        let source = r#"
#import "@preview/cetz:0.5.2"
#import "@preview/cetz:0.5.2": canvas
#import "@preview/fletcher:0.5.8" as fletcher: diagram, edge, node
#let diagram = fletcher.diagram.with(label-sep: 0pt)
#let rounded = diagram.with(node-corner-radius: 2pt)
#let C = cetz.canvas({ line((0, 0), (1, 1)) })
#let D = canvas({ line((0, 1), (1, 0)) })
#let F = rounded((0, 0), [(1, 1)])
#let plain = 1
"#;
        let prepared = prepare_draft_diagrams(Path::new("C:/project/diags.typ"), source);
        assert_eq!(prepared.assets.len(), 3);
        assert_eq!(prepared.replacements.len(), 3);
        assert!(prepared.assets.iter().any(|asset| {
            asset.name == "C"
                && asset.kind == DraftAssetKind::Diagram
                && asset.diagram_kind.as_deref() == Some("cetz")
        }));
        assert!(prepared.assets.iter().any(|asset| {
            asset.name == "D"
                && asset.kind == DraftAssetKind::Diagram
                && asset.diagram_kind.as_deref() == Some("cetz")
        }));
        assert!(prepared.assets.iter().any(|asset| {
            asset.name == "F"
                && asset.kind == DraftAssetKind::Diagram
                && asset.diagram_kind.as_deref() == Some("fletcher")
        }));
        assert!(prepared
            .replacements
            .iter()
            .all(|replacement| replacement.generated.contains("Cetz canvas")
                || replacement.generated.contains("Fletcher diagram")));
        assert!(prepared
            .replacements
            .iter()
            .all(|replacement| replacement.generated.contains("#set par(justify: false)")));
        assert!(!prepared
            .replacements
            .iter()
            .any(|replacement| replacement.generated.contains("plain")));
    }

    #[test]
    fn uses_cached_diagram_dimensions_for_placeholders() {
        let source = r#"
#import "@preview/cetz:0.5.2"
#let C = cetz.canvas({ line((0, 0), (1, 1)) })
"#;
        let prepared = prepare_draft_diagrams_with_size_lookup(
            Path::new("C:/project"),
            Path::new("C:/project/main.typ"),
            Path::new("C:/project/diags.typ"),
            source,
            |_, name, _, _| (name == "C").then_some((121.9911, 68.3035)),
        );
        assert_eq!(prepared.replacements.len(), 1);
        assert!(prepared.replacements[0]
            .generated
            .contains("width: 121.9911pt, height: 68.3035pt"));
    }

    #[test]
    fn collects_document_setup_rules_for_measurement() {
        let workspace = tempfile::tempdir().unwrap();
        let template = workspace.path().join("template.typ");
        let main = workspace.path().join("main.typ");
        fs::write(&template, "#let imath(doc) = doc").unwrap();
        fs::write(
            &main,
            "#import \"template.typ\": *\n#show: imath\n#set text(size: 14pt)\n= Body\n",
        )
        .unwrap();
        let setup = diagram_setup_block(&main, workspace.path());
        assert!(setup.contains("#import \"/template.typ\": *"));
        assert!(setup.contains("#show: imath"));
        assert!(setup.contains("#set text(size: 14pt)"));
        assert!(!setup.contains("= Body"));
    }

    #[test]
    fn prepares_inline_fletcher_calls_with_rewritten_imports() {
        let workspace = tempfile::tempdir().unwrap();
        let parts = workspace.path().join("parts");
        let chapters = workspace.path().join("chapters");
        fs::create_dir_all(&parts).unwrap();
        fs::create_dir_all(&chapters).unwrap();
        fs::write(parts.join("diags.typ"), "#let diagram = 1").unwrap();
        let source_path = chapters.join("main.typ");
        let source = r#"#import "../parts/diags.typ": diagram
Text #diagram($ a edge(->, b) $) more
"#;
        let prepared = prepare_draft_diagrams_with_size_lookup(
            workspace.path(),
            &workspace.path().join("main.typ"),
            &source_path,
            source,
            |_, _, _, _| None,
        );
        assert_eq!(prepared.assets.len(), 1);
        assert_eq!(prepared.replacements.len(), 1);
        let asset = &prepared.assets[0];
        assert!(asset.name.starts_with("inline-line-2-"));
        assert!(asset
            .diagram_expression
            .as_deref()
            .unwrap()
            .starts_with("diagram("));
        assert!(
            asset
                .diagram_imports
                .as_deref()
                .unwrap()
                .contains("#import \"/parts/diags.typ\": diagram"),
            "imports={:?}",
            asset.diagram_imports
        );
        assert!(prepared.replacements[0]
            .generated
            .contains("Fletcher diagram"));
    }

    #[test]
    fn keeps_factories_after_locals_inside_a_diagram() {
        let source = r#"
#import "@preview/cetz:0.5.2"
#import "@preview/fletcher:0.5.8" as fletcher: diagram
#let diagram = fletcher.diagram.with(label-sep: 0pt)
#let A = cetz.canvas({
  let diagram = 1
  line((0, 0), (1, 1))
})
#let B = diagram((0, 0), [(1, 1)])
"#;
        let prepared = prepare_draft_diagrams(Path::new("C:/project/main.typ"), source);
        assert_eq!(prepared.assets.len(), 2);
        assert!(prepared.assets.iter().any(|asset| asset.name == "A"));
        assert!(prepared.assets.iter().any(|asset| asset.name == "B"));
    }

    #[test]
    fn ignores_shadowed_diagram_factories() {
        let source = r#"
#import "@preview/fletcher:0.5.8": diagram
#let diagram = 42
#let not-diagram = diagram(1)
#let diagram(x) = x
#let still-not-a-diagram = diagram(2)
"#;
        let prepared = prepare_draft_diagrams(Path::new("C:/project/main.typ"), source);
        assert!(prepared.replacements.is_empty());
        assert!(prepared.assets.is_empty());
    }

    #[test]
    fn keeps_diagram_preparations_when_image_replacements_overlap() {
        let base = DraftPreparation {
            replacements: vec![DraftReplacement {
                start: 10,
                end: 100,
                generated: "diagram".into(),
            }],
            assets: Vec::new(),
            diagnostics: Vec::new(),
        };
        let extra = DraftPreparation {
            replacements: vec![
                DraftReplacement {
                    start: 10,
                    end: 100,
                    generated: "duplicate".into(),
                },
                DraftReplacement {
                    start: 20,
                    end: 40,
                    generated: "nested image".into(),
                },
            ],
            assets: Vec::new(),
            diagnostics: Vec::new(),
        };
        let merged = merge_draft_preparations(base, extra);
        assert_eq!(merged.replacements.len(), 1);
        assert_eq!(merged.replacements[0].generated, "diagram");
    }
}
