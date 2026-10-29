use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use typst_syntax::ast::{
    Arg, AstNode, Closure, Expr, FuncCall, LetBinding, LetBindingKind, Param, Pattern,
};
use typst_syntax::SyntaxNode;

/// A source location for the call that supplied an image to a helper function.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageCallSite {
    pub source_path: PathBuf,
    pub from_utf16: usize,
    pub to_utf16: usize,
    pub function_name: String,
}

#[derive(Clone)]
struct FunctionScope {
    name: String,
    positional_parameters: Vec<Option<String>>,
    named_parameters: Vec<String>,
    definition_range: (usize, usize),
    top_level: bool,
}

#[derive(Clone)]
enum ImageArgument {
    Positional { index: usize, name: String },
    Named { name: String },
    Literal(String),
}

struct ImageContext {
    scope: FunctionScope,
    argument: ImageArgument,
    image_call_len: usize,
}

#[derive(Clone)]
enum CallArgument {
    Literal(String),
    Forwarded(String),
    Other,
}

#[derive(Clone)]
struct CallCandidate {
    source_path: PathBuf,
    from: usize,
    to: usize,
    argument: CallArgument,
}

#[derive(Clone)]
struct FollowTarget {
    function_name: String,
    argument: ImageArgument,
    definition_range: (usize, usize),
    source_path: PathBuf,
    top_level: bool,
}

struct ResolvedCall {
    candidate: CallCandidate,
    function_name: String,
    source: String,
}

struct CallChainResolver {
    reachable_files: Vec<PathBuf>,
    files: HashMap<String, String>,
    seen: HashSet<String>,
}

/// Find the outermost helper call that supplied an image at `offset_utf16`.
///
/// Typst maps an `image()` element inside a function body back to the
/// `image()` call in the definition. When that call lives in a named helper,
/// this resolver follows forwarded image parameters through nested helpers until
/// it reaches the call that supplies the image path. Ambiguous calls are left
/// unchanged so inverse sync never jumps to the wrong image.
pub fn resolve_image_call_site(
    project_root: &Path,
    preview_root: &Path,
    source_path: &Path,
    source: &str,
    offset_utf16: usize,
) -> Option<ImageCallSite> {
    let byte_offset = utf16_offset_to_byte_offset(source, offset_utf16)?;
    let syntax = typst_syntax::parse(source);
    let mut context = None;
    find_image_context(&syntax, 0, byte_offset, None, &mut context);
    let context = context?;

    let target = FollowTarget {
        function_name: context.scope.name,
        argument: context.argument,
        definition_range: context.scope.definition_range,
        source_path: source_path.to_path_buf(),
        top_level: context.scope.top_level,
    };
    let resolved =
        CallChainResolver::new(project_root, preview_root, source_path, source).resolve(target)?;
    Some(call_site(
        resolved.candidate,
        &resolved.source,
        &resolved.function_name,
    ))
}

