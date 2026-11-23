/**
 * pi-toolcalls — control how tool-call rows appear in the pi coding agent TUI.
 *
 * Three modes (default: hidden):
 *   hidden   no tool-call rows at all, not even errors — cleanest transcript
 *   compact  one summary line per call, with the elapsed time appended once it
 *            finishes (`▸ bash: ls -la · 1.2s`); one red line when a call fails;
 *            Ctrl+O (or a click on the row) expands the output
 *   native   pi's own rendering (output included, Ctrl+O to fold)
 *
 * Commands:
 *   /toolcalls            show the current mode
 *   /toolcalls hidden     hide tool-call rows (default)
 *   /toolcalls compact    one summary line per call (+ elapsed, expandable)
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

/** Expanded output is capped so one huge result cannot flood the transcript. */
const EXPANDED_MAX_LINES = 400;
const EXPANDED_MAX_CHARS = 40_000;

/** Per-row renderer state, shared between renderCall and renderResult. */
interface RowState {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  /** Themed `▸ tool` title of the call row. */
  label?: string;
  /** One-line description of the call arguments. */
  summary?: string;
  /** The call row component, so the final timing can be folded into that line. */
  callText?: Text;
}

type Theme = {
  fg(color: string, text: string): string;
};

type RenderContext = {
  state: RowState;
  durationMs?: number;
  isPartial?: boolean;
  expanded?: boolean;
  executionStarted?: boolean;
  invalidate?: () => void;
};

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

/** `840ms`, `4.2s`, `1m 30s`, `2h 3m`. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds - minutes * 60);
  if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes - hours * 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
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

/** Full text output, capped, for the expanded row. */
function outputText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .replace(/\s+$/, "");
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length > EXPANDED_MAX_LINES) {
    lines.length = EXPANDED_MAX_LINES;
    lines.push(`… output truncated at ${EXPANDED_MAX_LINES} lines`);
  }
  const joined = lines.join("\n");
  return joined.length > EXPANDED_MAX_CHARS
    ? `${joined.slice(0, EXPANDED_MAX_CHARS)}\n… output truncated at ${EXPANDED_MAX_CHARS} chars`
    : joined;
}

function stopTimer(state: RowState): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
}

/** Rebuild the call row with `· 4.2s` appended. No-op without a duration. */
function applyTiming(state: RowState, theme: Theme, durationMs: number | undefined): void {
  if (!state.callText || durationMs === undefined) return;
  const suffix = formatDuration(durationMs);
  if (!suffix) return;
  const base = state.summary
    ? `${state.label ?? ""} ${theme.fg("dim", state.summary)}`
    : (state.label ?? "");
  state.callText.setText(`${base} ${theme.fg("dim", `· ${suffix}`)}`);
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

    return {
      renderCall(args, theme, context) {
        const state = (context as unknown as RenderContext).state;
        const themed = theme as Theme;
        if (state && state.startedAt === undefined) state.startedAt = Date.now();
        const summary = summarize(args as Record<string, unknown>);
        // While the call runs, redraw once a second so the elapsed time climbs.
        if (state && !state.interval && !state.endedAt && context.executionStarted) {
          state.interval = setInterval(() => {
            if (!state.endedAt) context.invalidate?.();
            else stopTimer(state);
          }, 1000);
        }
        const label = themed.fg("toolTitle", `▸ ${toolName}`);
        if (state) {
          state.label = label;
          state.summary = summary;
        }
        // While running, show the elapsed time climbing on the same line.
        const running = state?.startedAt !== undefined && state.endedAt === undefined;
        const elapsed = running ? formatDuration(Date.now() - (state!.startedAt as number)) : "";
        const parts = [summary ? `${label} ${themed.fg("dim", summary)}` : label];
        if (elapsed) parts.push(themed.fg("dim", `· ${elapsed}`));
        const text = new Text(parts.join(" "), 0, 0);
        if (state) state.callText = text;
        return text;
      },

      renderResult(result, options, theme, context) {
        const row = context as unknown as RenderContext;
        const themed = theme as Theme;
        const state = row.state ?? {};
        const partial = row.isPartial ?? options.isPartial;

        // Duration: prefer pi's recorded value, fall back to our own clock.
        let durationMs = row.durationMs;
        if (!partial) {
          if (state.endedAt === undefined) state.endedAt = Date.now();
          stopTimer(state);
          if (durationMs === undefined && state.startedAt !== undefined) {
            durationMs = state.endedAt - state.startedAt;
          }
        }

        // The final timing replaces the running clock on the call row.
        applyTiming(state, themed, durationMs);

        // Expanded: the call line stays as the header, the output follows indented.
        if (options.expanded) {
          const body = outputText(result);
          return body ? new Text(themed.fg("dim", body), 2, 0) : new Container();
        }

        if ((context as { isError?: boolean }).isError) {
          const detail = firstLine(result);
          const head = themed.fg("error", `✗ ${toolName}`);
          return new Text(detail ? `${head} ${themed.fg("dim", detail)}` : head, 0, 0);
        }

        // Success: the whole row stays one line.
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
            ? "One line per call with elapsed time; failures show one error line; Ctrl+O expands output."
            : "Native pi rendering restored (output included, Ctrl+O to fold).";
      ctx.ui.notify(hint, "info");
      ctx.ui.setStatus("toolcalls", `tools: ${mode}`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("toolcalls", `tools: ${mode}`);
  });
}
