import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILLS_BLOCK =
  /\n\n(?:<skills>\s*)?The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>(?:\s*<\/skills>)?/g;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    for (const skill of event.systemPromptOptions.skills) {
      skill.disableModelInvocation = true;
    }
    // Preserve manual-only skills even when an earlier extension forced an opaque prompt.
    const options = event.systemPromptOptions;
    if (options.forceSystemPrompt !== undefined) {
      options.forceSystemPrompt = options.forceSystemPrompt.replace(SKILLS_BLOCK, "");
    }
  });
}
