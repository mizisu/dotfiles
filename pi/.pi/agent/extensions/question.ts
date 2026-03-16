/**
 * Question Tool — LLM이 사용자에게 역질문하는 도구
 *
 * 단일/다중 질문, 단일/다중 선택, 커스텀 입력 지원.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ──────────────────────────────────────────────

interface QuestionAnswer {
	question: string;
	selected: string[];
	wasCustom: boolean;
}

interface QuestionResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
}

// ── Schema ─────────────────────────────────────────────

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display text (1-5 words, concise)" }),
	description: Type.Optional(
		Type.String({ description: "Brief explanation of this choice" }),
	),
});

const QuestionItemSchema = Type.Object({
	question: Type.String({ description: "The full question text" }),
	header: Type.Optional(
		Type.String({ description: "Short label for tab bar (max 30 chars)" }),
	),
	options: Type.Array(OptionSchema, { description: "Available choices" }),
	multiple: Type.Optional(
		Type.Boolean({
			description: "Allow selecting multiple choices (default: false)",
		}),
	),
});

const Params = Type.Object({
	questions: Type.Array(QuestionItemSchema, {
		description: "Questions to ask the user",
	}),
});

// ── Prompt ─────────────────────────────────────────────

const DESCRIPTION = `Ask the user questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices about what direction to take

Usage notes:
- A "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- If you recommend a specific option, make it first and add "(Recommended)" to its label
- Set multiple: true when the user should be able to pick more than one option
- Keep questions focused and option labels concise (1-5 words)`;

const GUIDELINES = [
	"When the user's request is ambiguous or has multiple valid interpretations, use the question tool to clarify before proceeding. Don't make assumptions about user intent.",
	"Use the question tool proactively to gather preferences, clarify scope, and confirm approach before making large changes.",
	"Don't overuse the question tool for trivial decisions you can make yourself. Use it for choices that meaningfully affect the outcome.",
];

// ── Extension ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: DESCRIPTION,
		promptSnippet:
			"Ask the user questions with options to clarify requirements or get decisions",
		promptGuidelines: GUIDELINES,
		parameters: Params,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI)
				return err("Error: UI not available (non-interactive mode)");
			if (!params.questions.length) return err("Error: No questions provided");

			const questions = params.questions.map((q, i) => ({
				...q,
				header: q.header || `Q${i + 1}`,
				multiple: q.multiple ?? false,
			}));
			const showTabs = questions.length > 1;

			const result = await ctx.ui.custom<QuestionResult>(
				(tui, theme, _kb, done) => {
					// ── State ──
					let tab = 0;
					let cursor = 0;
					let editing = false;
					let cache: string[] | undefined;
					const answers = new Map<
						number,
						{ selected: Set<string>; wasCustom: boolean }
					>();

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					// ── Helpers ──
					const refresh = () => {
						cache = undefined;
						tui.requestRender();
					};
					const q = () => questions[tab];
					const opts = () =>
						q()
							? [
									...q().options,
									{ label: "Type your own answer", description: undefined },
								]
							: [];
					const isCustomIdx = (i: number) => i === opts().length - 1;
					const answer = (qi: number) => answers.get(qi);
					const isSelected = (qi: number, label: string) =>
						answer(qi)?.selected.has(label) ?? false;

					function customText(qi: number): string | undefined {
						const a = answer(qi);
						if (!a?.wasCustom) return undefined;
						const labels = new Set(questions[qi].options.map((o) => o.label));
						return [...a.selected].find((s) => !labels.has(s));
					}

					function setAnswer(
						qi: number,
						selected: Set<string>,
						wasCustom: boolean,
					) {
						answers.set(qi, { selected, wasCustom });
					}

					function toggleOption(idx: number) {
						const label = opts()[idx].label;
						const a = answer(tab);
						const selected = new Set(a?.selected ?? []);
						if (selected.has(label)) selected.delete(label);
						else selected.add(label);
						setAnswer(tab, selected, a?.wasCustom ?? false);
						refresh();
					}

					function advance() {
						if (!showTabs) return submitAll(false);
						tab = Math.min(tab + 1, questions.length);
						cursor = 0;
						refresh();
					}

					function submitAll(cancelled: boolean) {
						done({
							answers: questions.map((question, i) => {
								const a = answer(i);
								return {
									question: question.question,
									selected: a ? [...a.selected] : [],
									wasCustom: a?.wasCustom ?? false,
								};
							}),
							cancelled,
						});
					}

					// ── Editor submit ──
					editor.onSubmit = (value) => {
						const text = value.trim();
						if (!text) {
							editing = false;
							editor.setText("");
							return refresh();
						}
						if (q().multiple) {
							const a = answer(tab);
							const selected = new Set(a?.selected ?? []);
							selected.add(text);
							setAnswer(tab, selected, true);
							editing = false;
							editor.setText("");
							refresh();
						} else {
							setAnswer(tab, new Set([text]), true);
							editing = false;
							editor.setText("");
							advance();
						}
					};

					// ── Input handler ──
					function handleInput(data: string) {
						// Editor mode
						if (editing) {
							if (matchesKey(data, Key.escape)) {
								editing = false;
								editor.setText("");
								return refresh();
							}
							editor.handleInput(data);
							return refresh();
						}

						// Tab forward
						if (
							matchesKey(data, Key.tab) ||
							(showTabs && matchesKey(data, Key.right))
						) {
							if (showTabs) {
								tab = (tab + 1) % (questions.length + 1);
								cursor = 0;
								refresh();
							} else if (q()?.multiple) {
								submitAll(false);
							}
							return;
						}
						// Tab backward
						if (
							matchesKey(data, Key.shift("tab")) ||
							(showTabs && matchesKey(data, Key.left))
						) {
							if (showTabs) {
								tab = (tab - 1 + questions.length + 1) % (questions.length + 1);
								cursor = 0;
								refresh();
							}
							return;
						}

						// Submit tab
						if (tab === questions.length) {
							if (matchesKey(data, Key.enter)) submitAll(false);
							else if (matchesKey(data, Key.escape)) submitAll(true);
							return;
						}

						// Up/Down
						if (matchesKey(data, Key.up)) {
							cursor = Math.max(0, cursor - 1);
							return refresh();
						}
						if (matchesKey(data, Key.down)) {
							cursor = Math.min(opts().length - 1, cursor + 1);
							return refresh();
						}

						// Space (multi-select toggle)
						if (data === " " && q().multiple && !isCustomIdx(cursor))
							return toggleOption(cursor);

						// Enter
						if (matchesKey(data, Key.enter)) {
							if (isCustomIdx(cursor)) {
								editing = true;
								editor.setText("");
								return refresh();
							}
							if (q().multiple) return toggleOption(cursor);
							setAnswer(tab, new Set([opts()[cursor].label]), false);
							return advance();
						}

						// Escape → cancel
						if (matchesKey(data, Key.escape)) submitAll(true);
					}

					// ── Render ──
					function render(width: number): string[] {
						if (cache) return cache;
						const lines: string[] = [];
						const add = (s: string) => lines.push(truncateToWidth(s, width));

						add(theme.fg("accent", "─".repeat(width)));

						// Tab bar
						if (showTabs) {
							const tabs: string[] = [];
							for (let i = 0; i < questions.length; i++) {
								const active = i === tab;
								const answered = (answer(i)?.selected.size ?? 0) > 0;
								const icon = answered ? "■" : "□";
								const text = ` ${icon} ${questions[i].header} `;
								tabs.push(
									active
										? theme.bg("selectedBg", theme.fg("text", text))
										: theme.fg(answered ? "success" : "muted", text),
								);
							}
							const submitActive = tab === questions.length;
							const submitText = " ✓ Submit ";
							tabs.push(
								submitActive
									? theme.bg("selectedBg", theme.fg("text", submitText))
									: theme.fg("dim", submitText),
							);
							add(` ← ${tabs.join(" ")} →`);
							lines.push("");
						}

						// Submit tab
						if (tab === questions.length) {
							add(theme.fg("accent", theme.bold(" Review & Submit")));
							lines.push("");
							for (let i = 0; i < questions.length; i++) {
								const a = answer(i);
								const h = questions[i].header;
								if (a && a.selected.size > 0) {
									add(
										` ${theme.fg("muted", `${h}:`)} ${theme.fg("text", [...a.selected].join(", "))}`,
									);
								} else {
									add(
										` ${theme.fg("warning", `${h}:`)} ${theme.fg("dim", "(unanswered)")}`,
									);
								}
							}
							lines.push("");
							add(theme.fg("dim", " Press Enter to submit"));
						} else {
							// Question content
							const question = q();
							add(theme.fg("text", ` ${question.question}`));
							if (question.multiple)
								add(theme.fg("dim", "  (select multiple)"));
							lines.push("");

							const optList = opts();
							for (let i = 0; i < optList.length; i++) {
								const opt = optList[i];
								const active = i === cursor;
								const custom = isCustomIdx(i);
								const selected = !custom && isSelected(tab, opt.label);
								const ct = custom ? customText(tab) : undefined;
								const customSelected = custom && ct !== undefined;
								const prefix = active ? theme.fg("accent", "> ") : "  ";

								let icon: string;
								if (custom) {
									icon = editing
										? "✎"
										: customSelected
											? question.multiple
												? "■"
												: "●"
											: "…";
								} else if (question.multiple) {
									icon = selected ? "■" : "□";
								} else {
									icon = selected ? "●" : "○";
								}

								const color = active
									? "accent"
									: selected || customSelected
										? "success"
										: "text";
								add(prefix + theme.fg(color, `${icon} ${opt.label}`));
								if (opt.description)
									add(`     ${theme.fg("muted", opt.description)}`);
								if (custom && !editing && ct)
									add(`     ${theme.fg("dim", `"${ct}"`)}`);
							}

							// Inline editor
							if (editing) {
								lines.push("");
								add(theme.fg("muted", " Your answer:"));
								for (const line of editor.render(width - 2)) add(` ${line}`);
							}
						}

						// Hints
						lines.push("");
						if (editing) {
							add(theme.fg("dim", " Enter submit • Esc back"));
						} else if (tab === questions.length) {
							add(
								theme.fg(
									"dim",
									showTabs
										? " Enter submit • Tab/←→ navigate • Esc cancel"
										: " Enter submit • Esc cancel",
								),
							);
						} else {
							const parts: string[] = ["↑↓ navigate"];
							if (q().multiple) parts.push("Space toggle");
							else parts.push("Enter select");
							if (showTabs) parts.push("Tab/←→ questions");
							else if (q().multiple) parts.push("Tab submit");
							parts.push("Esc cancel");
							add(theme.fg("dim", ` ${parts.join(" • ")}`));
						}
						add(theme.fg("accent", "─".repeat(width)));

						cache = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cache = undefined;
						},
						handleInput,
					};
				},
			);

			// ── Format for LLM ──
			if (result.cancelled) {
				return {
					content: [
						{
							type: "text",
							text: "User dismissed the questions. Do not continue with the dismissed topic. Adjust your approach or ask different questions if needed.",
						},
					],
					details: result,
				};
			}

			const formatted = result.answers
				.map(
					(a) =>
						`"${a.question}" = "${a.selected.length ? a.selected.join(", ") : "Unanswered"}"`,
				)
				.join(", ");

			return {
				content: [
					{
						type: "text",
						text: `User has answered your questions: ${formatted}. Continue with the user's answers in mind.`,
					},
				],
				details: result,
			};
		},

		// ── Rendering ──

		renderCall(args, theme) {
			const qs = Array.isArray(args.questions) ? args.questions : [];
			let text = theme.fg("toolTitle", theme.bold("question "));
			text += theme.fg(
				"muted",
				`${qs.length} question${qs.length !== 1 ? "s" : ""}`,
			);
			if (qs.length === 1 && qs[0]?.question) {
				text += "\n" + theme.fg("dim", `  ${qs[0].question}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const d = result.details as QuestionResult | undefined;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			if (d.cancelled) return new Text(theme.fg("warning", "Dismissed"), 0, 0);
			const lines = d.answers.map((a) => {
				const val = a.selected.length ? a.selected.join(", ") : "(no answer)";
				const pre = a.wasCustom ? theme.fg("muted", "(wrote) ") : "";
				return `${theme.fg("success", "✓ ")}${pre}${theme.fg("accent", val)}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

function err(msg: string) {
	return {
		content: [{ type: "text" as const, text: msg }],
		details: { answers: [], cancelled: true } as QuestionResult,
	};
}
