import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRex } from "./shared/rex.js";
import { rexSideExtension } from "./shared/rex-side.js";

export default function sideExtension(pi: ExtensionAPI) {
  if (isRex()) rexSideExtension(pi, fileURLToPath(import.meta.url));
}
