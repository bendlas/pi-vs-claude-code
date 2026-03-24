# Plan: Subagent Session Resume/Enter

## Goal

Allow resuming or "entering" a subagent's session to interact with it as a regular pi session, enabling multi-turn interactive work with a subagent's context.

## Current State

- `/subcont <id> <prompt>` continues a subagent with a single prompt
- Each `/subcont` is fire-and-forget — you can't have a back-and-forth
- Subagent session files are stored in `~/.pi/agent/sessions/subagents/`
- No way to interactively explore a subagent's session

## Use Cases

1. **Deep dive**: Subagent found something interesting — user wants to explore interactively
2. **Debug**: Subagent failed — user wants to investigate what went wrong
3. **Manual takeover**: Subagent is stuck — user wants to guide it manually
4. **Archive access**: Resume an old subagent session that was cleared from the widget

## Implementation Options

### Option A: `/subenter <id>` — In-Place Session Switch

Switch the main pi session to the subagent's session file temporarily.

```typescript
pi.registerCommand("subenter", {
  description: `Enter a subagent's session interactively.

Usage:
  /subenter <id>   — switch to subagent #<id>'s session

The main session is saved and you enter the subagent's session.
Use /exit or /back to return to the main session.`,
  handler: async (args, ctx) => {
    const id = parseInt(args?.trim() ?? "", 10);
    const state = agents.get(id);
    if (!state) {
      ctx.ui.notify(`No subagent #${id} found.`, "error");
      return;
    }
    
    // Save current session context
    const savedSession = ctx.sessionFile;
    
    // Switch to subagent's session
    await ctx.switchSession(state.sessionFile);
    
    // The user is now in the subagent's session
    // ... need a way to get back
  },
});
```

**Problem**: pi doesn't have a built-in "return to previous session" concept. Would need to track the "parent" session and add a `/subexit` command.

### Option B: Spawn Interactive pi in Subagent Session

Open a new interactive pi process attached to the subagent's session.

```typescript
pi.registerCommand("subenter", {
  handler: async (args, ctx) => {
    const id = parseInt(args?.trim() ?? "", 10);
    const state = agents.get(id);
    if (!state) {
      ctx.ui.notify(`No subagent #${id} found.`, "error");
      return;
    }
    
    // Spawn interactive pi with the subagent's session
    const proc = spawn("pi", [
      "--session", state.sessionFile,
      "--model", state.model,
    ], {
      stdio: "inherit",
    });
  },
});
```

This suspends the parent pi while the child runs. The TUI hands over control. Works but feels jarring.

**Workaround**: Use a terminal multiplexer or split pane approach.

### Option C: Active Subagent Context

Add a mode where the main prompt input targets an "active subagent" instead of the main session.

```typescript
let activeSubagent: number | null = null;

pi.registerCommand("subresume", {
  description: `Resume a subagent for interactive continuation.

Usage:
  /subresume <id>   — make subagent #<id> the active context
  /subresume        — show current active subagent
  /subresume off    — deactivate subagent mode

When a subagent is active, your inputs continue its conversation.`,
  handler: async (args, ctx) => {
    const trimmed = args?.trim() ?? "";
    
    if (trimmed === "off" || trimmed === "stop") {
      activeSubagent = null;
      ctx.ui.notify("Exited subagent mode.", "info");
      return;
    }
    
    if (!trimmed) {
      if (activeSubagent) {
        ctx.ui.notify(`Active subagent: #${activeSubagent}`, "info");
      }
      return;
    }
    
    const id = parseInt(trimmed, 10);
    const state = agents.get(id);
    if (!state) {
      ctx.ui.notify(`No subagent #${id} found.`, "error");
      return;
    }
    
    activeSubagent = id;
    ctx.ui.notify(`Subagent #${id} is now active. Your inputs will continue its conversation.`, "info");
  },
});
```

**Hook into message sending**:
Need to intercept when the user sends a message and route it to the active subagent instead of the main session.

**Problem**: This requires deep integration with pi's message handling. Extensions don't currently have a "pre-send" hook.

### Option D: Dedicated Session Browser

Add a `/subsessions` command that lists all subagent session files with the ability to open them.

```typescript
pi.registerCommand("subsessions", {
  description: `List and manage subagent session files.

Usage:
  /subsessions           — list all subagent sessions
  /subsessions open <id> — open subagent session in a new pi instance
  /subsessions path <id> — show the session file path`,
  handler: async (args, ctx) => {
    const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    
    // List sessions with metadata
    const sessions = files.map(f => {
      const filePath = path.join(dir, f);
      const stats = fs.statSync(filePath);
      return { file: f, path: filePath, modified: stats.mtime };
    });
    
    // Show list
    ctx.ui.notify(
      sessions.map(s => `${s.file} (${s.modified.toLocaleString()})`).join("\n"),
      "info"
    );
  },
});
```

Then users can manually `pi --session <path>` to resume.

### Option E: Subagent Session as Command Context

Use pi's existing session forking/navigation to provide a clean UX:

```typescript
pi.registerCommand("subenter", {
  description: `Enter a subagent's session in the current TUI.

Usage:
  /subenter <id>   — switch context to subagent #<id>

Your current session is forked/branched. The subagent session becomes
your working context. Use /subexit to return.`,
  handler: async (args, ctx) => {
    const id = parseInt(args?.trim() ?? "", 10);
    const state = agents.get(id);
    if (!state) {
      ctx.ui.notify(`No subagent #${id} found.`, "error");
      return;
    }
    
    // Store the "return to" session
    const returnSession = ctx.sessionFile;
    
    // Switch to subagent session
    await ctx.switchSession(state.sessionFile);
    
    // Store return path somewhere (maybe in session metadata?)
    ctx.setSessionName(`[Subagent #${id}] ${state.task.slice(0, 30)}`);
    
    // Notify user
    ctx.ui.notify(`Entered subagent #${id} session. Use /subexit to return.`, "info");
  },
});

