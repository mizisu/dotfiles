import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionInput {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
}

interface NormalizedQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple: boolean;
  custom: boolean;
}

interface QuestionResultDetails {
  questions: NormalizedQuestion[];
  answers: string[][];
  cancelled: boolean;
  customAnswers: string[];
}

const questionParameters = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "Questions to ask the user. Each question can be single-select or multi-select.",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Complete question to show the user.",
          },
          header: {
            type: "string",
            description: "Short label for this question, e.g. Scope, Checks, Priority. Defaults to Q1, Q2, ...",
          },
          options: {
            type: "array",
            description: "Available choices.",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Display text for this option.",
                },
                description: {
                  type: "string",
                  description: "Optional explanation shown below the option.",
                },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
          multiple: {
            type: "boolean",
            description: "Allow selecting more than one option for this question (default false).",
          },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

function normalizeQuestions(input: QuestionInput[]): NormalizedQuestion[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("at least one question is required");
  if (input.length > 8) throw new Error("question supports at most 8 questions at a time");

  return input.map((question, index) => {
    const text = question.question?.trim();
    if (!text) throw new Error(`question ${index + 1} is empty`);
    if (!Array.isArray(question.options) || question.options.length === 0) {
      throw new Error(`question ${index + 1} must include at least one option`);
    }
    if (question.options.length > 9) throw new Error(`question ${index + 1} supports at most 9 options`);

    const seen = new Set<string>();
    const options = question.options.map((option, optionIndex) => {
      const label = option.label?.trim();
      if (!label) throw new Error(`question ${index + 1}, option ${optionIndex + 1} has an empty label`);
      if (seen.has(label)) throw new Error(`question ${index + 1} has duplicate option label "${label}"`);
      seen.add(label);
      const description = option.description?.trim();
      return { label, ...(description ? { description } : {}) };
    });

    const header = question.header?.trim() || `Q${index + 1}`;
    return {
      question: text,
      header: header.slice(0, 30),
      options,
      multiple: question.multiple === true,
      custom: true,
    };
  });
}

function isCustomSelected(customActive: boolean, customValue: string): boolean {
  return customActive && customValue.trim().length > 0;
}

function answerForQuestion(
  question: NormalizedQuestion,
  selected: Set<string>,
  customActive: boolean,
  customValue: string,
): string[] {
  const answers = question.options
    .map((option) => option.label)
    .filter((label) => selected.has(label));
  const custom = customValue.trim();
  if (customActive && custom) answers.push(custom);
  return answers;
}

function detailsFromState(
  questions: NormalizedQuestion[],
  selections: Set<string>[],
  customActive: boolean[],
  customValues: string[],
  cancelled: boolean,
): QuestionResultDetails {
  const answers = questions.map((question, index) =>
    answerForQuestion(question, selections[index], customActive[index], customValues[index]),
  );
  return {
    questions,
    answers,
    cancelled,
    customAnswers: customValues.map((value, index) => (isCustomSelected(customActive[index], value) ? value.trim() : "")),
  };
}

function formatAnswersForModel(details: QuestionResultDetails): string {
  if (details.cancelled) {
    return "User cancelled the question prompt. Do not assume an answer; continue only if you can choose a safe default, otherwise ask a narrower question.";
  }

  const formatted = details.questions
    .map((question, index) => {
      const answer = details.answers[index];
      return `"${question.question}"="${answer.length ? answer.join(", ") : "Unanswered"}"`;
    })
    .join(", ");

  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}

function countAnswered(details: QuestionResultDetails): number {
  return details.answers.filter((answers) => answers.length > 0).length;
}

