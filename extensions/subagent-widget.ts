/**
 * Subagent Widget — spawn, wait, and manage background subagents with live widgets
 *
 * Each /sub spawns a background Pi subagent with its own persistent session,
 * enabling conversation continuations via /subcont.
 *
 * Usage: pi -e extensions/subagent-widget.ts
 *
 * Commands:
 *   /sub <task>               — spawn a new subagent
 *   /subwait [ids]            — wait for subagent(s) to complete
 *   /sublist                  — list all subagents with status
 *   /subcont <id> <prompt>    — continue a subagent's conversation
 *   /subrm <id>               — remove a subagent
 *   /subclear                 — remove all subagents
 *
 * Tools:
 *   subagent_create({ task })                     — spawn subagent
 *   subagent_wait({ ids?, timeout? })             — wait for completion
 *   subagent_list()                               — list subagents
 *   subagent_continue({ id, prompt })             — continue conversation
 *   subagent_remove({ id })                       — remove subagent
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyExtensionDefaults } from "./themeMap.ts";

interface SubState {
	id: number;
	status: "running" | "done" | "error";
	task: string;
	textChunks: string[];
	toolCount: number;
	elapsed: number;
	sessionFile: string;   // persistent JSONL session path — used by /subcont to resume
	turnCount: number;     // increments each time /subcont continues this agent
	proc?: any;            // active ChildProcess ref (for kill on /subrm)
	result?: string;       // cached final result for subagent_wait
	completionResolve?: () => void;  // resolves when subagent completes
	// Subagent configuration
	model?: string;        // model override for this subagent
	tools?: string;        // tools override for this subagent
	thinking?: string;     // thinking level override
}

export default function (pi: ExtensionAPI) {
	const agents: Map<number, SubState> = new Map();
	const waitingIds: Set<number> = new Set();  // IDs being waited on — suppress their notifications
	let nextId = 1;
	let widgetCtx: any;

	// ── Session file helpers ──────────────────────────────────────────────────

	function makeSessionFile(id: number): string {
		const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
	}

	// ── Widget rendering ──────────────────────────────────────────────────────

	function updateWidgets() {
		if (!widgetCtx) return;

		for (const [id, state] of Array.from(agents.entries())) {
			const key = `sub-${id}`;
			widgetCtx.ui.setWidget(key, (_tui: any, theme: any) => {
				const container = new Container();
				const borderFn = (s: string) => theme.fg("dim", s);

				container.addChild(new Text("", 0, 0)); // top margin
				container.addChild(new DynamicBorder(borderFn));
				const content = new Text("", 1, 0);
				container.addChild(content);
				container.addChild(new DynamicBorder(borderFn));

				return {
					render(width: number): string[] {
						const lines: string[] = [];
						const statusColor = state.status === "running" ? "accent"
							: state.status === "done" ? "success" : "error";
						const statusIcon = state.status === "running" ? "●"
							: state.status === "done" ? "✓" : "✗";

						const taskPreview = state.task.length > 40
							? state.task.slice(0, 37) + "..."
							: state.task;

						const turnLabel = state.turnCount > 1
							? theme.fg("dim", ` · Turn ${state.turnCount}`)
							: "";

						lines.push(
							theme.fg(statusColor, `${statusIcon} Subagent #${state.id}`) +
							turnLabel +
							theme.fg("dim", `  ${taskPreview}`) +
							theme.fg("dim", `  (${Math.round(state.elapsed / 1000)}s)`) +
							theme.fg("dim", ` | Tools: ${state.toolCount}`)
						);

						const fullText = state.textChunks.join("");
						const lastLine = fullText.split("\n").filter((l: string) => l.trim()).pop() || "";
						if (lastLine) {
							const trimmed = lastLine.length > width - 10
								? lastLine.slice(0, width - 13) + "..."
								: lastLine;
							lines.push(theme.fg("muted", `  ${trimmed}`));
						}

						content.setText(lines.join("\n"));
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
				};
			});
		}
	}

	// ── Streaming helpers ─────────────────────────────────────────────────────

	function processLine(state: SubState, line: string) {
		if (!line.trim()) return;
		try {
			const event = JSON.parse(line);
			const type = event.type;

			if (type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") {
					state.textChunks.push(delta.delta || "");
					updateWidgets();
				}
			} else if (type === "tool_execution_start") {
				state.toolCount++;
				updateWidgets();
			}
		} catch {}
	}

	function spawnAgent(
		state: SubState,
		prompt: string,
		ctx: any,
		signal?: AbortSignal,
	): Promise<string> {
		// Default model: free qwen, or inherit from ctx, or fallback
		const model = state.model
			?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null)
			?? "openrouter/qwen/qwen3.6-plus-preview:free";

		// Build spawn args
		const spawnArgs = [
			"--mode", "json",
			"-p",
			"--session", state.sessionFile,
			"--no-extensions",
			"--model", model,
			"--tools", state.tools ?? "read,bash,grep,find,ls",
			"--thinking", state.thinking ?? "off",
			prompt,
		];

		return new Promise<string>((resolve) => {
			const proc = spawn("pi", spawnArgs, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			state.proc = proc;

			// Handle abort signal
			let aborted = false;
			if (signal) {
				const abortHandler = () => {
					aborted = true;
					proc.kill("SIGTERM");
				};
				signal.addEventListener("abort", abortHandler, { once: true });
			}

			const startTime = Date.now();
			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidgets();
			}, 1000);

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(state, line);
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				if (chunk.trim()) {
					state.textChunks.push(chunk);
					updateWidgets();
				}
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(state, buffer);
				clearInterval(timer);
				state.elapsed = Date.now() - startTime;
				state.status = aborted ? "error" : (code === 0 ? "done" : "error");
				state.proc = undefined;
				const result = state.textChunks.join("");
				state.result = result;  // cache for subagent_wait
				updateWidgets();

				if (!ctx.hasUI) {
					// Non-interactive mode - no notifications
				} else if (!waitingIds.has(state.id)) {
					ctx.ui.notify(
						`Subagent #${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
						state.status === "done" ? "success" : "error"
					);
				}

				// Only send follow-up message if not being waited on
				if (!waitingIds.has(state.id)) {
					pi.sendMessage({
						customType: "subagent-result",
						content: `Subagent #${state.id}${state.turnCount > 1 ? ` (Turn ${state.turnCount})` : ""} finished "${prompt}" in ${Math.round(state.elapsed / 1000)}s.\n\nResult:\n${result.slice(0, 8000)}${result.length > 8000 ? "\n\n... [truncated]" : ""}`,
						display: true,
					}, { deliverAs: "followUp", triggerTurn: true });
				}

				resolve(result);
				if (state.completionResolve) state.completionResolve();
			});

			proc.on("error", (err) => {
				clearInterval(timer);
				state.status = "error";
				state.proc = undefined;
				state.textChunks.push(`Error: ${err.message}`);
				state.result = state.textChunks.join("");
				updateWidgets();
				resolve(state.result);
				if (state.completionResolve) state.completionResolve();
			});
		});
	}

		// ── Tools for the Main Agent ──────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_create",
		label: "Create Subagent",
		description: "Spawn a background subagent to perform a task. Returns the subagent ID immediately while it runs in the background. Results will be delivered as a follow-up message when finished.",
		promptSnippet: "Spawn a background agent to perform an isolated task",
		promptGuidelines: [
			"Use subagent_create for tasks that benefit from an isolated context window.",
			"Subagents can use a different model via the 'model' parameter.",
			"Specify 'tools' to give subagents read-only access (read,grep,find,ls) or full access.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete task description for the subagent to perform" }),
			model: Type.Optional(Type.String({ 
				description: "Model to use (e.g., 'anthropic/claude-sonnet-4-5', 'openai/gpt-4o'). Default: inherits from current session or qwen/qwen3.6-plus-preview:free" 
			})),
			tools: Type.Optional(Type.String({ 
				description: "Comma-separated tools: read,bash,edit,write,grep,find,ls. Default: read,bash,grep,find,ls" 
			})),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
				description: "Thinking level. Default: off (fastest)"
			})),
		}),
		execute: async (callId, args, signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task: args.task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 1,
				model: args.model,
				tools: args.tools,
				thinking: args.thinking,
			};
			agents.set(id, state);
			updateWidgets();

			// Fire-and-forget with signal for abort support
			spawnAgent(state, args.task, ctx, signal);

			return {
				content: [{ type: "text", text: `Subagent #${id} spawned and running in background.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_continue",
		label: "Continue Subagent",
		description: "Continue an existing subagent's conversation. Use this to give further instructions to a finished subagent. Returns immediately while it runs in the background.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to continue" }),
			prompt: Type.String({ description: "The follow-up prompt or new instructions" }),
		}),
		execute: async (callId, args, signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				throw new Error(`No subagent #${args.id} found.`);
			}
			if (state.status === "running") {
				throw new Error(`Subagent #${args.id} is still running. Wait for it to finish first.`);
			}

			state.status = "running";
			state.task = args.prompt;
			state.textChunks = [];
			state.elapsed = 0;
			state.turnCount++;
			updateWidgets();

			ctx.ui.notify(`Continuing Subagent #${args.id} (Turn ${state.turnCount})…`, "info");
			spawnAgent(state, args.prompt, ctx, signal);

			return {
				content: [{ type: "text", text: `Subagent #${args.id} continuing conversation in background.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_remove",
		label: "Remove Subagent",
		description: "Remove a specific subagent. Kills it if it's currently running.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to remove" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				throw new Error(`No subagent #${args.id} found.`);
			}

			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
			}
			ctx.ui.setWidget(`sub-${args.id}`, undefined);
			agents.delete(args.id);
			waitingIds.delete(args.id);  // Clean up if being waited on

			return {
				content: [{ type: "text", text: `Subagent #${args.id} removed successfully.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "List Subagents",
		description: "List all active and finished subagents, showing their IDs, tasks, and status.",
		parameters: Type.Object({}),
		execute: async () => {
			if (agents.size === 0) {
				return { content: [{ type: "text", text: "No active subagents." }] };
			}

			const list = Array.from(agents.values()).map(s => 
				`#${s.id} [${s.status.toUpperCase()}] (Turn ${s.turnCount}) - ${s.task}`
			).join("\n");

			return {
				content: [{ type: "text", text: `Subagents:\n${list}` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for Subagents",
		description: `Wait for subagent(s) to complete. Blocks until all specified subagents finish, then returns their results.

Usage:
  subagent_wait({ ids: [1, 2, 3] })     — wait for specific subagents
  subagent_wait({})                     — wait for ALL spawned subagents
  subagent_wait({ ids: [1], timeout: 60 }) — wait with 60s timeout

Use this instead of polling subagent_list. Returns aggregated results when all complete. Waits forever if no timeout is specified.`,
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.Number()), { 
				description: "Subagent IDs to wait for. If omitted, waits for ALL spawned subagents." 
			}),
			timeout: Type.Optional(Type.Number(), { 
				description: "Max seconds to wait. If omitted, waits forever. Returns partial results on timeout." 
			}),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const targetIds = args.ids ?? Array.from(agents.keys());
			const timeoutMs = args.timeout !== undefined ? args.timeout * 1000 : undefined;

			if (targetIds.length === 0) {
				return { content: [{ type: "text", text: "No subagents to wait for." }] };
			}

			// Validate IDs
			const invalidIds = targetIds.filter(id => !agents.has(id));
			if (invalidIds.length > 0) {
				const validIds = Array.from(agents.keys());
				throw new Error(`Subagent(s) not found: ${invalidIds.join(", ")}. Available IDs: ${validIds.length > 0 ? validIds.join(", ") : "none"}`);
			}

			// Mark these IDs as being waited on — suppress their notifications
			for (const id of targetIds) {
				waitingIds.add(id);
			}

			const startTime = Date.now();
			const results: string[] = [];

			// Wait for each subagent with optional timeout
			for (const id of targetIds) {
				const state = agents.get(id)!;
				
				if (state.status !== "running") {
					// Already done - return cached result
					const statusIcon = state.status === "done" ? "✓" : "✗";
					results.push(`#${id} [${state.status.toUpperCase()}] (${Math.round(state.elapsed / 1000)}s, ${state.toolCount} tools) - "${state.task.slice(0, 50)}${state.task.length > 50 ? "..." : ""}"\n  Result: ${state.result?.slice(0, 500) ?? "(no result)"}${(state.result?.length ?? 0) > 500 ? "..." : ""}`);
					continue;
				}

				// Check remaining timeout if one was specified
				if (timeoutMs !== undefined) {
					const remainingTime = timeoutMs - (Date.now() - startTime);
					if (remainingTime <= 0) {
						results.push(`#${id} [TIMEOUT] - exceeded total wait time`);
						continue;
					}

					// Create a promise that resolves when this subagent completes
					const completionPromise = new Promise<void>((resolve) => {
						state.completionResolve = resolve;
					});

					const timedOut = await Promise.race([
						completionPromise.then(() => false),
						new Promise<boolean>(r => setTimeout(() => r(true), remainingTime))
					]);

					const statusIcon = state.status === "done" ? "✓" : state.status === "error" ? "✗" : "⏱";
					const statusLabel = timedOut ? "TIMEOUT" : state.status.toUpperCase();
					results.push(`#${id} [${statusLabel}] (${Math.round(state.elapsed / 1000)}s, ${state.toolCount} tools) - "${state.task.slice(0, 50)}${state.task.length > 50 ? "..." : ""}"\n  Result: ${state.result?.slice(0, 500) ?? "(no result)"}${(state.result?.length ?? 0) > 500 ? "..." : ""}`);
				} else {
					// No timeout - wait forever
					await new Promise<void>((resolve) => {
						state.completionResolve = resolve;
					});

					const statusIcon = state.status === "done" ? "✓" : "✗";
					results.push(`#${id} [${state.status.toUpperCase()}] (${Math.round(state.elapsed / 1000)}s, ${state.toolCount} tools) - "${state.task.slice(0, 50)}${state.task.length > 50 ? "..." : ""}"\n  Result: ${state.result?.slice(0, 500) ?? "(no result)"}${(state.result?.length ?? 0) > 500 ? "..." : ""}`);
				}
			}

			// Clear waited IDs
			for (const id of targetIds) {
				waitingIds.delete(id);
			}

			const totalWait = Math.round((Date.now() - startTime) / 1000);
			const summary = `Waited for ${targetIds.length} subagent${targetIds.length !== 1 ? "s" : ""} (${totalWait}s total):\n\n${results.join("\n\n")}`;

			return {
				content: [{ type: "text", text: summary }],
			};
		},
	});



	// ── /sub <task> ───────────────────────────────────────────────────────────

	pi.registerCommand("sub", {
		description: `Spawn a subagent with live widget.

Usage:
  /sub [options] <task>

Options:
  --model <model>      Model to use (e.g., anthropic/claude-sonnet-4-5)
  --tools <list>       Comma-separated tools (default: read,bash,grep,find,ls)
  --thinking <level>   Thinking level: off, minimal, low, medium, high, xhigh

Examples:
  /sub analyze the auth module and list security issues
  /sub --model openai/gpt-4o review this code
  /sub --tools read,grep,find,ls search for TODO comments
  /sub --thinking high solve this complex problem

The subagent runs in the background with a live status widget.
Use /subwait to block until done, or check status with /sublist.`,
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			if (!args?.trim()) {
				ctx.ui.notify("Usage: /sub [--model <model>] [--tools <list>] [--thinking <level>] <task>", "error");
				return;
			}

			// Parse options
			let task = args.trim();
			let model: string | undefined;
			let tools: string | undefined;
			let thinking: string | undefined;

			const parseOption = (flag: string): string | null => {
				const regex = new RegExp(`--${flag}\\s+(\\S+)`);
				const match = task.match(regex);
				if (match) {
					task = task.replace(regex, "").trim();
					return match[1];
				}
				return null;
			};

			model = parseOption("model") ?? undefined;
			tools = parseOption("tools") ?? undefined;
			thinking = parseOption("thinking") ?? undefined;

			if (!task) {
				ctx.ui.notify("Usage: /sub [--model <model>] [--tools <list>] [--thinking <level>] <task>", "error");
				return;
			}

			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 1,
				model,
				tools,
				thinking,
			};
			agents.set(id, state);
			updateWidgets();

			// Fire-and-forget
			spawnAgent(state, task, ctx);
		},
	});

	// ── /subcont <number> <prompt> ────────────────────────────────────────────

	pi.registerCommand("subcont", {
		description: `Continue an existing subagent's conversation.

Usage:
  /subcont <number> <prompt>   — continue subagent #<number> with new instructions

Examples:
  /subcont 1 now write tests for the issues you found
  /subcont 2 expand the analysis to include edge cases
  /subcont 3 summarize your findings in a markdown table

The subagent maintains its conversation history from previous turns.
Turn count is displayed in the widget.`,
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const trimmed = args?.trim() ?? "";
			const spaceIdx = trimmed.indexOf(" ");
			if (spaceIdx === -1) {
				ctx.ui.notify("Usage: /subcont <number> <prompt>", "error");
				return;
			}

			const num = parseInt(trimmed.slice(0, spaceIdx), 10);
			const prompt = trimmed.slice(spaceIdx + 1).trim();

			if (isNaN(num) || !prompt) {
				ctx.ui.notify("Usage: /subcont <number> <prompt>", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No subagent #${num} found. Use /sub to create one.`, "error");
				return;
			}

			if (state.status === "running") {
				ctx.ui.notify(`Subagent #${num} is still running — wait for it to finish first.`, "warning");
				return;
			}

			// Resume: update state for a new turn
			state.status = "running";
			state.task = prompt;
			state.textChunks = [];
			state.elapsed = 0;
			state.turnCount++;
			updateWidgets();

			ctx.ui.notify(`Continuing Subagent #${num} (Turn ${state.turnCount})…`, "info");

			// Fire-and-forget — reuses the same sessionFile for conversation history
			spawnAgent(state, prompt, ctx);
		},
	});

	// ── /subrm <number> ───────────────────────────────────────────────────────

	pi.registerCommand("subrm", {
		description: `Remove a specific subagent widget.

Usage:
  /subrm <number>   — remove subagent #<number>

If the subagent is still running, it will be killed first.
The widget is removed and the subagent ID is freed.`,
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const num = parseInt(args?.trim() ?? "", 10);
			if (isNaN(num)) {
				ctx.ui.notify("Usage: /subrm <number>", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No subagent #${num} found.`, "error");
				return;
			}

			// Kill the process if still running
			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
				ctx.ui.notify(`Subagent #${num} killed and removed.`, "warning");
			} else {
				ctx.ui.notify(`Subagent #${num} removed.`, "info");
			}

			ctx.ui.setWidget(`sub-${num}`, undefined);
			agents.delete(num);
			waitingIds.delete(num);  // Clean up if being waited on
		},
	});

	// ── /subclear ─────────────────────────────────────────────────────────────

	pi.registerCommand("subclear", {
		description: `Clear all subagent widgets.

Usage:
  /subclear   — remove all subagents

Kills any running subagents and clears all widgets.
Resets the subagent ID counter.`,
		handler: async (_args, ctx) => {
			widgetCtx = ctx;

			let killed = 0;
			for (const [id, state] of Array.from(agents.entries())) {
				if (state.proc && state.status === "running") {
					state.proc.kill("SIGTERM");
					killed++;
				}
				ctx.ui.setWidget(`sub-${id}`, undefined);
			}

			const total = agents.size;
			agents.clear();
			waitingIds.clear();
			nextId = 1;

			const msg = total === 0
				? "No subagents to clear."
				: `Cleared ${total} subagent${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
			ctx.ui.notify(msg, total === 0 ? "info" : "success");
		},
	});

	// ── /subwait ──────────────────────────────────────────────────────────────

	pi.registerCommand("subwait", {
		description: `Wait for subagent(s) to complete.

Usage:
  /subwait          — wait for ALL subagents
  /subwait 1        — wait for subagent #1
  /subwait 1 2 3    — wait for multiple subagents

Blocks until the specified subagents finish, then shows a summary.
Interrupt with Ctrl+C if you get tired of waiting.`,
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const trimmed = args?.trim() ?? "";

			// Parse arguments: space-separated IDs
			const ids = trimmed.split(/\s+/)
				.map(s => parseInt(s, 10))
				.filter(n => !isNaN(n));

			// Default: wait for all
			const targetIds = ids.length > 0 ? ids : Array.from(agents.keys());

			if (targetIds.length === 0) {
				ctx.ui.notify("No subagents to wait for.", "info");
				return;
			}

			// Mark these IDs as being waited on — suppress their notifications
			for (const id of targetIds) {
				waitingIds.add(id);
			}

			ctx.ui.notify(`Waiting for ${targetIds.length} subagent${targetIds.length !== 1 ? "s" : ""}…`, "info");

			const startTime = Date.now();

			for (const id of targetIds) {
				const state = agents.get(id);
				if (!state) continue;
				if (state.status !== "running") continue;

				await new Promise<void>((resolve) => {
					state.completionResolve = resolve;
				});
			}

			// Clear waited IDs
			for (const id of targetIds) {
				waitingIds.delete(id);
			}

			// Show summary
			const results: string[] = [];
			for (const id of targetIds) {
				const state = agents.get(id);
				if (!state) continue;
				const statusIcon = state.status === "done" ? "✓" : state.status === "error" ? "✗" : "⏱";
				results.push(`${statusIcon} #${id} [${state.status.toUpperCase()}] (${Math.round(state.elapsed / 1000)}s) - ${state.task.slice(0, 40)}${state.task.length > 40 ? "..." : ""}`);
			}

			const totalWait = Math.round((Date.now() - startTime) / 1000);
			ctx.ui.notify(`Wait complete (${totalWait}s):\n${results.join("\n")}`, "success");
		},
	});

	// ── /sub list ─────────────────────────────────────────────────────────────

	pi.registerCommand("sublist", {
		description: `List all subagents with their status.

Usage:
  /sublist   — show all subagents

Shows ID, status, turn count, and task for each subagent.`,
		handler: async (_args, ctx) => {
			if (agents.size === 0) {
				ctx.ui.notify("No subagents.", "info");
				return;
			}

			const lines = Array.from(agents.values()).map(s => {
				const statusIcon = s.status === "running" ? "●" : s.status === "done" ? "✓" : "✗";
				return `${statusIcon} #${s.id} [${s.status.toUpperCase()}] (Turn ${s.turnCount}) - ${s.task.slice(0, 50)}${s.task.length > 50 ? "..." : ""}`;
			});

			ctx.ui.notify(`Subagents:\n${lines.join("\n")}`, "info");
		},
	});

	// ── Session lifecycle ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
			}
			ctx.ui.setWidget(`sub-${id}`, undefined);
		}
		agents.clear();
		waitingIds.clear();
		nextId = 1;
		widgetCtx = ctx;
	});
}
