## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- When the user's request is ambiguous or has multiple valid interpretations, use the `question` tool before proceeding.
- Use the `question` tool proactively to clarify scope, preferences, constraints, and tradeoffs before making large changes.
- Do all non-blocked exploration first, then ask exactly one focused question if needed.
- Do not use the `question` tool for trivial decisions you can safely default.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Code Search Strategy

**Use precise tools first. grep/rg browsing is a last resort.**

### Decision Tree

1. **Know the symbol name** → `search_symbols` (fastest, most reliable)
2. **Know it exists but not the name** → `code_search` with short English query
3. **code_search returns nothing** → `rg` with exact string pattern
4. **Need structure overview** → `project_map`
5. **Have a symbol, need its definition** → `goto_definition`
6. **Need all usages** → `find_references`
7. **Need type info** → `hover_info`
8. **Need file errors** → `get_diagnostics`

### search_symbols

- **First search: OMIT the kind filter.** Don't guess if it's a class, function, or method.
  - ✅ `search_symbols("ReviewCycleEditor")` → finds the class immediately
  - ❌ `search_symbols("ReviewCycleEditor", kind="function")` → misses it (it's a class)
- **Add kind filter only to narrow down** when too many results come back.
- Use short, exact symbol names. Partial match works, but shorter is better.

### code_search (Semantic Vector Search)

- **Always query in English** — the embedding model is English-optimized.
- **SHORT queries (2-4 keywords).** Use code identifiers, not natural language descriptions.
  - ✅ `"ReviewCycleEditor edit step"` — uses actual class/method names
  - ✅ `"version_id review cycle"` — uses actual field name
  - ❌ `"ReviewCycle model version_id organization version field"` — too long, too vague
  - ❌ `"review cycle editor steps settings page admin"` — pure description, no code terms
- **DO NOT use the language filter on first search.** Fullstack projects have the same concept in both Python and TypeScript. Search all languages first, then filter if too noisy.
  - ❌ `code_search("ReviewCycleEditor", language="tsx")` → misses Python backend class
  - ✅ `code_search("ReviewCycleEditor")` → finds it regardless of language
- **If code_search returns nothing after 2 attempts**, stop using it and switch to `rg` or `search_symbols`.
- `top_k=5` is usually sufficient. Use `top_k=10` only when exploring broadly.

### Fullstack Search: Don't Assume Frontend or Backend

- When the user mentions a domain concept (e.g., "ReviewCycleEditor"), **search across the entire codebase first**.
- Don't assume FE or BE. The same name can exist as a Python class AND a React component.
- If `search_symbols` finds it in one layer, check if there's a counterpart in the other.

### Know When to Stop Exploring

- **For "탐색" (exploration) requests**: Once you find the direct answer (e.g., the dependency map, the method that triggers the change), summarize what you found and ASK if deeper exploration is wanted.
- Don't explore every transitive dependency, every caller, every related service just because they exist.
- A good heuristic: if the question can be answered with what you've already read, stop reading more files.
- Present findings in layers: core answer first, then "관련 참고 사항" for deeper context.

### Never

- Read files one by one hoping to find something.
- Use `grep` when `rg` is available.
- Use `bash cat` to read files when `read` tool exists.
- Use `code_search` more than 2-3 times for the same concept — switch tools.
- Apply a `language` filter on the first search attempt.

## 6. Environment Rules

- Run Python with `uv run python` (not `python` or `python3`)
- Use ripgrep: `rg -t py "pattern"` (no `--include` flag; use `-g '*.py'` or `-t py`)
- Use `rg` instead of `grep`
