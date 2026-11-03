export const WRITING_STYLE_PROMPT = `Output language:
- Explicit user language instructions have the highest priority.
- Otherwise, follow the predominant language of the provided author style examples. When repository history is supplied as the fallback style reference, use its language instead.
- If no usable style history is available or its language is unclear, use Korean.
- Apply the selected language to generated titles, subjects, descriptions, and body prose. Do not let the prompt, template, or skill examples override this choice.
- Preserve code identifiers, paths, API names, issue keys, and required format tokens such as Conventional Commit types. Mermaid labels remain English.

Writing style (ASD-STE100-inspired clarity, not verified standard compliance):
- ASD-STE100 is an English standard. For other output languages, adapt only its clarity principles without changing the selected language.
- Use short, direct sentences with one main point per sentence.
- Prefer active voice and simple sentence structures when natural in the selected language.
- Use the same term for the same concept. Preserve precise technical terminology.
- Avoid idioms, unnecessary jargon, decorative wording, and redundant explanations.
- Preserve the facts, qualifications, and technical details needed for review; do not simplify away important meaning.
- For English prose, keep procedural sentences within 20 words and descriptive sentences within 25 words.
- For Korean and other languages, use natural concise phrasing; do not impose English word-count limits or the STE approved-word dictionary.
- Use author examples for language, structure, and detail level, but do not copy wording that conflicts with these clarity principles.
- Do not claim verified or full ASD-STE100 compliance.`;
