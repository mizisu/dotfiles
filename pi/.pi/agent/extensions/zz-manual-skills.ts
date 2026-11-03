import {
	parseSkillBlock,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const SKILLS_BLOCK =
	/\n\n(?:<skills>\s*)?The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>(?:\s*<\/skills>)?/g;

export default function (pi: ExtensionAPI) {
	pi.on("context", (event) => {
		// Rebuild from visible context so compaction, branches, and changed skills keep their full instructions.
		const skills = new Map<string, string>();
		const shorten = (text: string): string => {
			const skill = parseSkillBlock(text);
			if (!skill) return text;

			const key = JSON.stringify([skill.name, skill.location]);
			const repeated = skills.get(key) === skill.content;
			skills.set(key, skill.content);
			if (!repeated) return text;

			const suffix = text.slice(
				text.indexOf("\n</skill>") + "\n</skill>".length,
			);
			return `Reapply skill "${skill.name}" (${skill.location}) using its identical instructions above.${suffix}`;
		};

		return {
			messages: event.messages.map((message) => {
				if (message.role !== "user") return message;
				return {
					...message,
					content:
						typeof message.content === "string"
							? shorten(message.content)
							: message.content.map((block) =>
									block.type === "text"
										? { ...block, text: shorten(block.text) }
										: block,
								),
				};
			}),
		};
	});

	pi.on("before_agent_start", (event) => {
		for (const skill of event.systemPromptOptions.skills) {
			skill.disableModelInvocation = true;
		}
		// Preserve manual-only skills even when an earlier extension forced an opaque prompt.
		const options = event.systemPromptOptions;
		if (options.forceSystemPrompt !== undefined) {
			options.forceSystemPrompt = options.forceSystemPrompt.replace(
				SKILLS_BLOCK,
				"",
			);
		}
	});
}
