import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LbManager } from "./shared/lb.js";

export default function lbExtension(pi: ExtensionAPI) {
  const manager = new LbManager(pi.exec.bind(pi));
  let busy = false;

  pi.registerCommand("lb", {
    description: "Open Lemonbase, or manage BE/FE in branch-named windows of the shared lb Rex session: /lb [start|stop|restart|status]",
    getArgumentCompletions(prefix) {
      const items = ["start", "stop", "restart", "status"].filter((value) => value.startsWith(prefix));
      return items.length ? items.map((value) => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      const action = args.trim();
      if (action && action !== "start" && action !== "stop" && action !== "restart" && action !== "status") {
        ctx.ui.notify("사용법: /lb [start|stop|restart|status]", "warning");
        return;
      }
      if (busy) {
        ctx.ui.notify("이 pi 세션에서 /lb 작업이 진행 중입니다.", "warning");
        return;
      }
      busy = true;
      try {
        const target = await manager.target(ctx);
        if (!target) return;
        if (!action) {
          ctx.ui.notify(`열기: ${await manager.open(target)}`, "info");
        } else if (action === "status") {
          ctx.ui.notify(await manager.status(target), "info");
        } else if (action === "stop") {
          const result = await manager.stop(target);
          ctx.ui.notify(result.message, result.warning ? "warning" : "info");
        } else {
          const restart = action === "restart";
          ctx.ui.notify(`BE/FE ${restart ? "재시작" : "시작"}: ${target.root}`, "info");
          await manager.start(target, { restart });
          ctx.ui.notify(await manager.status(target), "info");
        }
      } catch (error) {
        ctx.ui.notify(`lb: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally { busy = false; }
    },
  });
}