pi.registerCommand("subexit", {
  description: `Exit subagent mode and return to main session.`,
  handler: async (_args, ctx) => {
    // Need to track the "return to" path
    // Could store in a global, session metadata, or environment variable
    const returnPath = getReturnPath(); // Implementation needed
    
    if (returnPath) {
      await ctx.switchSession(returnPath);
      ctx.ui.notify("Returned to main session.", "info");
    } else {
      ctx.ui.notify("No return session stored.", "warning");
    }
  },
});
```

**Challenge**: Where to store the "return to" path?
- Global variable in extension: Lost on session switch
- Session metadata: pi doesn't expose a generic metadata API
- Environment variable: Could work but hacky

## Recommended Approach

**Short-term (MVP)**: Option D — `/subsessions` for discovery + manual `pi --session`

```typescript
// Simple listing with copyable paths
pi.registerCommand("subsessions", {
  handler: async (_args, ctx) => {
    const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
    if (!fs.existsSync(dir)) {
      ctx.ui.notify("No subagent sessions found.", "info");
      return;
    }
    
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(".jsonl"))
      .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    
    const lines = files.map(f => {
      const stats = fs.statSync(path.join(dir, f));
      return `${f} (${Math.round(stats.size / 1024)}KB, ${stats.mtime.toLocaleString()})`;
    });
    
    ctx.ui.notify(`Subagent sessions in ${dir}:\n\n${lines.join("\n")}\n\nResume with: pi --session <path>`, "info");
  },
});
```

**Medium-term**: Option A/E with explicit return tracking

- Store return path in a temp file: `~/.pi/agent/sessions/subagents/.return-to`
- On `/subexit`, read and delete that file
- Clean session switch with proper return UX

**Long-term**: Native pi support for nested sessions or session stacks

- Could be a pi core feature, not just an extension
- Session stack: push/pop sessions
- Visual indicator of nested session depth

## Implementation Details

### MVP: `/subsessions` command

1. List files in subagent session directory
2. Show file name, size, modification time
3. Provide copyable path for manual `pi --session`

### Enhanced: `/subenter` + `/subexit`

1. Store return path in temp file or environment
2. Switch to subagent session
3. Provide `/subexit` to switch back
4. Handle edge cases (subagent session deleted, parent session moved)

## Testing

1. Create subagent, verify session file exists
2. Run `/subsessions`, verify listing
3. Manually resume with `pi --session <path>`
4. (If implementing `/subenter`) Test switch and return
5. Test with cleared subagents (session files should still be resumable)

## Complexity

- **Low**: `/subsessions` listing command
- **Medium**: `/subenter`/`/subexit` with return tracking
- **High**: Native nested session support in pi core

## Files to Modify

- `subagent-widget.ts`:
  - Add `/subsessions` command
  - (Optional) Add `/subenter` and `/subexit` commands
  - Track return path for session switching

## Open Questions

1. Should we prune old subagent session files automatically?
2. Should `/subclear` delete session files or just clear the widget?
3. Can we add metadata to session files (e.g., subagent ID, task preview)?