export default function askUserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: "Ask the user one or more focused questions when their answer would materially change the work. Supports multi-select and custom answers.",
    promptSnippet: "Use ask_user for targeted user decisions when relevant context is insufficient and the answer would materially change the implementation, safety, production, billing, credential, or tradeoff outcome.",
    promptGuidelines: [
      "Use ask_user for clear option-based user decisions when a user answer is genuinely needed.",
      "When using ask_user, provide concise options with descriptions; put the recommended option first and append '(Recommended)' to its label."
    ],
    parameters: questionParameters,

    async execute(_toolCallId, params: { questions: QuestionInput[] }, _signal, _onUpdate, ctx) {
      let questions: NormalizedQuestion[];
      try {
        questions = normalizeQuestions(params.questions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `ask_user failed: ${message}` }],
          details: { questions: [], answers: [], cancelled: true, customAnswers: [] } satisfies QuestionResultDetails,
          isError: true,
        };
      }

      if (!ctx.hasUI) {
        const details: QuestionResultDetails = {
          questions,
          answers: questions.map(() => []),
          cancelled: true,
          customAnswers: questions.map(() => ""),
        };
        return {
          content: [{ type: "text" as const, text: "ask_user failed: UI is not available in this session." }],
          details,
          isError: true,
        };
      }

      const result = await ctx.ui.custom<QuestionResultDetails | undefined>((tui, theme, _keybindings, done) => {
        const selections = questions.map(() => new Set<string>());
        const customValues = questions.map(() => "");
        const customActive = questions.map(() => false);
        const hasReviewTab = questions.length > 1 || questions.some((question) => question.multiple);
        const totalTabs = questions.length + (hasReviewTab ? 1 : 0);
        let tab = 0;
        let selectedIndex = 0;
        let editMode = false;
        let cachedLines: string[] | undefined;

        const editorTheme: EditorTheme = {
          borderColor: (text: string) => theme.fg("accent", text),
          selectList: {
            selectedPrefix: (text: string) => theme.fg("accent", text),
            selectedText: (text: string) => theme.fg("accent", text),
            description: (text: string) => theme.fg("muted", text),
            scrollInfo: (text: string) => theme.fg("dim", text),
            noMatch: (text: string) => theme.fg("warning", text),
          },
        };
        const editor = new Editor(tui, editorTheme);

        const refresh = () => {
          cachedLines = undefined;
          tui.requestRender();
        };

        const currentQuestion = () => questions[tab];
        const currentOptionCount = () => {
          const question = currentQuestion();
          if (!question) return 0;
          return question.options.length + (question.custom ? 1 : 0);
        };
        const onReviewTab = () => hasReviewTab && tab === questions.length;
        const details = (cancelled: boolean) => detailsFromState(questions, selections, customActive, customValues, cancelled);
        const submit = () => done(details(false));
        const cancel = () => done(details(true));

        const clampSelection = () => {
          selectedIndex = Math.max(0, Math.min(Math.max(0, currentOptionCount() - 1), selectedIndex));
        };

        const goToTab = (next: number) => {
          tab = (next + totalTabs) % totalTabs;
          selectedIndex = 0;
          editMode = false;
          editor.setText("");
          refresh();
        };

        const goNext = () => goToTab(tab + 1);
        const goPrevious = () => goToTab(tab - 1);

        const selectedAnswersFor = (index: number) =>
          answerForQuestion(questions[index], selections[index], customActive[index], customValues[index]);

        const finishSingleSelect = () => {
          if (!hasReviewTab) {
            submit();
            return;
          }
          goNext();
        };

        const chooseOption = () => {
          const question = currentQuestion();
          if (!question) return;

          const isCustom = question.custom && selectedIndex === question.options.length;
          if (isCustom) {
            editMode = true;
            editor.setText(customValues[tab]);
            refresh();
            return;
          }

          const option = question.options[selectedIndex];
          if (!option) return;

          if (question.multiple) {
            if (selections[tab].has(option.label)) selections[tab].delete(option.label);
            else selections[tab].add(option.label);
            refresh();
            return;
          }

          selections[tab].clear();
          selections[tab].add(option.label);
          customActive[tab] = false;
          finishSingleSelect();
        };

        editor.onSubmit = (value: string) => {
          const text = value.trim();
          if (!text) {
            customValues[tab] = "";
            customActive[tab] = false;
            editMode = false;
            editor.setText("");
            refresh();
            return;
          }

          const question = currentQuestion();
          if (!question) return;
          customValues[tab] = text;
          customActive[tab] = true;
          if (!question.multiple) selections[tab].clear();
          editMode = false;
          editor.setText("");

          if (question.multiple) refresh();
          else finishSingleSelect();
        };

        const handleDigit = (data: string): boolean => {
          if (!/^\d$/.test(data)) return false;
          const digit = Number(data);
          const total = currentOptionCount();
          if (digit < 1 || digit > Math.min(total, 9)) return false;
          selectedIndex = digit - 1;
          chooseOption();
          return true;
        };

        const handleInput = (data: string): void => {
          if (editMode) {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
              editMode = false;
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            cancel();
            return;
          }

          if (hasReviewTab && (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || data === "l")) {
            goNext();
            return;
          }
          if (hasReviewTab && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || data === "h")) {
            goPrevious();
            return;
          }

          if (onReviewTab()) {
            if (matchesKey(data, Key.enter)) submit();
            return;
          }

          if (matchesKey(data, Key.up) || data === "k") {
            selectedIndex -= 1;
            clampSelection();
            refresh();
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            selectedIndex += 1;
            clampSelection();
            refresh();
            return;
          }

          if (handleDigit(data)) return;

          if (matchesKey(data, Key.enter) || data === " ") {
            chooseOption();
            return;
          }
        };

        const renderTabs = (width: number): string => {
          if (!hasReviewTab) return "";
          const pieces: string[] = [];
          for (let i = 0; i < questions.length; i++) {
            const active = i === tab;
            const answered = selectedAnswersFor(i).length > 0;
            const icon = answered ? "✓" : "○";
            const raw = ` ${icon} ${questions[i].header} `;
            pieces.push(active ? theme.fg("accent", theme.bold(raw)) : theme.fg(answered ? "success" : "muted", raw));
          }
          const reviewRaw = " Review ";
          pieces.push(onReviewTab() ? theme.fg("accent", theme.bold(reviewRaw)) : theme.fg("dim", reviewRaw));
          return truncateToWidth(` ${pieces.join(theme.fg("dim", "│"))}`, width);
        };

        const renderQuestion = (lines: string[], width: number) => {
          const question = currentQuestion();
          if (!question) return;
          const add = (text = "") => lines.push(text ? truncateToWidth(text, width) : "");
          const selected = selections[tab];
          const customValue = customValues[tab].trim();

          add(` ${theme.fg("text", question.question)}${question.multiple ? theme.fg("dim", " (select all that apply)") : ""}`);
          add("");

          for (let i = 0; i < question.options.length; i++) {
            const option = question.options[i];
            const active = i === selectedIndex;
            const picked = selected.has(option.label);
            const marker = question.multiple ? `[${picked ? "✓" : " "}] ` : picked ? "✓ " : "";
            const prefix = active ? theme.fg("accent", "> ") : "  ";
            const label = `${i + 1}. ${marker}${option.label}`;
            add(prefix + theme.fg(active ? "accent" : picked ? "success" : "text", label));
            if (option.description) add(`     ${theme.fg("muted", option.description)}`);
          }

          if (question.custom) {
            const index = question.options.length;
            const active = index === selectedIndex;
            const picked = isCustomSelected(customActive[tab], customValue);
            const marker = question.multiple ? `[${picked ? "✓" : " "}] ` : picked ? "✓ " : "";
            const suffix = editMode ? " ✎" : "";
            const prefix = active ? theme.fg("accent", "> ") : "  ";
            add(prefix + theme.fg(active ? "accent" : picked ? "success" : "text", `${index + 1}. ${marker}Type your own answer${suffix}`));
            if (customValue) add(`     ${theme.fg("muted", customValue)}`);
          }

          if (editMode) {
            add("");
            add(` ${theme.fg("muted", "Your answer:")}`);
            for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
          }
        };

        const renderReview = (lines: string[], width: number) => {
          const add = (text = "") => lines.push(text ? truncateToWidth(text, width) : "");
          add(` ${theme.fg("accent", theme.bold("Review answers"))}`);
          add("");
          for (let i = 0; i < questions.length; i++) {
            const answers = selectedAnswersFor(i);
            const answerText = answers.length ? answers.join(", ") : "(no answer)";
            add(` ${theme.fg("muted", `${questions[i].header}:`)} ${theme.fg(answers.length ? "text" : "warning", answerText)}`);
            add(`   ${theme.fg("dim", questions[i].question)}`);
          }
        };

        const render = (width: number): string[] => {
          if (cachedLines) return cachedLines;

          const lines: string[] = [];
          const add = (text = "") => lines.push(text ? truncateToWidth(text, width) : "");
          const answeredCount = details(false).answers.filter((answers) => answers.length > 0).length;
          const title = questions.length === 1 ? "Question" : `Questions ${Math.min(tab + 1, questions.length)}/${questions.length}`;

          add(theme.fg("accent", "─".repeat(width)));
          add(` ${theme.fg("accent", theme.bold(`? ${title}`))} ${theme.fg("dim", `${answeredCount}/${questions.length} answered`)}`);
          if (hasReviewTab) {
            add(renderTabs(width));
            add(theme.fg("dim", "─".repeat(width)));
          } else {
            add("");
          }

          if (onReviewTab()) renderReview(lines, width);
          else renderQuestion(lines, width);

          add("");
          if (editMode) {
            add(` ${theme.fg("dim", "enter save • esc back")}`);
          } else if (onReviewTab()) {
            add(` ${theme.fg("dim", "enter submit • tab/←→ questions • esc cancel")}`);
          } else {
            const question = currentQuestion();
            const action = question?.multiple ? "enter/space toggle" : "enter select";
            const nav = hasReviewTab ? " • tab/←→ next/review" : "";
            add(` ${theme.fg("dim", `↑↓/j/k navigate • 1-9 choose • ${action}${nav} • esc cancel`)}`);
          }
          add(theme.fg("accent", "─".repeat(width)));

          cachedLines = lines;
          return cachedLines;
        };

        return {
          render,
          invalidate: () => {
            cachedLines = undefined;
          },
          handleInput,
        };
      });

      const finalResult = result ?? {
        questions,
        answers: questions.map(() => []),
        cancelled: true,
        customAnswers: questions.map(() => ""),
      } satisfies QuestionResultDetails;

      return {
        content: [{ type: "text" as const, text: formatAnswersForModel(finalResult) }],
        details: finalResult,
      };
    },

    renderCall(args, theme) {
      const questions = Array.isArray(args.questions) ? args.questions as QuestionInput[] : [];
      const labels = questions.map((question, index) => question.header || `Q${index + 1}`).join(", ");
      const text = `${theme.fg("toolTitle", theme.bold("ask_user "))}${theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`)}${labels ? theme.fg("dim", ` (${truncateToWidth(labels, 48)})`) : ""}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionResultDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled) return new Text(theme.fg("warning", "Question cancelled"), 0, 0);

      const answered = countAnswered(details);
      const lines = [`${theme.fg("success", "✓")} ${theme.fg("accent", `${answered}/${details.questions.length} answered`)}`];
      for (let i = 0; i < details.questions.length; i++) {
        const answers = details.answers[i];
        lines.push(`${theme.fg("muted", `${details.questions[i].header}:`)} ${theme.fg(answers.length ? "text" : "warning", answers.length ? answers.join(", ") : "(no answer)")}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
