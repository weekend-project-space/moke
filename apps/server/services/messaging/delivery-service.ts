import type { RuntimeRun } from '@moke/agent-runtime';
import type { AgentEvent, PendingApproval, PendingAsk } from '@moke/protocol';
import {
  MessagingConnectionManager,
  type InteractionCardHandle,
  type InteractionPresentation,
  type RunCardHandle,
  type RunPresentation,
} from './connection-manager.js';

export class MessagingDeliveryService {
  private readonly finalText = new Map<string, string>();
  private readonly delivered = new Set<string>();
  private readonly terminalDeliveries = new Map<string, Promise<void>>();
  private readonly runCards = new Map<string, RunCardState>();
  private readonly interactions = new Map<string, InteractionCardState>();

  constructor(private readonly connections: MessagingConnectionManager) {}

  onRunStarted(input: { connectionId: string; bindingId: string; runId: string }) {
    const platform = this.connections.getBindingPlatform(input.bindingId);
    if (platform !== 'feishu' && platform !== 'dingtalk') return;
    this.runCards.set(input.runId, { ...input, chain: Promise.resolve() });
    this.queueRunCard(input.runId, status('Working', 'Thinking about your request.'));
  }

  onRunEvent(event: AgentEvent, run: RuntimeRun) {
    if (run.origin.kind !== 'messaging') return;
    const target = run.origin;
    if (event.type === 'agent.message.done') {
      if (isFinalAssistantMessage(event.payload.message)) this.finalText.set(run.id, event.payload.message.content);
      return;
    }
    if (event.type === 'tool.call') {
      this.queueRunCard(run.id, status('Working', `Using ${event.payload.tool}`));
      return;
    }
    if (event.type === 'ask_user.required') {
      void this.connections.stopTypingForRun(run.id);
      this.queueRunCard(run.id, status('Waiting for input', event.payload.question));
      if (target.platform === 'feishu' || target.platform === 'dingtalk') {
        this.queueInteraction(run.id, event.payload.ask_id, target.connection_id, target.binding_id, {
          title: 'Input required',
          content: event.payload.question,
          actions: event.payload.options.map((option) => ({
            text: option.label,
            value: {
              action: 'ask',
              runId: run.id,
              requestId: event.payload.ask_id,
              optionId: option.id,
              responderOpenId: this.connections.getBindingSender(target.binding_id),
            },
          })),
        }, askFallback(event.payload));
      } else {
        void this.deliver(run.id, target.connection_id, target.binding_id, askFallback(event.payload));
      }
      return;
    }
    if (event.type === 'approval.required') {
      void this.connections.stopTypingForRun(run.id);
      this.queueRunCard(run.id, status('Waiting for approval', event.payload.reason));
      if (target.platform === 'feishu' || target.platform === 'dingtalk') {
        const responderOpenId = this.connections.getBindingSender(target.binding_id);
        this.queueInteraction(run.id, event.payload.approval_id, target.connection_id, target.binding_id, {
          title: 'Approval required',
          content: approvalContent(event.payload),
          actions: [
            { text: 'Allow once', value: { action: 'approve', runId: run.id, requestId: event.payload.approval_id, decision: 'approved', scope: 'once', responderOpenId } },
            { text: 'Allow for session', value: { action: 'approve', runId: run.id, requestId: event.payload.approval_id, decision: 'approved', scope: 'session', responderOpenId } },
            { text: 'Reject', value: { action: 'approve', runId: run.id, requestId: event.payload.approval_id, decision: 'rejected', scope: 'once', responderOpenId } },
          ],
        }, approvalFallback(event.payload));
      } else {
        void this.deliver(run.id, target.connection_id, target.binding_id, approvalFallback(event.payload));
      }
      return;
    }
    if (event.type === 'ask_user.answered') {
      this.resolveInteraction(run.id, event.payload.ask_id, 'Response received', `**Selected:** ${event.payload.selected.label}`);
      this.connections.startTypingForBinding(target.connection_id, target.binding_id, run.id);
      this.queueRunCard(run.id, status('Working', 'Continuing the task.'));
      return;
    }
    if (event.type === 'approval.resolved') {
      const decision = event.payload.decision === 'approved' ? `Allowed for ${event.payload.scope}` : 'Rejected';
      this.resolveInteraction(run.id, event.payload.approval_id, 'Approval resolved', `**Decision:** ${decision}`);
      this.connections.startTypingForBinding(target.connection_id, target.binding_id, run.id);
      this.queueRunCard(run.id, status('Working', 'Continuing the task.'));
      return;
    }
    if (event.type === 'agent.done') {
      void this.connections.stopTypingForRun(run.id);
      this.expireInteractions(run.id);
      if (event.payload.status !== 'completed') {
        this.finalText.delete(run.id);
        if (run.cancel_reason === 'shutdown') return;
        if (this.runCards.has(run.id)) {
          this.queueRunCard(run.id, status('Cancelled', 'The task was cancelled.', true));
          this.trackTerminalDelivery(run.id, this.finishRunCard(run.id, 'The task was cancelled.'));
        } else {
          this.trackTerminalDelivery(run.id, this.deliver(run.id, target.connection_id, target.binding_id, 'The task was cancelled.'));
        }
        return;
      }
      const text = this.finalText.get(run.id) || 'The task completed without a text result.';
      this.finalText.delete(run.id);
      if (this.runCards.has(run.id)) {
        this.queueRunCard(run.id, status('Completed', text, true));
        this.trackTerminalDelivery(run.id, this.finishRunCard(run.id, text));
      } else if (!run.outbound_tool_texts?.includes(text)) {
        this.trackTerminalDelivery(run.id, this.deliver(run.id, target.connection_id, target.binding_id, text));
      }
      return;
    }
    if (event.type === 'agent.error') {
      void this.connections.stopTypingForRun(run.id);
      this.expireInteractions(run.id);
      this.finalText.delete(run.id);
      if (this.runCards.has(run.id)) {
        this.queueRunCard(run.id, status('Failed', event.payload.message, true));
        this.trackTerminalDelivery(run.id, this.finishRunCard(run.id, `Task failed: ${event.payload.message}`));
      } else {
        this.trackTerminalDelivery(run.id, this.deliver(run.id, target.connection_id, target.binding_id, `Task failed: ${event.payload.message}`));
      }
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
      console.warn(`[messaging] delivery failed run=${runId} binding=${bindingId}: ${errorMessage(error)}`);
    }
  }

