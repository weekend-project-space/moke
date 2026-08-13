import type { AgentEvent, AgentInteractionResponse, AgentRunInput } from '@moke/agent-protocol';
import type { AgentRuntime } from './core-runtime.js';

export function createAgentHttpHandler(runtime: AgentRuntime) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] !== 'agent' || parts[2] !== 'runs') return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    if (parts.length === 3 && request.method === 'POST') {
      const input = await body<AgentRunInput>(request);
      const run = runtime.start(input);
      return json({ threadId: input.threadId, runId: run.runId, status: run.snapshot().status }, 201);
    }
    const runId = parts[3];
    if (!runId) return json({ error: { code: 'not_found', message: 'Run not found' } }, 404);
    if (parts.length === 4 && request.method === 'GET') {
      const snapshot = await runtime.snapshot(runId);
      return snapshot ? json({ run: snapshot }) : json({ error: { code: 'not_found', message: 'Run not found' } }, 404);
    }
    if (parts[4] === 'events' && request.method === 'GET') return eventStream(runtime, runId, lastSequence(request));
    if (parts[4] === 'respond' && request.method === 'POST') {
      const response = await body<AgentInteractionResponse>(request);
      const run = runtime.getActive(runId);
      if (run) await run.respond(response); else await runtime.interactionBroker.resolve(response);
      return json({ accepted: true });
    }
    if (parts[4] === 'cancel' && request.method === 'POST') {
      const value = await body<{ reason?: string }>(request);
      const run = runtime.getActive(runId);
      if (!run) return json({ error: { code: 'not_running', message: 'Run is not active' } }, 409);
      run.cancel(value.reason);
      return json({ accepted: true });
    }
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  };
}

function eventStream(runtime: AgentRuntime, runId: string, afterSequence: number) {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sequence = afterSequence;
      let closed = false;
      const pending: AgentEvent[] = [];
      let replaying = true;
      const send = (event: AgentEvent) => {
        if (closed || event.sequence <= sequence) return;
        sequence = event.sequence;
        controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        if (terminal(event)) { closed = true; unsubscribe(); controller.close(); }
      };
      unsubscribe = runtime.eventStore.subscribe(runId, event => replaying ? pending.push(event) : send(event));
      try {
        for (const event of await runtime.eventStore.list(runId, afterSequence)) { send(event); if (closed) return; }
        replaying = false;
        for (const event of pending.sort((a, b) => a.sequence - b.sequence)) { send(event); if (closed) return; }
        const snapshot = await runtime.snapshot(runId);
        if (!closed && snapshot && terminalStatus(snapshot.status) && sequence >= snapshot.lastSequence) { closed = true; unsubscribe(); controller.close(); }
      } catch (error) { unsubscribe(); controller.error(error); }
    },
    cancel() { unsubscribe(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}

function lastSequence(request: Request) { const value = Number(request.headers.get('Last-Event-ID') ?? 0); return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function terminal(event: AgentEvent) { return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.timed_out' || event.type === 'run.cancelled'; }
function terminalStatus(status: string) { return status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'cancelled'; }
async function body<T>(request: Request): Promise<T> { return request.json() as Promise<T>; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
