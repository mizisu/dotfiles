import { resolve, sep } from "node:path";
import {
	type ExtensionAPI,
	formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";

const SKILLS_BLOCK =
	/\n\n(?:<skills>\s*)?The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>(?:\s*<\/skills>)?/g;

export default function (pi: ExtensionAPI) {
	const pstackSkillsPrefix = process.env.PPI_ROOT
		? resolve(process.env.PPI_ROOT, "upstream", "pstack", "skills") + sep
		: undefined;

	pi.on("before_agent_start", (event) => {
		for (const skill of event.systemPromptOptions.skills) {
			if (pstackSkillsPrefix && resolve(skill.filePath).startsWith(pstackSkillsPrefix)) continue;
			skill.disableModelInvocation = true;
		}
		// Preserve pstack invocation policy even when an earlier extension forced an opaque prompt.
		const options = event.systemPromptOptions;
		if (options.forceSystemPrompt !== undefined) {
			options.forceSystemPrompt = options.forceSystemPrompt.replace(
				SKILLS_BLOCK,
				() => formatSkillsForPrompt(options.skills, "indirect"),
			);
		}
	});
}
