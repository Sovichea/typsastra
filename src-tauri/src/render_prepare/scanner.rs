#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanState {
    MarkupText,
    CodeExpression,
    Math,
    RawInline,
    RawBlock,
    LineComment,
    BlockComment,
}

pub fn scan_typst_content(content: &str) -> Vec<(ScanState, usize, usize, ())> {
    let chars: Vec<(usize, char)> = content.char_indices().collect();
    let mut chunks = Vec::new();
    let mut i = 0;
    let mut current_state = ScanState::MarkupText;
    let mut chunk_start = 0;

    let mut bracket_stack = Vec::new();
    let mut in_string = false;

    while i < chars.len() {
        let (pos, c) = chars[i];

        match current_state {
            ScanState::MarkupText => {
                if c == '[' {
                    if pos > chunk_start {
                        chunks.push((ScanState::MarkupText, chunk_start, pos, ()));
                    }
                    chunk_start = pos;
                } else if c == ']' {
                    if pos > chunk_start {
                        chunks.push((ScanState::MarkupText, chunk_start, pos, ()));
                    }
                    chunk_start = pos;

                    if bracket_stack.last() == Some(&']') {
                        bracket_stack.pop();
                        current_state = ScanState::CodeExpression;
                        i += 1;
                        continue;
                    }
                }

                if c == '/' && i + 1 < chars.len() && chars[i + 1].1 == '*' {
                    if pos > chunk_start {
                        chunks.push((ScanState::MarkupText, chunk_start, pos, ()));
                    }
                    current_state = ScanState::BlockComment;
                    chunk_start = pos;
                    i += 2;
                    continue;
                }
                if c == '/' && i + 1 < chars.len() && chars[i + 1].1 == '/' {
                    let preceded_by_colon = if i > 0 { chars[i - 1].1 == ':' } else { false };
                    if !preceded_by_colon {
                        if pos > chunk_start {
                            chunks.push((ScanState::MarkupText, chunk_start, pos, ()));
                        }
                        current_state = ScanState::LineComment;
                        chunk_start = pos;
                        i += 2;
                        continue;
                    }
                }
                if c == '`' && i + 2 < chars.len() && chars[i + 1].1 == '`' && chars[i + 2].1 == '`'
                {
                    if pos > chunk_start {
                        chunks.push((ScanState::MarkupText, chunk_start, pos, ()));
                    }
                    current_state = ScanState::RawBlock;
                    chunk_start = pos;
                    i += 3;
                    continue;
                }
                if c == '`' {
                    if pos > chunk_start {
                        chunks.push((ScanState::MarkupText, chunk_start, pos, ()));
                    }
                    current_state = ScanState::RawInline;
                    chunk_start = pos;
                    i += 1;
                    continue;
                }
                if c == '$' {
                    if pos > chunk_start {
                        chunks.push((ScanState::MarkupText, chunk_start, pos, ()));
                    }
                    current_state = ScanState::Math;
                    chunk_start = pos;
                    i += 1;
                    continue;
                }
                if c == '#' {
                    let is_valid_start = if i + 1 < chars.len() {
                        let next_c = chars[i + 1].1;
                        !next_c.is_whitespace() && next_c != '/' && next_c != '*' && next_c != '#'
                    } else {
                        false
                    };
                    if is_valid_start {
                        if pos > chunk_start {
                            chunks.push((ScanState::MarkupText, chunk_start, pos, ()));
                        }
                        current_state = ScanState::CodeExpression;
                        chunk_start = pos;
                        bracket_stack.clear();
                        in_string = false;
                        i += 1;
                        continue;
                    }
                }
                i += 1;
            }
            ScanState::LineComment => {
                if c == '\n' {
                    let end_pos = pos + c.len_utf8();
                    chunks.push((ScanState::LineComment, chunk_start, end_pos, ()));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                }
                i += 1;
            }
            ScanState::BlockComment => {
                if c == '*' && i + 1 < chars.len() && chars[i + 1].1 == '/' {
                    let end_pos = chars[i + 1].0 + 1;
                    chunks.push((ScanState::BlockComment, chunk_start, end_pos, ()));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                    i += 2;
                    continue;
                }
                i += 1;
            }
            ScanState::RawBlock => {
                if c == '`' && i + 2 < chars.len() && chars[i + 1].1 == '`' && chars[i + 2].1 == '`'
                {
                    let end_pos = chars[i + 2].0 + 1;
                    chunks.push((ScanState::RawBlock, chunk_start, end_pos, ()));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                    i += 3;
                    continue;
                }
                i += 1;
            }
            ScanState::RawInline => {
                if c == '`' {
                    let end_pos = pos + 1;
                    chunks.push((ScanState::RawInline, chunk_start, end_pos, ()));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                    i += 1;
                    continue;
                }
                i += 1;
            }
            ScanState::Math => {
                if c == '$' {
                    let end_pos = pos + 1;
                    chunks.push((ScanState::Math, chunk_start, end_pos, ()));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                    i += 1;
                    continue;
                }
                i += 1;
            }
            ScanState::CodeExpression => {
                if in_string {
                    if c == '"' {
                        let is_escaped = if i > 0 {
                            let mut backslash_count = 0;
                            let mut prev_idx = i - 1;
                            while chars[prev_idx].1 == '\\' {
                                backslash_count += 1;
                                if prev_idx == 0 {
                                    break;
                                }
                                prev_idx -= 1;
                            }
                            backslash_count % 2 == 1
                        } else {
                            false
                        };
                        if !is_escaped {
                            in_string = false;
                        }
                    }
                    i += 1;
                    continue;
                }

                if c == '"' {
                    in_string = true;
                    i += 1;
                    continue;
                }

                if c == '(' {
                    bracket_stack.push(')');
                } else if c == '{' {
                    bracket_stack.push('}');
                } else if c == '[' {
                    if pos > chunk_start {
                        chunks.push((ScanState::CodeExpression, chunk_start, pos, ()));
                    }
                    bracket_stack.push(']');
                    current_state = ScanState::MarkupText;
                    chunk_start = pos;
                    i += 1;
                    continue;
                } else if c == ')' || c == '}' {
                    if bracket_stack.last() == Some(&c) {
                        bracket_stack.pop();
                    }
                }

                if bracket_stack.is_empty() {
                    let is_keyword_statement = if chunk_start < pos {
                        let text_so_far = &content[chunk_start..pos];
                        text_so_far.starts_with("#let")
                            || text_so_far.starts_with("#set")
                            || text_so_far.starts_with("#show")
                            || text_so_far.starts_with("#import")
                            || text_so_far.starts_with("#include")
                    } else {
                        false
                    };

                    let should_end = if is_keyword_statement {
                        c == '\n' || c == ';'
                    } else {
                        c.is_whitespace()
                            || c == ';'
                            || c == ','
                            || c == '.'
                            || c == '/'
                            || c == '*'
                            || c == '+'
                            || c == '-'
                            || c == '='
                            || c == '<'
                            || c == '>'
                            || c == '!'
                    };

                    if should_end {
                        let continues = if c == '.' && i + 1 < chars.len() {
                            chars[i + 1].1.is_alphanumeric()
                        } else {
                            false
                        };

                        if !continues {
                            chunks.push((ScanState::CodeExpression, chunk_start, pos, ()));
                            current_state = ScanState::MarkupText;
                            chunk_start = pos;
                        }
                    }
                }
                i += 1;
            }
        }
    }

    let end_pos = content.len();
    if end_pos > chunk_start {
        chunks.push((current_state, chunk_start, end_pos, ()));
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_plain_markup() {
        let content = "Hello World! នេះជាភាសាខ្មែរ";
        let chunks = scan_typst_content(content);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], (ScanState::MarkupText, 0, content.len(), ()));
    }

    #[test]
    fn test_scan_comments() {
        let content = "Hello // line comment\nWorld /* block comment */!";
        let chunks = scan_typst_content(content);
        assert_eq!(chunks.len(), 5);

        assert_eq!(chunks[0].0, ScanState::MarkupText);
        assert_eq!(chunks[1].0, ScanState::LineComment);
        assert_eq!(chunks[2].0, ScanState::MarkupText);
        assert_eq!(chunks[3].0, ScanState::BlockComment);
        assert_eq!(chunks[4].0, ScanState::MarkupText);

        assert_eq!(&content[chunks[1].1..chunks[1].2], "// line comment\n");
        assert_eq!(&content[chunks[3].1..chunks[3].2], "/* block comment */");
    }

    #[test]
    fn test_scan_raw_and_math() {
        let content = "Hello `raw inline` and $x + y = z$ and ```\nraw block\n```";
        let chunks = scan_typst_content(content);

        assert_eq!(chunks[0].0, ScanState::MarkupText);
        assert_eq!(chunks[1].0, ScanState::RawInline);
        assert_eq!(chunks[2].0, ScanState::MarkupText);
        assert_eq!(chunks[3].0, ScanState::Math);
        assert_eq!(chunks[4].0, ScanState::MarkupText);
        assert_eq!(chunks[5].0, ScanState::RawBlock);

        assert_eq!(&content[chunks[1].1..chunks[1].2], "`raw inline`");
        assert_eq!(&content[chunks[3].1..chunks[3].2], "$x + y = z$");
        assert_eq!(&content[chunks[5].1..chunks[5].2], "```\nraw block\n```");
    }

    #[test]
    fn test_scan_code_expressions() {
        let content = "Heading #rect(width: 10pt)[Inside content] trailing text.";
        let chunks = scan_typst_content(content);

        // Expected:
        // 0: MarkupText "Heading "
        // 1: CodeExpression "#rect(width: 10pt)"
        // 2: MarkupText "[Inside content]"
        // 3: CodeExpression "]" // Wait, closing bracket is part of the code block structure
        // 4: MarkupText " trailing text."

        assert_eq!(chunks[0].0, ScanState::MarkupText);
        assert_eq!(&content[chunks[0].1..chunks[0].2], "Heading ");

        assert_eq!(chunks[1].0, ScanState::CodeExpression);
        assert_eq!(&content[chunks[1].1..chunks[1].2], "#rect(width: 10pt)");

        assert_eq!(chunks[2].0, ScanState::MarkupText);
        assert_eq!(&content[chunks[2].1..chunks[2].2], "[Inside content");

        assert_eq!(chunks[3].0, ScanState::CodeExpression);
        assert_eq!(&content[chunks[3].1..chunks[3].2], "]");

        assert_eq!(chunks[4].0, ScanState::MarkupText);
        assert_eq!(&content[chunks[4].1..chunks[4].2], " trailing text.");
    }
}
