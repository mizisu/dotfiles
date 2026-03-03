"""Smart code chunker for Python and TypeScript/TSX files."""

import ast
import os
import re
from dataclasses import dataclass, asdict

from config import MAX_CHUNK_LINES, MIN_CHUNK_LINES


@dataclass
class CodeChunk:
    file_path: str
    start_line: int
    end_line: int
    name: str
    chunk_type: str  # function, class, method, component, hook, type, interface, module
    language: str
    content: str

    def to_dict(self):
        return asdict(self)


def chunk_file(content: str, file_path: str) -> list[CodeChunk]:
    """Route to appropriate chunker based on file extension."""
    if file_path.endswith(".py"):
        return chunk_python(content, file_path)
    elif file_path.endswith((".ts", ".tsx", ".js", ".jsx")):
        lang = "tsx" if file_path.endswith(".tsx") else "typescript"
        return chunk_typescript(content, file_path, lang)
    return []


# ---------------------------------------------------------------------------
# Python chunker (AST-based)
# ---------------------------------------------------------------------------

def _get_node_source(lines: list[str], node, include_decorators: bool = True) -> tuple[int, int, str]:
    start = node.lineno
    end = node.end_lineno or start
    if include_decorators and hasattr(node, "decorator_list") and node.decorator_list:
        start = min(d.lineno for d in node.decorator_list)
    content = "\n".join(lines[start - 1 : end])
    if end - start + 1 > MAX_CHUNK_LINES:
        content = "\n".join(lines[start - 1 : start - 1 + MAX_CHUNK_LINES])
    return start, end, content


def _class_summary(lines: list[str], node: ast.ClassDef) -> str:
    parts: list[str] = []
    if node.decorator_list:
        dec_start = min(d.lineno for d in node.decorator_list)
        for i in range(dec_start - 1, node.lineno - 1):
            parts.append(lines[i])
    parts.append(lines[node.lineno - 1])
    if (
        node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
        and isinstance(node.body[0].value.value, str)
    ):
        ds = node.body[0]
        for i in range(ds.lineno - 1, (ds.end_lineno or ds.lineno)):
            parts.append(lines[i])
    for child in node.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            parts.append(lines[child.lineno - 1].rstrip())
    return "\n".join(parts)


def chunk_python(content: str, file_path: str) -> list[CodeChunk]:
    lines = content.split("\n")
    chunks: list[CodeChunk] = []

    try:
        tree = ast.parse(content)
    except SyntaxError:
        if len(lines) >= MIN_CHUNK_LINES:
            chunks.append(CodeChunk(
                file_path, 1, min(len(lines), MAX_CHUNK_LINES),
                os.path.basename(file_path), "module", "python",
                "\n".join(lines[:MAX_CHUNK_LINES]),
            ))
        return chunks

    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start, end, src = _get_node_source(lines, node)
            chunks.append(CodeChunk(file_path, start, end, node.name, "function", "python", src))

        elif isinstance(node, ast.ClassDef):
            cls_start = node.lineno
            if node.decorator_list:
                cls_start = min(d.lineno for d in node.decorator_list)
            cls_end = node.end_lineno or node.lineno
            chunks.append(CodeChunk(
                file_path, cls_start, cls_end, node.name, "class", "python",
                _class_summary(lines, node),
            ))
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    m_start, m_end, m_src = _get_node_source(lines, child)
                    chunks.append(CodeChunk(
                        file_path, m_start, m_end,
                        f"{node.name}.{child.name}", "method", "python", m_src,
                    ))

    if not chunks and len(lines) >= MIN_CHUNK_LINES:
        chunks.append(CodeChunk(
            file_path, 1, min(len(lines), MAX_CHUNK_LINES),
            os.path.basename(file_path), "module", "python",
            "\n".join(lines[:MAX_CHUNK_LINES]),
        ))
    return chunks


# ---------------------------------------------------------------------------
# TypeScript / TSX chunker (regex + brace-tracking)
# ---------------------------------------------------------------------------