  private queueInteraction(
    runId: string,
    requestId: string,
    connectionId: string,
    bindingId: string,
    input: InteractionPresentation,
    fallbackText: string,
  ) {
    const key = interactionKey(runId, requestId);
    const state: InteractionCardState = { connectionId, input, chain: Promise.resolve() };
    this.interactions.set(key, state);
    state.chain = this.connections.createInteractionCardForBinding(connectionId, bindingId, input)
      .then((handle) => { state.handle = handle; })
      .catch(async (error) => {
        console.warn(`[messaging] interaction card failed run=${runId} request=${requestId}: ${errorMessage(error)}`);
        await this.deliver(runId, connectionId, bindingId, fallbackText);
      });
  }

  private resolveInteraction(runId: string, requestId: string, title: string, result: string) {
    const key = interactionKey(runId, requestId);
    const state = this.interactions.get(key);
    if (!state) return;
    this.interactions.delete(key);
    state.chain = state.chain.then(async () => {
      if (!state.handle) return;
      await this.connections.updateInteractionCard(state.connectionId, state.handle, {
        title,
        content: `${state.input.content}\n\n${result}`,
      });
    }).catch((error) => {
      console.warn(`[messaging] interaction card update failed run=${runId} request=${requestId}: ${errorMessage(error)}`);
    });
  }

  private expireInteractions(runId: string) {
    for (const key of this.interactions.keys()) {
      if (!key.startsWith(`${runId}:`)) continue;
      this.resolveInteraction(runId, key.slice(runId.length + 1), 'Request closed', '**Status:** No longer available');
    }
  }

  private queueRunCard(runId: string, presentation: RunPresentation) {
    const state = this.runCards.get(runId);
    if (!state) return;
    state.chain = state.chain.then(async () => {
      if (state.handle) await this.connections.updateRunCard(state.connectionId, state.handle, presentation);
      else state.handle = await this.connections.createRunCardForBinding(state.connectionId, state.bindingId, presentation);
    }).catch((error) => {
      state.failed = true;
      console.warn(`[messaging] run card failed run=${runId}: ${errorMessage(error)}`);
    });
  }

  private async finishRunCard(runId: string, fallbackText: string) {
    const state = this.runCards.get(runId);
    if (!state) return;
    await state.chain;
    this.runCards.delete(runId);
    if (state.failed) await this.deliver(runId, state.connectionId, state.bindingId, fallbackText);
  }
}

type RunCardState = {
  connectionId: string;
  bindingId: string;
  handle?: RunCardHandle;
  failed?: boolean;
  chain: Promise<void>;
};

type InteractionCardState = {
  connectionId: string;
  input: InteractionPresentation;
  handle?: InteractionCardHandle;
  chain: Promise<void>;
};

function status(title: string, content: string, terminal = false): RunPresentation {
  return { title, content, terminal };
}

function interactionKey(runId: string, requestId: string) {
  return `${runId}:${requestId}`;
}

function askFallback(ask: PendingAsk) {
  const options = ask.options.map((option, index) => `${index + 1}. ${option.label}`).join('\n');
  return `Input required\n\n${ask.question}\n\n${options}\n\nOpen Moke to respond.`;
}

function approvalContent(approval: PendingApproval) {
  return `${approval.reason}\n\n**Tool:** ${approval.action.tool}\n**Risk:** ${approval.risk}`;
}

function approvalFallback(approval: PendingApproval) {
  return `Approval required\n\n${approvalContent(approval)}\n\nOpen Moke to review this request.`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isFinalAssistantMessage(message: unknown): message is { role: 'assistant'; content: string; tool_calls?: unknown[] } {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { role?: unknown; content?: unknown; tool_calls?: unknown };
  return candidate.role === 'assistant'
    && typeof candidate.content === 'string'
    && (!Array.isArray(candidate.tool_calls) || candidate.tool_calls.length === 0);
}
