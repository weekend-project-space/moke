import type { AgentEvent } from '@moke/protocol';
import type { RuntimeRun } from '@moke/agent-runtime';
import { MessagingConnectionManager } from './connection-manager.js';

export class MessagingDeliveryService {
  private readonly finalText = new Map<string, string>();
  private readonly delivered = new Set<string>();
  private readonly terminalDeliveries = new Map<string, Promise<void>>();

  constructor(private readonly connections: MessagingConnectionManager) {}

  onRunEvent(event: AgentEvent, run: RuntimeRun) {
    if (run.origin.kind !== 'messaging') return;
    const target = run.origin;
    if (event.type === 'agent.message.done') {
      const message = event.payload.message;
      if (isFinalAssistantMessage(message)) this.finalText.set(run.id, message.content);
      return;
    }
    if (event.type === 'ask_user.required') {
      void this.connections.stopTypingForRun(run.id);
      void this.deliver(run.id, target.connection_id, target.binding_id, '任务需要补充信息，请在 Moke 应用内回答后继续。');
      return;
    }
    if (event.type === 'approval.required') {
      void this.connections.stopTypingForRun(run.id);
      void this.deliver(run.id, target.connection_id, target.binding_id, '此任务需要在 Moke 应用内确认，确认后会继续执行。');
      return;
    }
    if (event.type === 'ask_user.answered' || event.type === 'approval.resolved') {
      this.connections.startTypingForBinding(target.connection_id, target.binding_id, run.id);
      return;
    }
    if (event.type === 'agent.done') {
      void this.connections.stopTypingForRun(run.id);
      if (event.payload.status !== 'completed') {
        this.finalText.delete(run.id);
        if (run.cancel_reason === 'shutdown') return;
        this.trackTerminalDelivery(run.id, this.deliver(run.id, target.connection_id, target.binding_id, '任务已取消。'));
        return;
      }
      const text = this.finalText.get(run.id) || '任务已完成，但没有可展示的文本结果。';
      this.finalText.delete(run.id);
      if (run.outbound_tool_texts?.includes(text)) return;
      this.trackTerminalDelivery(run.id, this.deliver(run.id, target.connection_id, target.binding_id, text));
      return;
    }
    if (event.type === 'agent.error') {
      void this.connections.stopTypingForRun(run.id);
      this.finalText.delete(run.id);
      this.trackTerminalDelivery(run.id, this.deliver(run.id, target.connection_id, target.binding_id, `任务执行失败：${event.payload.message}`));
    }
  }

  async waitForTerminal(runId: string) {
    await this.terminalDeliveries.get(runId);
  }

  private trackTerminalDelivery(runId: string, delivery: Promise<void>) {
    const tracked = delivery.finally(() => this.terminalDeliveries.delete(runId));
    this.terminalDeliveries.set(runId, tracked);
  }

  private async deliver(runId: string, connectionId: string, bindingId: string, text: string) {
    const key = `${runId}:${text}`;
    if (this.delivered.has(key)) return;
    this.delivered.add(key);
    try {
      await this.connections.sendTextForBinding(connectionId, bindingId, text);
      console.info(`[messaging] delivered run=${runId} binding=${bindingId}`);
    } catch (error) {
      this.delivered.delete(key);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[messaging] delivery failed run=${runId} binding=${bindingId}: ${message}`);
    }
  }
}

function isFinalAssistantMessage(message: unknown): message is { role: 'assistant'; content: string; tool_calls?: unknown[] } {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { role?: unknown; content?: unknown; tool_calls?: unknown };
  return candidate.role === 'assistant'
    && typeof candidate.content === 'string'
    && (!Array.isArray(candidate.tool_calls) || candidate.tool_calls.length === 0);
}
