import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	loadSkillsFromDir,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

const root = process.env.PPI_ROOT;
if (!root) throw new Error("Start this adapter with ppi.");
const pstack = join(root, "upstream", "pstack");
const skillsDir = join(pstack, "skills");
const registrationEvent = "pi-subagents:runtime-agent-register:v1";

type Registration = { dispose(): void };
type RegistrationRequest = {
	version: 1;
	name: string;
	definition: {
		description: string;
		systemPrompt: string;
		systemPromptMode: "append";
		inheritProjectContext: true;
		inheritGlobalContext: true;
		inheritSkills: false;
		allowNestedSubagents: false;
		defaultContext: "fresh";
		model: "inherit";
		skills: string[];
		skillPath: string[];
		tools?: string[];
	};
	result?:
		| { ok: true; registration: Registration }
		| { ok: false; error: Error };
};

export default function (pi: ExtensionAPI) {
	const { skills, diagnostics } = loadSkillsFromDir({
		dir: skillsDir,
		source: "ppi",
	});
	if (
		skills.length === 0 ||
		diagnostics.some((item) => item.type === "error")
	) {
		throw new Error(
			"Cannot load pstack skills. Run ppi update and inspect its output.",
		);
	}
	const instructions = readFileSync(join(root, "pi.md"), "utf8")
		.split("{{PSTACK}}")
		.join(pstack)
		.split("{{MODEL_RULE}}")
		.join(join(root, "pstack-models.md"));
	const visibleSkills = skills
		.filter((skill) => !skill.disableModelInvocation)
		.map((skill) => skill.name);
	const registrations: Registration[] = [];

	pi.on("before_agent_start", (event, ctx) => {
		event.systemPromptOptions.sections.ppi = instructions;
		event.systemPromptOptions.sections.ppi_session =
			`Current workspace session directory: ${ctx.sessionManager.getSessionDir()}\n` +
			`Current session file: ${ctx.sessionManager.getSessionFile() ?? "not persisted"}`;
	});

	pi.on("session_start", () => {
		const profiles = [
			{
				name: "ppi-poteto",
				description: "pstack implementation and scoped helper tasks",
				prompt: stripFrontmatter(
					readFileSync(join(pstack, "agents", "poteto-agent.md"), "utf8"),
				),
				readonly: false,
			},
			{
				name: "ppi-general",
				description: "General-purpose pstack delegate",
				prompt:
					"Complete only the task assigned by your parent. Follow the referenced pstack skills.",
				readonly: false,
			},
			{
				name: "ppi-reviewer",
				description:
					"Read-only pstack exploration, explanation, and adversarial review",
				prompt:
					"Investigate the assigned scope and report evidence. Do not modify files or external state.",
				readonly: true,
			},
			{
				name: "ppi-comment-sicko",
				description: "pstack comment review, findings only",
				prompt: stripFrontmatter(
					readFileSync(join(pstack, "agents", "comment-sicko.md"), "utf8"),
				),
				readonly: true,
			},
		];
		try {
			for (const profile of profiles) {
				const request: RegistrationRequest = {
					version: 1,
					name: profile.name,
					definition: {
						description: profile.description,
						systemPrompt: [
							profile.prompt,
							instructions,
							`The poteto-mode skill is ${join(skillsDir, "poteto-mode", "SKILL.md")}.`,
							"You are a leaf delegate. The parent owns orchestration. Do not spawn other agents; report any need for further delegation to the parent.",
							...(profile.readonly
								? [
										"Report findings only. Do not edit files or mutate external state. Shell access is not permission to write.",
									]
								: []),
						].join("\n\n"),
						systemPromptMode: "append",
						inheritProjectContext: true,
						inheritGlobalContext: true,
						inheritSkills: false,
						allowNestedSubagents: false,
						defaultContext: "fresh",
						model: "inherit",
						skills: visibleSkills,
						skillPath: [skillsDir],
						...(profile.readonly
							? { tools: ["read", "bash", "grep", "find", "ls"] }
							: {}),
					},
				};
				pi.events.emit(registrationEvent, request);
				if (!request.result)
					throw new Error(
						"ppi requires pi-subagents with runtime agent registration support.",
					);
				if (request.result.ok === false) throw request.result.error;
				registrations.push(request.result.registration);
			}
		} catch (error) {
			for (const registration of registrations.splice(0))
				registration.dispose();
			throw error;
		}
	});

	pi.on("session_shutdown", () => {
		for (const registration of registrations.splice(0)) registration.dispose();
	});
}