impl CallChainResolver {
    fn new(project_root: &Path, preview_root: &Path, source_path: &Path, source: &str) -> Self {
        let mut files = HashMap::new();
        files.insert(path_identity(source_path), source.to_string());
        let mut reachable_files = crate::render_prepare::mirror::collect_reachable_typst_files(
            project_root,
            preview_root,
        )
        .into_iter()
        .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("typ"))
        .collect::<Vec<_>>();
        reachable_files.sort_by_key(|path| {
            (
                path_identity(path) != path_identity(preview_root),
                path.clone(),
            )
        });
        Self {
            reachable_files,
            files,
            seen: HashSet::new(),
        }
    }

    fn resolve(&mut self, mut target: FollowTarget) -> Option<ResolvedCall> {
        let mut last = None;
        // Cycles are blocked by the seen set; the cap is a second guard for
        // pathological call chains.
        for _ in 0..32 {
            let identity = format!(
                "{}|{}|{}",
                path_identity(&target.source_path),
                target.function_name,
                target.definition_range.0
            );
            if !self.seen.insert(identity) {
                return last;
            }
            let Some(source) = self.source_for(&target.source_path) else {
                return last;
            };
            let syntax = typst_syntax::parse(&source);
            let mut candidates = Vec::new();
            collect_calls(
                &syntax,
                0,
                &target.function_name,
                &target.argument,
                &target.source_path,
                Some(target.definition_range),
                &mut candidates,
            );
            if candidates.is_empty() && target.top_level {
                self.collect_cross_file_calls(&target, &mut candidates);
            }
            let Some(candidate) = choose_candidate(candidates) else {
                return last;
            };
            let Some(candidate_source) = self.source_for(&candidate.source_path) else {
                return last;
            };
            last = Some(ResolvedCall {
                candidate: candidate.clone(),
                function_name: target.function_name.clone(),
                source: candidate_source.clone(),
            });
            let CallArgument::Forwarded(name) = &candidate.argument else {
                return last;
            };
            let caller_syntax = typst_syntax::parse(&candidate_source);
            let Some(scope) = find_enclosing_function(&caller_syntax, 0, candidate.from, None)
            else {
                return last;
            };
            let Some(argument) = argument_for_name(name, &scope) else {
                return last;
            };
            target = FollowTarget {
                function_name: scope.name,
                argument,
                definition_range: scope.definition_range,
                source_path: candidate.source_path,
                top_level: scope.top_level,
            };
        }
        last
    }

    fn collect_cross_file_calls(&mut self, target: &FollowTarget, output: &mut Vec<CallCandidate>) {
        let current = path_identity(&target.source_path);
        let files = self.reachable_files.clone();
        for path in files {
            if path_identity(&path) == current {
                continue;
            }
            let Some(source) = self.source_for(&path) else {
                continue;
            };
            if !may_call(&source, &target.function_name) {
                continue;
            }
            let syntax = typst_syntax::parse(&source);
            collect_calls(
                &syntax,
                0,
                &target.function_name,
                &target.argument,
                &path,
                None,
                output,
            );
        }
    }

    fn source_for(&mut self, path: &Path) -> Option<String> {
        let identity = path_identity(path);
        if let Some(source) = self.files.get(&identity) {
            return Some(source.clone());
        }
        let source = fs::read_to_string(path).ok()?;
        self.files.insert(identity, source.clone());
        Some(source)
    }
}

fn find_image_context(
    node: &SyntaxNode,
    offset: usize,
    cursor: usize,
    scope: Option<&FunctionScope>,
    best: &mut Option<ImageContext>,
) {
    let next_scope = node
        .cast::<LetBinding>()
        .and_then(|binding| function_scope(binding, offset, scope.is_none()))
        .or_else(|| scope.cloned());
    if let Some(call) = node.cast::<FuncCall>() {
        if is_image_call(call) && offset <= cursor && cursor <= offset + node.len() {
            if let Some(scope) = next_scope.as_ref() {
                if let Some(argument) = image_argument(call, scope) {
                    let candidate = ImageContext {
                        scope: scope.clone(),
                        argument,
                        image_call_len: node.len(),
                    };
                    if best
                        .as_ref()
                        .is_none_or(|current| candidate.image_call_len <= current.image_call_len)
                    {
                        *best = Some(candidate);
                    }
                }
            }
        }
    }
    let mut child_offset = offset;
    for child in node.children() {
        find_image_context(child, child_offset, cursor, next_scope.as_ref(), best);
        child_offset += child.len();
    }
}

fn find_enclosing_function(
    node: &SyntaxNode,
    offset: usize,
    cursor: usize,
    scope: Option<&FunctionScope>,
) -> Option<FunctionScope> {
    if cursor < offset || cursor > offset + node.len() {
        return None;
    }
    let next_scope = node
        .cast::<LetBinding>()
        .and_then(|binding| function_scope(binding, offset, scope.is_none()))
        .or_else(|| scope.cloned());
    let mut found = next_scope.clone();
    let mut child_offset = offset;
    for child in node.children() {
        if let Some(child_scope) =
            find_enclosing_function(child, child_offset, cursor, next_scope.as_ref())
        {
            found = Some(child_scope);
        }
        child_offset += child.len();
    }
    found
}

fn function_scope(
    binding: LetBinding<'_>,
    offset: usize,
    top_level: bool,
) -> Option<FunctionScope> {
    let (name, closure) = match binding.kind() {
        LetBindingKind::Closure(name) => {
            (name.as_str().to_string(), closure_from_binding(binding)?)
        }
        LetBindingKind::Normal(pattern) => {
            let bindings = pattern.bindings();
            if bindings.len() != 1 {
                return None;
            }
            (
                bindings[0].as_str().to_string(),
                closure_from_binding(binding)?,
            )
        }
    };
    let mut positional_parameters = Vec::new();
    let mut named_parameters = Vec::new();
    for parameter in closure.params().children() {
        match parameter {
            Param::Pos(pattern) => positional_parameters.push(pattern_name(pattern)),
            Param::Named(named) => named_parameters.push(named.name().as_str().to_string()),
            Param::Spread(_) => positional_parameters.push(None),
        }
    }
    Some(FunctionScope {
        name,
        positional_parameters,
        named_parameters,
        definition_range: (offset, offset + binding.to_untyped().len()),
        top_level,
    })
}

