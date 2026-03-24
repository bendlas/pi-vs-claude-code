# Plan: Subagent Cost Aggregation

## Goal

Add subagent costs (tokens + $) to the parent session's cost tracking, so users can see the true total cost of their session including all spawned subagents.

## Current State

- Subagents are spawned via `spawn("pi", [...])` with `--mode json`
- The extension processes `message_update` events to capture streaming text
- Subagent completion is tracked via `proc.on("close")`
- **No cost/usage data is captured** - only text chunks and tool counts
- Parent session has no awareness of subagent costs

## Implementation

### 1. Capture Cost Data from Subagent

**Option A: Parse `--mode json` cost events**

The `--mode json` mode emits events including usage data. Check if `turn_end` or `message_end` events include usage:

```typescript
interface AssistantMessage {
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
}
```

**Action**: Extend `processLine()` to capture usage from `message_end` events:

```typescript
interface SubState {
  // ... existing fields
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
}

function processLine(state: SubState, line: string) {
  // ... existing text_delta handling
  
  if (type === "message_end") {
    const usage = event.message?.usage;
    if (usage) {
      state.totalInputTokens += usage.input ?? 0;
      state.totalOutputTokens += usage.output ?? 0;
      state.totalCacheRead += usage.cacheRead ?? 0;
      state.totalCacheWrite += usage.cacheWrite ?? 0;
      state.totalCost += usage.cost?.total ?? 0;
    }
  }
}
```

**Option B: Use RPC mode with `get_session_stats`**

Switch to `--mode rpc` and query `get_session_stats` at completion for aggregate data.

```typescript
// At spawn, use RPC mode
const proc = spawn("pi", ["--mode", "rpc", "--session", state.sessionFile, ...]);

// At completion, query stats
proc.stdin.write(JSON.stringify({ type: "get_session_stats" }) + "\n");
```

This gives the full session stats but requires RPC protocol handling.

**Recommendation**: Option A is simpler and integrates with existing JSON mode.

### 2. Expose Cost Data to Parent Session

**Add a tracking structure**:

```typescript
interface SessionCosts {
  subagentInputTokens: number;
  subagentOutputTokens: number;
  subagentCacheRead: number;
  subagentCacheWrite: number;
  subagentCost: number;
}

// Global or context-attached
let sessionCosts: SessionCosts = { ... };
```

**Aggregate on subagent completion**:

```typescript
proc.on("close", (code) => {
  // ... existing completion logic
  
  // Add to session totals
  sessionCosts.subagentInputTokens += state.totalInputTokens;
  sessionCosts.subagentOutputTokens += state.totalOutputTokens;
  sessionCosts.subagentCacheRead += state.totalCacheRead;
  sessionCosts.subagentCacheWrite += state.totalCacheWrite;
  sessionCosts.subagentCost += state.totalCost;
});
```

### 3. Display Costs in Widgets and Reports

**Widget enhancement**:

```typescript
lines.push(
  theme.fg("dim", ` | Cost: $${state.totalCost.toFixed(4)}`)
);
```

**`subagent_wait` result enhancement**:

```
#1 [DONE] (45s, 12 tools) - "analyze auth module..."
  Result: ...
  Tokens: 15K in, 2K out | Cost: $0.0523
```

**New command: `/subcosts`**:

Display aggregate costs for all subagents:

```
Subagent Session Costs:
  Input tokens:   125,000
  Output tokens:  23,000
  Cache read:     80,000
  Cache write:    12,000
  Total cost:     $0.4567
```

### 4. Integration with Pi's Native Cost Tracking

**Investigation needed**: Can extensions contribute to pi's native cost display?

- Check if `ExtensionAPI` exposes cost tracking hooks
- Check if `ctx.ui.setStatus()` can update cost display
- May need to emit a custom event that pi's TUI can pick up

**Fallback**: Display costs only in widget and `/subcosts` command.

## Testing

1. Spawn subagent, verify cost accumulation in state
2. Check `/subwait` shows per-subagent costs
3. Check `/subcosts` shows aggregate
4. Verify widget displays live cost during execution

## Complexity

- **Low**: Just parse existing events and aggregate numbers
- **Medium**: Integrate with pi's native cost display (if possible)

## Files to Modify

- `subagent-widget.ts`:
  - Extend `SubState` interface
  - Update `processLine()` for cost capture
  - Add session-level aggregation
  - Update widgets and wait results
  - Add `/subcosts` command
