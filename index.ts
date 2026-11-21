/**
 * pi-toolcalls — control how tool-call rows appear in the pi coding agent TUI.
 *
 * Three modes (default: hidden):
 *   hidden   no tool-call rows at all, not even errors — cleanest transcript
 *   compact  one summary line per call, plus one red line when a call fails
 *   native   pi's own rendering (output included, Ctrl+O to fold)
 *
 * Commands:
 *   /toolcalls            show the current mode
 *   /toolcalls hidden     hide tool-call rows (default)
 *   /toolcalls compact    one summary line per call
 *   /toolcalls native     restore pi's native rendering
 *   /toolcalls toggle     cycle hidden -> compact -> native
 *
 * The mode persists in <agentDir>/tool-display.json.
 * PI_TOOL_DISPLAY=hidden|compact|native overrides it for one run.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Mode = "hidden" | "compact" | "native";

const MODES: Mode[] = ["hidden", "compact", "native"];
const CONFIG_PATH = join(getAgentDir(), "tool-display.json");

/** Argument keys that best describe a call, in priority order. */
const SUMMARY_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "name", "text"];

function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as string[]).includes(value);
}

function readMode(): Mode {
  const fromEnv = process.env.PI_TOOL_DISPLAY;
  if (isMode(fromEnv)) return fromEnv;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { mode?: unknown };
    if (isMode(parsed.mode)) return parsed.mode;
  } catch {
    // Missing or unreadable config: fall through to the default.
  }
  return "hidden";
}

function writeMode(mode: Mode): void {
  try {
    writeFileSync(CONFIG_PATH, `${JSON.stringify({ mode }, null, 2)}\n`, "utf-8");
  } catch {
    // A read-only agent directory only costs persistence, not behavior.
  }
}

function shorten(value: string, max = 80): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Pick the shortest string that still identifies the call. */
function summarize(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return shorten(value);
  }
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim()) return shorten(value);
    if (typeof value === "number") return String(value);
  }
  return "";
}

/** First non-empty text line of a tool result, used for the compact error row. */
function firstLine(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  if (!Array.isArray(content)) return "";
  const block = content.find((item) => item?.type === "text" && item.text);
  if (!block?.text) return "";
  const line = block.text.split("\n").find((item) => item.trim()) ?? "";
  return shorten(line, 100);
}

export default function piToolcalls(pi: ExtensionAPI): void {
  let mode: Mode = readMode();

  // A global renderer resolver: it applies to built-in, extension, and MCP tools.
  pi.registerToolRenderer((toolName, next) => {
    // native: hand the row back to the remaining resolvers or the tool itself.
    if (mode === "native") return next();

    // hidden: render nothing, and skip the default Box so no padded blank row stays.
    if (mode === "hidden") {
      return {
        renderShell: "self" as const,
        renderCall: () => new Container(),
        renderResult: () => new Container(),
      };
    }

    // compact: one summary line; one error line on failure; never the output.
    return {
      renderCall(args, theme) {
        if (mode === "hidden") return new Container();
        const summary = summarize(args as Record<string, unknown>);
        const label = theme.fg("toolTitle", `▸ ${toolName}`);
        return new Text(summary ? `${label} ${theme.fg("dim", summary)}` : label, 0, 0);
      },
      renderResult(result, _options, theme, context) {
        if (mode === "hidden") return new Container();
        if (context?.isError) {
          const detail = firstLine(result);
          const head = theme.fg("error", `✗ ${toolName}`);
          return new Text(detail ? `${head} ${theme.fg("dim", detail)}` : head, 0, 0);
        }
        return new Container();
      },
    };
  });

  pi.registerCommand("toolcalls", {
    description: "Tool-call display: hidden | compact | native | toggle",
    getArgumentCompletions: (prefix: string) =>
      [...MODES, "toggle"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    async handler(args, ctx) {
      const wanted = (args || "").trim().toLowerCase();

      if (!wanted) {
        ctx.ui.notify(`Tool-call display: ${mode} (hidden / compact / native)`, "info");
        return;
      }

      let nextMode: Mode;
      if (wanted === "toggle") {
        nextMode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
      } else if (isMode(wanted)) {
        nextMode = wanted;
      } else {
        ctx.ui.notify(`Unknown mode "${wanted}". Use hidden / compact / native / toggle.`, "warning");
        return;
      }

      mode = nextMode;
      writeMode(mode);
      const hint =
        mode === "hidden"
          ? "Tool-call rows hidden (errors included). Use /toolcalls compact or native to bring them back."
          : mode === "compact"
            ? "One summary line per call; failures show one error line; output stays hidden."
            : "Native pi rendering restored (output included, Ctrl+O to fold).";
      ctx.ui.notify(hint, "info");
      ctx.ui.setStatus("toolcalls", `tools: ${mode}`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("toolcalls", `tools: ${mode}`);
  });
}