_TS_DECL_RE = re.compile(
    r"^(?:export\s+)?(?:default\s+)?"
    r"(?:"
    r"(?:(?:async\s+)?function\s+(\w+))"
    r"|(?:(?:abstract\s+)?class\s+(\w+))"
    r"|(?:interface\s+(\w+))"
    r"|(?:type\s+(\w+)\s*[=<])"
    r"|(?:(?:const\s+)?enum\s+(\w+))"
    r"|(?:(?:const|let|var)\s+(\w+)\s*[=:])"
    r")"
)


def _find_block_end(lines: list[str], start: int) -> int:
    """Find end of a brace-delimited block. Tracks () so destructuring is ignored."""
    brace_depth = 0
    paren_depth = 0
    found_open = False
    in_string = False
    string_char = ""
    in_template = False

    for i in range(start, len(lines)):
        line = lines[i]
        j = 0
        while j < len(line):
            ch = line[j]
            if ch == "\\" and j + 1 < len(line):
                j += 2
                continue
            if not in_string and not in_template and ch in ('"', "'"):
                in_string = True
                string_char = ch
            elif in_string and ch == string_char:
                in_string = False
            elif not in_string and ch == "`":
                in_template = not in_template
            elif in_string or in_template:
                j += 1
                continue
            if ch == "/" and j + 1 < len(line) and line[j + 1] == "/":
                break
            if ch == "(":
                paren_depth += 1
            elif ch == ")":
                paren_depth -= 1
            elif ch == "{" and paren_depth <= 0:
                brace_depth += 1
                found_open = True
            elif ch == "}" and paren_depth <= 0:
                brace_depth -= 1
            if found_open and brace_depth <= 0:
                return i + 1
            j += 1
    return len(lines)


def _classify_ts(name: str, raw_type: str, content_preview: str) -> str:
    if raw_type in ("class", "interface", "type", "enum"):
        return raw_type
    if name and name[0].isupper():
        return "component"
    if name and name.startswith("use"):
        return "hook"
    return "function" if raw_type in ("function", "const", "let", "var") else raw_type


def chunk_typescript(content: str, file_path: str, language: str = "typescript") -> list[CodeChunk]:
    lines = content.split("\n")
    chunks: list[CodeChunk] = []
    declarations: list[tuple[int, str, str]] = []

    for i, line in enumerate(lines):
        if line and line[0] in (" ", "\t"):
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
            continue
        m = _TS_DECL_RE.match(stripped)
        if m:
            name = next((g for g in m.groups() if g), None)
            if not name:
                continue
            raw = stripped.lower()
            if "function " in raw:
                raw_type = "function"
            elif "class " in raw:
                raw_type = "class"
            elif "interface " in raw:
                raw_type = "interface"
            elif "type " in raw:
                raw_type = "type"
            elif "enum " in raw:
                raw_type = "enum"
            else:
                raw_type = "const"
            declarations.append((i, name, raw_type))

    for idx, (start_idx, name, raw_type) in enumerate(declarations):
        end_idx = _find_block_end(lines, start_idx)
        if idx + 1 < len(declarations) and end_idx > declarations[idx + 1][0]:
            end_idx = declarations[idx + 1][0]
        while end_idx > start_idx + 1 and not lines[end_idx - 1].strip():
            end_idx -= 1
        if end_idx - start_idx < MIN_CHUNK_LINES:
            continue
        chunk_content = "\n".join(lines[start_idx : min(end_idx, start_idx + MAX_CHUNK_LINES)])
        chunk_type = _classify_ts(name, raw_type, chunk_content[:500])
        chunks.append(CodeChunk(
            file_path, start_idx + 1, end_idx, name, chunk_type, language, chunk_content,
        ))

    if not chunks and len(lines) >= MIN_CHUNK_LINES:
        chunks.append(CodeChunk(
            file_path, 1, min(len(lines), MAX_CHUNK_LINES),
            os.path.basename(file_path), "module", language,
            "\n".join(lines[:MAX_CHUNK_LINES]),
        ))
    return chunks
