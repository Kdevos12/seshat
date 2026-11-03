import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Providers that think in a tool-call loop refuse a request (an HTTP 400) in which an assistant message that called
 * tools comes back without the reasoning it was answered with (documentation/lines.md, "The reasoning of a
 * tool-call loop"). Code that rewrites or compiles a session's history (the context packet, a line's rewrite) may
 * keep such a message and drop its thinking. `keepReasoning` puts it back: for each assistant message of `rebuilt`
 * that has tool calls and no thinking, it takes the thinking blocks of the message of `original` that made the
 * same tool calls (matched by tool-call id, else by timestamp). A message that matches nothing is left as it is,
 * since the harness cannot invent a reasoning. Messages the rewrite dropped altogether are not brought back: a
 * history without the loop has nothing to send the reasoning of.
 */
export function keepReasoning(original: readonly AgentMessage[], rebuilt: AgentMessage[]): AgentMessage[] {
  const loops = original.filter(isToolLoopMessage);
  if (loops.length === 0) return rebuilt;
  return rebuilt.map((message) => {
    if (!isToolLoopMessage(message) || thinkingOf(message).length > 0) return message;
    const ids = new Set(toolCallIds(message));
    const source = loops.find((candidate) => toolCallIds(candidate).some((id) => ids.has(id))) ?? loops.find((candidate) => candidate.timestamp === message.timestamp);
    const thinking = source === undefined ? [] : thinkingOf(source);
    return thinking.length === 0 ? message : { ...message, content: [...thinking, ...message.content] };
  });
}

function isToolLoopMessage(message: AgentMessage): message is AssistantMessage {
  return "role" in message && message.role === "assistant" && message.content.some((block) => block.type === "toolCall");
}

function thinkingOf(message: AssistantMessage): AssistantMessage["content"] {
  return message.content.filter((block) => block.type === "thinking" && block.thinking.trim() !== "");
}

function toolCallIds(message: AssistantMessage): string[] {
  return message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
}
