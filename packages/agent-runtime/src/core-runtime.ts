import type { AgentEvent, AgentInteraction, AgentInteractionResponse, AgentRunCheckpoint, AgentRunInput, AgentRunSnapshot } from '@moke/agent-protocol';

export interface RuntimeAgentRun { readonly runId: string; events(): AsyncIterable<AgentEvent>; }
export interface RuntimeAgent { run(input: AgentRunInput): RuntimeAgentRun; }
export interface EventStore { append(event: AgentEvent): Promise<void>; list(runId: string, afterSequence?: number): Promise<AgentEvent[]>; subscribe(runId: string, listener: (event: AgentEvent) => void): () => void; }
export interface RunStore { save(runId: string, checkpoint: AgentRunCheckpoint): Promise<void>; load(runId: string): Promise<AgentRunCheckpoint | undefined>; delete(runId: string): Promise<void>; }
export interface InteractionBroker { request(runId: string, interaction: AgentInteraction): Promise<AgentInteractionResponse>; resolve(response: AgentInteractionResponse): Promise<void>; pending(runId: string): Promise<AgentInteraction | undefined>; }

export class MemoryEventStore implements EventStore {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  async append(event: AgentEvent) { const list = this.events.get(event.runId) ?? []; if (list.some(item => item.sequence === event.sequence)) return; list.push(structuredClone(event)); this.events.set(event.runId, list); for (const listener of this.listeners.get(event.runId) ?? []) listener(event); }
  async list(runId: string, afterSequence = 0) { return structuredClone((this.events.get(runId) ?? []).filter(event => event.sequence > afterSequence)); }
  subscribe(runId: string, listener: (event: AgentEvent) => void) { const set = this.listeners.get(runId) ?? new Set(); set.add(listener); this.listeners.set(runId, set); return () => set.delete(listener); }
}

export class MemoryRunStore implements RunStore {
  private readonly values = new Map<string, AgentRunCheckpoint>();
  async save(runId: string, checkpoint: AgentRunCheckpoint) { this.values.set(runId, structuredClone(checkpoint)); }
  async load(runId: string) { const value = this.values.get(runId); return value ? structuredClone(value) : undefined; }
  async delete(runId: string) { this.values.delete(runId); }
}

export class MemoryInteractionBroker implements InteractionBroker {
  private readonly values = new Map<string, { runId: string; interaction: AgentInteraction }>();
  private readonly waiters = new Map<string, Array<(response: AgentInteractionResponse) => void>>();
  async request(runId: string, interaction: AgentInteraction) { this.values.set(interaction.id, { runId, interaction: structuredClone(interaction) }); return new Promise<AgentInteractionResponse>(resolve => { const list = this.waiters.get(interaction.id) ?? []; list.push(resolve); this.waiters.set(interaction.id, list); }); }
  async resolve(response: AgentInteractionResponse) { if (!this.values.has(response.interactionId)) throw new Error(`Unknown interaction: ${response.interactionId}`); this.values.delete(response.interactionId); for (const waiter of this.waiters.get(response.interactionId) ?? []) waiter(response); this.waiters.delete(response.interactionId); }
  async pending(runId: string) { return structuredClone([...this.values.values()].find(value => value.runId === runId)?.interaction); }
}

export type AgentRuntimeDependencies = { agent: RuntimeAgent; eventStore?: EventStore; runStore?: RunStore; interactionBroker?: InteractionBroker };
export class AgentRuntime {
  readonly eventStore: EventStore; readonly runStore: RunStore; readonly interactionBroker: InteractionBroker;
  constructor(private readonly dependencies: AgentRuntimeDependencies) { this.eventStore = dependencies.eventStore ?? new MemoryEventStore(); this.runStore = dependencies.runStore ?? new MemoryRunStore(); this.interactionBroker = dependencies.interactionBroker ?? new MemoryInteractionBroker(); }
  start(input: AgentRunInput) { const run = this.dependencies.agent.run(input); void this.persistEvents(run); return run; }
  async restore(runId: string): Promise<AgentRunSnapshot | undefined> { const checkpoint = await this.runStore.load(runId); if (!checkpoint) return undefined; const events = await this.eventStore.list(runId); return { threadId: checkpoint.threadId, runId, status: checkpoint.status, messages: checkpoint.messages, state: checkpoint.state, activities: [], lastSequence: events.at(-1)?.sequence ?? 0, usage: checkpoint.usage, pendingInteraction: checkpoint.pendingInteraction }; }
  private async persistEvents(run: RuntimeAgentRun) { for await (const event of run.events()) await this.eventStore.append(event); }
}
