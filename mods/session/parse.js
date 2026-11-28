// Reading a pi session file: its records become the rows the panel draws.
//
// A pi session is an append-only JSONL file. Each line is one record: `session` (its folder and
// time), `message` (a person's words, Pi's words, its thinking, its tool calls, and each tool's
// result), and bookkeeping such as `model_change` or `custom`. Nothing here talks to Herdr, so it
// can be run on its own against a real session.

/** The folder pi writes a session in, from the folder the session runs in
 *  (`--Users-john-dev--`). Same encoding as pi's session-manager. */
export function encodeDir(cwd) {
  const path = String(cwd ?? "").replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${path}--`;
}

/** "2026-11-25T12-58-34-884Z_…jsonl" as "12:58", or "" when the name is not a timestamp. */
export function timeFromName(name) {
  const match = /^\d{4}-\d\d-\d\dT(\d\d)-(\d\d)/.exec(String(name ?? ""));
  return match ? `${match[1]}:${match[2]}` : "";
}

/** The words of a message's content, without images ("[image]" stands in). */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

/** A tool's arguments as one short line: `path=… limit=2000`. Values are cut, never stringified whole. */
export function argSummary(args, limit = 100) {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return cut(String(args), limit);
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    let shown;
    if (typeof value === "string") shown = value.replace(/\s+/g, " ");
    else if (value === null) shown = "null";
    else if (typeof value === "object") shown = JSON.stringify(value) ?? "…";
    else shown = String(value);
    parts.push(`${key}=${cut(shown, 40)}`);
    if (parts.join("  ").length >= limit) break;
  }
  return cut(parts.join("  "), limit);
}

function cut(text, limit) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** The first words of a piece of text, as a title: one line, cut at `limit`. */
export function firstWords(text, limit = 90) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * A session's records as rows, in order:
 *
 * - `{ kind: "user", text }` — something a person said.
 * - `{ kind: "say", text, model }` — something Pi said, its discussion.
 * - `{ kind: "work", key, steps }` — the thinking and tool calls between two of those, folded:
 *   `steps` are `{ type: "thought", text }` and `{ type: "call", id, name, args, result, isError }`
 *   in the order they happened. A call's result arrives in a later record and is filled in place.
 *
 * `messages` is what `ingest` collected: `{ id, at, message }` in file order.
 */
export function buildRows(messages) {
  const rows = [];
  const calls = new Map();
  let work = null;

  const open = () => {
    if (!work) work = { kind: "work", key: null, steps: [] };
    return work;
  };
  const flush = () => {
    if (work && work.steps.length > 0) rows.push(work);
    work = null;
  };

  for (const record of messages) {
    const message = record.message;
    if (!message) continue;
    const content = message.content;

    if (message.role === "user") {
      flush();
      const text = textOf(content).trim();
      if (text) rows.push({ kind: "user", key: record.id, text, at: record.at });
    } else if (message.role === "assistant") {
      const blocks = Array.isArray(content) ? content : [];
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (!block || typeof block !== "object") continue;
        const key = `${record.id}:${index}`;
        if (block.type === "thinking") {
          const group = open();
          group.key ??= key;
          if (String(block.thinking ?? "").trim()) {
            group.steps.push({ type: "thought", key, text: block.thinking });
          }
        } else if (block.type === "text") {
          const text = String(block.text ?? "").trim();
          if (text) {
            flush();
            rows.push({ kind: "say", key, text, at: record.at, model: message.model });
          }
        } else if (block.type === "toolCall") {
          const group = open();
          group.key ??= key;
          const step = {
            type: "call",
            key,
            id: block.id,
            name: block.name ?? "tool",
            args: block.arguments,
            result: null,
            isError: false,
          };
          group.steps.push(step);
          if (block.id) calls.set(block.id, step);
        }
      }
    } else if (message.role === "toolResult") {
      const step = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      if (step) {
        step.result = textOf(content);
        step.isError = message.isError === true;
      }
    }
  }
  flush();
  return rows;
}

/** What a folded row says it holds, for the filters in force: "3 tool calls · Thought". */
export function summarize(steps, filters) {
  const calls = steps.filter((step) => step.type === "call").length;
  const thoughts = steps.filter((step) => step.type === "thought").length;
  const failed = steps.filter((step) => step.type === "call" && step.isError).length;
  const parts = [];
  if (filters.calls && calls > 0) parts.push(`${calls} tool call${calls === 1 ? "" : "s"}`);
  if (filters.thinking && thoughts > 0) parts.push(thoughts === 1 ? "Thought" : `${thoughts} thoughts`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/** The steps a folded row keeps under the filters in force. */
export function visibleSteps(steps, filters) {
  return steps.filter(
    (step) => (step.type === "call" ? filters.calls : filters.thinking),
  );
}