fn closure_from_binding(binding: LetBinding<'_>) -> Option<Closure<'_>> {
    if let Some(Expr::Closure(closure)) = binding.init() {
        return Some(closure);
    }
    binding
        .to_untyped()
        .children()
        .find_map(|child| child.cast::<Closure>())
}

fn pattern_name(pattern: Pattern<'_>) -> Option<String> {
    let mut bindings = pattern.bindings();
    (bindings.len() == 1).then(|| bindings.remove(0).as_str().to_string())
}

fn is_image_call(call: FuncCall<'_>) -> bool {
    matches!(call.callee(), Expr::Ident(ident) if ident.as_str() == "image")
}

fn image_argument(call: FuncCall<'_>, scope: &FunctionScope) -> Option<ImageArgument> {
    for argument in call.args().items() {
        match argument {
            Arg::Pos(expression) => return image_argument_from_expression(expression, scope),
            Arg::Named(named) if named.name().as_str() == "path" => {
                return image_argument_from_expression(named.expr(), scope);
            }
            Arg::Named(_) => continue,
            Arg::Spread(_) => return None,
        }
    }
    None
}

fn image_argument_from_expression(
    expression: Expr<'_>,
    scope: &FunctionScope,
) -> Option<ImageArgument> {
    match expression {
        Expr::Str(value) => Some(ImageArgument::Literal(value.get().to_string())),
        Expr::Ident(ident) => argument_for_name(ident.as_str(), scope),
        _ => None,
    }
}

fn argument_for_name(name: &str, scope: &FunctionScope) -> Option<ImageArgument> {
    if let Some(index) = scope
        .positional_parameters
        .iter()
        .position(|parameter| parameter.as_deref() == Some(name))
    {
        Some(ImageArgument::Positional {
            index,
            name: name.to_string(),
        })
    } else if scope
        .named_parameters
        .iter()
        .any(|parameter| parameter == name)
    {
        Some(ImageArgument::Named {
            name: name.to_string(),
        })
    } else {
        None
    }
}

fn collect_calls(
    node: &SyntaxNode,
    offset: usize,
    function_name: &str,
    argument: &ImageArgument,
    source_path: &Path,
    excluded_range: Option<(usize, usize)>,
    output: &mut Vec<CallCandidate>,
) {
    if let Some(call) = node.cast::<FuncCall>() {
        if matches!(call.callee(), Expr::Ident(ident) if ident.as_str() == function_name) {
            let call_range = (offset, offset + node.len());
            let excluded = excluded_range
                .is_some_and(|(start, end)| call_range.0 >= start && call_range.1 <= end);
            if !excluded {
                output.push(CallCandidate {
                    source_path: source_path.to_path_buf(),
                    from: call_range.0,
                    to: call_range.1,
                    argument: call_argument(call, argument),
                });
            }
        }
    }
    let mut child_offset = offset;
    for child in node.children() {
        collect_calls(
            child,
            child_offset,
            function_name,
            argument,
            source_path,
            excluded_range,
            output,
        );
        child_offset += child.len();
    }
}

fn call_argument(call: FuncCall<'_>, argument: &ImageArgument) -> CallArgument {
    match argument {
        ImageArgument::Literal(path) => CallArgument::Literal(path.clone()),
        ImageArgument::Positional { index, name } => {
            let positional = call
                .args()
                .items()
                .filter_map(|argument| match argument {
                    Arg::Pos(expression) => Some(expression),
                    _ => None,
                })
                .nth(*index);
            if let Some(expression) = positional {
                return call_argument_kind(expression);
            }
            named_call_argument(call, name).unwrap_or(CallArgument::Other)
        }
        ImageArgument::Named { name } => {
            named_call_argument(call, name).unwrap_or(CallArgument::Other)
        }
    }
}

fn named_call_argument(call: FuncCall<'_>, name: &str) -> Option<CallArgument> {
    call.args().items().find_map(|argument| match argument {
        Arg::Named(named) if named.name().as_str() == name => {
            Some(call_argument_kind(named.expr()))
        }
        _ => None,
    })
}

fn call_argument_kind(expression: Expr<'_>) -> CallArgument {
    match expression {
        Expr::Str(value) => CallArgument::Literal(value.get().to_string()),
        Expr::Ident(ident) => CallArgument::Forwarded(ident.as_str().to_string()),
        Expr::Parenthesized(group) => call_argument_kind(group.expr()),
        _ => CallArgument::Other,
    }
}

fn choose_candidate(mut candidates: Vec<CallCandidate>) -> Option<CallCandidate> {
    if candidates.len() <= 1 {
        return candidates.pop();
    }
    let mut literal = None;
    for candidate in &candidates {
        let CallArgument::Literal(value) = &candidate.argument else {
            return None;
        };
        if let Some(previous) = literal {
            if previous != value {
                return None;
            }
        } else {
            literal = Some(value);
        }
    }
    candidates.into_iter().next()
}

fn call_site(candidate: CallCandidate, source: &str, function_name: &str) -> ImageCallSite {
    ImageCallSite {
        source_path: candidate.source_path,
        from_utf16: byte_offset_to_utf16(source, candidate.from),
        to_utf16: byte_offset_to_utf16(source, candidate.to),
        function_name: function_name.to_string(),
    }
}

fn utf16_offset_to_byte_offset(text: &str, offset_utf16: usize) -> Option<usize> {
    let mut utf16_offset = 0;
    for (byte_offset, character) in text.char_indices() {
        if utf16_offset == offset_utf16 {
            return Some(byte_offset);
        }
        utf16_offset += character.len_utf16();
        if utf16_offset > offset_utf16 {
            return None;
        }
    }
    (utf16_offset == offset_utf16).then_some(text.len())
}

fn byte_offset_to_utf16(text: &str, byte_offset: usize) -> usize {
    text[..byte_offset.min(text.len())].encode_utf16().count()
}

fn path_identity(path: &Path) -> String {
    let identity = dunce::simplified(path).to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        identity.to_lowercase()
    } else {
        identity
    }
}

