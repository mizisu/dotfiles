import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CommandResult = {
	code: number;
	stdout: string;
	stderr: string;
};

function formatFailure(command: string, result: CommandResult): string {
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	return output ? `${command} failed (${result.code})\n${output}` : `${command} failed (${result.code})`;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				code: code ?? 1,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
			});
		});
	});
}

export default function updateSkillsExtension(pi: ExtensionAPI) {
	pi.registerCommand("update-skills", {
		description: "Sync gst/vi skills, then reload resources",
		handler: async (_args, ctx) => {
			const home = homedir();
			const gstSync = join(home, ".pi", "agent", "skills", "gst-sync.sh");
			const viSync = join(home, ".pi", "agent", "skills", "vi-sync.sh");

			for (const script of [gstSync, viSync]) {
				if (!existsSync(script)) {
					ctx.ui.notify(`Missing sync script: ${script}`, "error");
					return;
				}
			}

			ctx.ui.notify("Syncing gstack skills...", "info");
			const gstResult = await runCommand("bash", [gstSync]);
			if (gstResult.code !== 0) {
				ctx.ui.notify(formatFailure("gst-sync.sh", gstResult), "error");
				return;
			}

			ctx.ui.notify("Syncing visual-explainer skills...", "info");
			const viResult = await runCommand("bash", [viSync]);
			if (viResult.code !== 0) {
				ctx.ui.notify(formatFailure("vi-sync.sh", viResult), "error");
				return;
			}

			ctx.ui.notify("Skill sync complete. Reloading resources...", "info");
			await ctx.reload();
		},
	});
}
