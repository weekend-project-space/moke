import type { AgentEvent, AgentInteraction, AgentInteractionResponse, AgentRunCheckpoint, AgentRunInput, AgentRunSnapshot } from '@moke/agent-protocol';

export interface RuntimeAgentRun { readonly runId: string; events(): AsyncIterable<AgentEvent>; snapshot(): AgentRunSnapshot; respond(response: AgentInteractionResponse): Promise<void>; cancel(reason?: string): void; }
export interface RuntimeAgent { run(input: AgentRunInput): RuntimeAgentRun; }
export interface EventStore { append(event: AgentEvent): Promise<void>; list(runId: string, afterSequence?: number): Promise<AgentEvent[]>; subscribe(runId: string, listener: (event: AgentEvent) => void): () => void; }
export interface RunStore { saveCheckpoint(runId: string, checkpoint: AgentRunCheckpoint): Promise<void>; loadCheckpoint(runId: string): Promise<AgentRunCheckpoint | undefined>; saveSnapshot(runId: string, snapshot: AgentRunSnapshot): Promise<void>; loadSnapshot(runId: string): Promise<AgentRunSnapshot | undefined>; delete(runId: string): Promise<void>; }
export interface InteractionBroker { request(runId: string, interaction: AgentInteraction): Promise<AgentInteractionResponse>; resolve(response: AgentInteractionResponse): Promise<void>; pending(runId: string): Promise<AgentInteraction | undefined>; }

export class MemoryEventStore implements EventStore {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  async append(event: AgentEvent) { const list = this.events.get(event.runId) ?? []; if (list.some(item => item.sequence === event.sequence)) return; list.push(structuredClone(event)); this.events.set(event.runId, list); for (const listener of this.listeners.get(event.runId) ?? []) listener(event); }
  async list(runId: string, afterSequence = 0) { return structuredClone((this.events.get(runId) ?? []).filter(event => event.sequence > afterSequence)); }
  subscribe(runId: string, listener: (event: AgentEvent) => void) { const set = this.listeners.get(runId) ?? new Set(); set.add(listener); this.listeners.set(runId, set); return () => set.delete(listener); }
}

export class MemoryRunStore implements RunStore {
  private readonly checkpoints = new Map<string, AgentRunCheckpoint>();
  private readonly snapshots = new Map<string, AgentRunSnapshot>();
  async saveCheckpoint(runId: string, checkpoint: AgentRunCheckpoint) { this.checkpoints.set(runId, structuredClone(checkpoint)); }
  async loadCheckpoint(runId: string) { const value = this.checkpoints.get(runId); return value ? structuredClone(value) : undefined; }
  async saveSnapshot(runId: string, snapshot: AgentRunSnapshot) { this.snapshots.set(runId, structuredClone(snapshot)); }
  async loadSnapshot(runId: string) { const value = this.snapshots.get(runId); return value ? structuredClone(value) : undefined; }
  async delete(runId: string) { this.checkpoints.delete(runId); this.snapshots.delete(runId); }
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
  private readonly activeRuns = new Map<string, RuntimeAgentRun>();
  constructor(private readonly dependencies: AgentRuntimeDependencies) { this.eventStore = dependencies.eventStore ?? new MemoryEventStore(); this.runStore = dependencies.runStore ?? new MemoryRunStore(); this.interactionBroker = dependencies.interactionBroker ?? new MemoryInteractionBroker(); }
  start(input: AgentRunInput) { const run = this.dependencies.agent.run(input); this.activeRuns.set(run.runId, run); void this.runStore.saveSnapshot(run.runId, run.snapshot()); void this.persistEvents(run); return run; }
  getActive(runId: string) { return this.activeRuns.get(runId); }
  async snapshot(runId: string) { const active = this.activeRuns.get(runId)?.snapshot(); if (active) return active; const stored = await this.runStore.loadSnapshot(runId); return stored ?? this.restore(runId); }
  async restore(runId: string): Promise<AgentRunSnapshot | undefined> { const checkpoint = await this.runStore.loadCheckpoint(runId); if (!checkpoint) return undefined; const events = await this.eventStore.list(runId); return { threadId: checkpoint.threadId, runId, status: checkpoint.status, messages: checkpoint.messages, state: checkpoint.state, activities: [], lastSequence: events.at(-1)?.sequence ?? 0, usage: checkpoint.usage, pendingInteraction: checkpoint.pendingInteraction }; }
  private async persistEvents(run: RuntimeAgentRun) { try { for await (const event of run.events()) { await this.eventStore.append(event); await this.runStore.saveSnapshot(run.runId, run.snapshot()); } } finally { await this.runStore.saveSnapshot(run.runId, run.snapshot()); this.activeRuns.delete(run.runId); } }
}