fn may_call(text: &str, function_name: &str) -> bool {
    let mut search_start = 0;
    while let Some(relative) = text[search_start..].find(function_name) {
        let name_end = search_start + relative + function_name.len();
        if text[name_end..].trim_start().starts_with('(') {
            return true;
        }
        search_start = name_end;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor_in(text: &str, needle: &str) -> usize {
        let byte_offset = text.find(needle).expect("find cursor needle");
        text[..byte_offset].encode_utf16().count() + 2
    }

    fn utf16_offset(text: &str, byte_offset: usize) -> usize {
        text[..byte_offset].encode_utf16().count()
    }

    fn resolve_same_file(source: &str) -> Option<ImageCallSite> {
        resolve_image_call_site(
            Path::new("C:/workspace"),
            Path::new("C:/workspace/main.typ"),
            Path::new("C:/workspace/main.typ"),
            source,
            cursor_in(source, "image(src)"),
        )
    }

    #[test]
    fn backtracks_from_a_parameterized_image_to_its_call() {
        let source = "= Cover\n#let f(src) = { image(src) }\n#f(\"/images/img.jpg\")\n";
        let site = resolve_same_file(source).expect("resolve call site");

        let call = source.find("f(\"/images/img.jpg\")").expect("find call");
        assert_eq!(site.function_name, "f");
        assert_eq!(site.from_utf16, utf16_offset(source, call));
        assert_eq!(
            site.to_utf16,
            utf16_offset(source, call + "f(\"/images/img.jpg\")".len())
        );
    }

    #[test]
    fn backtracks_through_forwarded_parameters_at_every_level() {
        let source = "\
#let f(src) = image(src)
#let g(src) = f(src)
#let h(src) = g(src)
#h(\"/images/img.jpg\")
";
        let site = resolve_same_file(source).expect("resolve call site");

        assert_eq!(site.function_name, "h");
        assert_eq!(
            site.from_utf16,
            utf16_offset(source, source.find("h(\"").expect("find call"))
        );
    }

    #[test]
    fn backtracks_through_renamed_forwarded_parameters() {
        let source = "\
#let f(src) = image(src)
#let g(path) = f(path)
#g(\"/images/img.jpg\")
";
        let site = resolve_same_file(source).expect("resolve call site");

        assert_eq!(site.function_name, "g");
        assert_eq!(
            site.from_utf16,
            utf16_offset(source, source.find("g(\"").expect("find call"))
        );
    }

    #[test]
    fn backtracks_from_a_closure_binding_to_its_call() {
        let source = "#let f = (src) => image(src)\n#f(\"/images/img.jpg\")\n";
        let site = resolve_same_file(source).expect("resolve call site");

        assert_eq!(site.function_name, "f");
        assert_eq!(
            site.from_utf16,
            utf16_offset(source, source.find("#f(\"").expect("find call") + 1)
        );
    }

    #[test]
    fn backtracks_named_call_arguments() {
        let source = "#let f(src) = image(src)\n#f(src: \"/images/img.jpg\")\n";
        let site = resolve_same_file(source).expect("resolve call site");

        assert_eq!(site.function_name, "f");
        assert_eq!(
            site.from_utf16,
            utf16_offset(source, source.find("#f(src:").expect("find call") + 1)
        );
    }

    #[test]
    fn leaves_direct_images_and_ambiguous_calls_unchanged() {
        let direct = "#image(\"/images/img.jpg\")\n";
        assert!(resolve_image_call_site(
            Path::new("C:/workspace"),
            Path::new("C:/workspace/main.typ"),
            Path::new("C:/workspace/main.typ"),
            direct,
            cursor_in(direct, "image("),
        )
        .is_none());

        let ambiguous = "#let f(src) = image(src)\n#f(\"/a.png\")\n#f(\"/b.png\")\n";
        assert!(resolve_same_file(ambiguous).is_none());
    }

    #[test]
    fn reuses_repeated_calls_to_the_same_image() {
        let source = "#let f(src) = image(src)\n#f(\"/a.png\")\n#f(\"/a.png\")\n";
        let site = resolve_same_file(source).expect("resolve call site");

        assert_eq!(
            site.from_utf16,
            utf16_offset(source, source.find("f(\"").expect("find call"))
        );
    }

    #[test]
    fn converts_utf16_offsets_around_multibyte_text() {
        let source = "= ខ្មែរ\n#let f(src) = image(src)\n#f(\"/images/img.jpg\")\n";
        let site = resolve_same_file(source).expect("resolve call site");

        assert_eq!(
            site.from_utf16,
            utf16_offset(source, source.find("f(\"").expect("find call"))
        );
    }

    #[test]
    fn backtracks_to_a_call_in_a_reachable_file() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let template = workspace.path().join("template.typ");
        let main = workspace.path().join("main.typ");
        let template_source = "#let f(src) = { image(src) }\n";
        let main_source = "#import \"template.typ\": f\n#f(\"/images/img.jpg\")\n";
        fs::write(&template, template_source).expect("write template");
        fs::write(&main, main_source).expect("write main");

        let site = resolve_image_call_site(
            workspace.path(),
            &main,
            &template,
            template_source,
            cursor_in(template_source, "image(src)"),
        )
        .expect("resolve cross-file call site");

        assert_eq!(site.function_name, "f");
        assert_eq!(path_identity(&site.source_path), path_identity(&main));
        assert_eq!(
            site.from_utf16,
            utf16_offset(main_source, main_source.find("f(\"").expect("find call"))
        );
    }

    #[test]
    fn follows_multiple_levels_across_reachable_files() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let template = workspace.path().join("template.typ");
        let main = workspace.path().join("main.typ");
        let template_source = "\
#let f(src) = image(src)
#let g(src) = f(src)
";
        let main_source = "= ខ្មែរ\n#import \"template.typ\": g\n#g(\"/images/img.jpg\")\n";
        fs::write(&template, template_source).expect("write template");
        fs::write(&main, main_source).expect("write main");

        let site = resolve_image_call_site(
            workspace.path(),
            &main,
            &template,
            template_source,
            cursor_in(template_source, "image(src)"),
        )
        .expect("resolve cross-file call chain");

        assert_eq!(site.function_name, "g");
        assert_eq!(path_identity(&site.source_path), path_identity(&main));
        assert_eq!(
            site.from_utf16,
            utf16_offset(main_source, main_source.find("g(\"").expect("find call"))
        );
    }
}
