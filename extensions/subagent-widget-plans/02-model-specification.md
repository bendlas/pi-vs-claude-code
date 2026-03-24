# Plan: Subagent Model Specification

## Goal

Allow specifying the model for a subagent at spawn time, and changing it when continuing a conversation.

## Current State

Model selection is hardcoded:

```typescript
const model = ctx.model
  ? `${ctx.model.provider}/${ctx.model.id}`
  : "openrouter/google/gemini-3-flash-preview";
```

- **No parameter** in `subagent_create` or `subagent_continue` to specify model
- Falls back to `gemini-3-flash-preview` if no parent model
- Cannot use different models for different subagent tasks

## Implementation

### 1. Extend Tool Parameters

**`subagent_create`**:

```typescript
pi.registerTool({
  name: "subagent_create",
  parameters: Type.Object({
    task: Type.String({ description: "The complete task description for the subagent to perform" }),
    model: Type.Optional(Type.String({ 
      description: "Model to use (e.g., 'anthropic/claude-sonnet-4-20250514' or 'openai/gpt-4o'). Defaults to parent session model or gemini-3-flash-preview." 
    })),
  }),
  // ...
});
```

**`subagent_continue`**:

```typescript
pi.registerTool({
  name: "subagent_continue",
  parameters: Type.Object({
    id: Type.Number({ description: "The ID of the subagent to continue" }),
    prompt: Type.String({ description: "The follow-up prompt or new instructions" }),
    model: Type.Optional(Type.String({ 
      description: "Model to use for this continuation. Defaults to the model used in the previous turn." 
    })),
  }),
  // ...
});
```

### 2. Track Model in SubState

```typescript
interface SubState {
  // ... existing fields
  model: string;  // Current model for this subagent
}
```

### 3. Update spawnAgent Function

```typescript
function spawnAgent(
  state: SubState,
  prompt: string,
  ctx: any,
  requestedModel?: string,  // Optional override
): Promise<string> {
  // Priority: explicit parameter > subagent's stored model > parent model > default
  const model = requestedModel 
    ?? state.model 
    ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined)
    ?? "openrouter/google/gemini-3-flash-preview";
  
  // Store for future continuations
  state.model = model;
  
  // ... existing spawn logic with `--model ${model}`
}
```

### 4. Update Commands

**`/sub` command**:

```
/sub <task>                           — spawn with default model
/sub --model anthropic/claude-opus-4-5 <task>  — spawn with specific model
/sub -m openai/gpt-4o <task>          — short form
```

Parsing:

```typescript
// Parse flags
let model: string | undefined;
let task = args;
const modelMatch = args.match(/(?:--model|-m)\s+(\S+)\s*/);
if (modelMatch) {
  model = modelMatch[1];
  task = args.replace(modelMatch[0], "").trim();
}
```

**`/subcont` command**:

```
/subcont <id> <prompt>                — continue with same model
/subcont --model <model> <id> <prompt>  — switch model for this turn
```

### 5. Display Model in Widgets

```typescript
lines.push(
  theme.fg(statusColor, `${statusIcon} Subagent #${state.id}`) +
  theme.fg("dim", ` [${state.model}]`) +  // Show model
  theme.fg("dim", `  ${taskPreview}`)
);
```

### 6. Update `/sublist` Output

```
● #1 [RUNNING] [anthropic/claude-sonnet-4] (Turn 2) - analyze auth module...
✓ #2 [DONE] [openai/gpt-4o] (Turn 1) - write tests for parser.ts
```

## Validation

**Check model availability**:

```typescript
async function validateModel(modelStr: string, modelRegistry: ModelRegistry): Promise<string | null> {
  const [provider, id] = modelStr.split("/");
  const model = modelRegistry.find(provider, id);
  if (!model) {
    return `Model not found: ${modelStr}`;
  }
  // Could also check if API key is configured
  return null;
}
```

Report invalid models before spawning.

## Edge Cases

1. **Model switch mid-conversation**: Session maintains history but model changes. This is valid - the new model sees the same context.

2. **Thinking level**: Should thinking level be specifiable too?
   - Add `thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` parameter
   - Pass to `--thinking` flag

3. **Model format flexibility**: Accept various formats:
   - `provider/model-id`
   - `provider/model-id:thinking` (with thinking level)
   - Just `model-id` (infer provider from registry)

## Testing

1. Spawn subagent with specific model, verify in widget
2. Continue subagent with different model, verify switch
3. List subagents, verify model shown
4. Test invalid model handling

## Complexity

- **Low-Medium**: Parameter parsing and state tracking are straightforward
- Need to handle model validation gracefully

## Files to Modify

- `subagent-widget.ts`:
  - Extend `SubState` with `model` field
  - Add model parameter to tool definitions
  - Update `spawnAgent()` signature
  - Add flag parsing to `/sub` and `/subcont` commands
  - Update widget display
  - Update `/sublist` output
