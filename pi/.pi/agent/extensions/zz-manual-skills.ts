const SKILLS_BLOCK =
  /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/g;

export default function (pi: any) {
  pi.on("before_agent_start", (event: any) => {
    for (const skill of event.systemPromptOptions?.skills ?? []) {
      skill.disableModelInvocation = true;
    }

    return {
      systemPrompt: event.systemPrompt.replace(SKILLS_BLOCK, ""),
    };
  });
}
