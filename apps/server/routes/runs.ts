import type { Run } from '../../../packages/protocol/src/index.js';
import { HttpError, rawResponse, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { isTerminalRun } from '../domain/sessions.js';

export function registerRunRoutes(router: Router<RoutesContext>) {
  router.get('/api/runs/active', ({ context, json }) => {
    const runs = [...context.runs.values()]
      .filter((run) => !isTerminalRun(run))
      .map((run) => ({
        session_id: run.session_id,
        run_id: run.id,
        status: run.status,
        events_url: `/api/runs/${run.id}/events`,
        pending_ask: run.pending_ask,
        pending_approval: run.pending_approval,
      }));

    return json(200, { runs });
  });

  router.get('/api/runs/:id/events', ({ context, params, raw }) => {
    const run = getRun(context, params.id);

    raw.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    for (const event of run.events) {
      raw.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    if (isTerminalRun(run)) {
      raw.res.end();
      return rawResponse();
    }

    run.clients.add(raw.res);
    raw.req.on('close', () => run.clients.delete(raw.res));
    return rawResponse();
  });

  router.post('/api/runs/:id/respond', async ({ body, context, json, params }) => {
    const run = getRun(context, params.id);
    const requestBody = await body();
    const type = typeof requestBody.type === 'string' ? requestBody.type : '';

    if (type === 'choose') {
      return handleChoose(context, run, requestBody, json);
    }

    if (type === 'approve') {
      return handleApprove(context, run, requestBody, json);
    }

    if (type === 'cancel') {
      context.runManager.cancel(run.id);
      return json(200, {
        run_id: run.id,
        status: 'cancelled',
      });
    }

    throw new HttpError(400, 'BAD_REQUEST', 'type must be choose, approve, or cancel');
  });
}

function getRun(context: RoutesContext, id: string) {
  const run = context.runs.get(id);
  if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'Run not found');
  return run;
}

function handleChoose(
  context: RoutesContext,
  run: Run,
  body: Record<string, unknown>,
  json: (status: number, body: unknown) => void,
) {
  const requestId = typeof body.request_id === 'string' ? body.request_id : '';
  const optionId = typeof body.option_id === 'string' ? body.option_id : '';
  if (!requestId || !optionId) {
    throw new HttpError(400, 'BAD_REQUEST', 'request_id and option_id are required');
  }

  const result = context.runManager.answer(run.id, requestId, optionId);
  if (result.status !== 200) {
    throw new HttpError(
      result.status,
      result.status === 404 ? 'RUN_NOT_FOUND' : result.status === 400 ? 'BAD_REQUEST' : 'ASK_NOT_PENDING',
      result.error,
    );
  }

  return json(200, {
    run_id: result.run.id,
    request_id: requestId,
    status: result.run.status,
  });
}

function handleApprove(
  context: RoutesContext,
  run: Run,
  body: Record<string, unknown>,
  json: (status: number, body: unknown) => void,
) {
  const requestId = typeof body.request_id === 'string' ? body.request_id : '';
  const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : '';
  const scope =
    body.scope === 'once' || body.scope === 'session' || body.scope === 'persistent' ? body.scope : undefined;

  if (!requestId || !decision) {
    throw new HttpError(400, 'BAD_REQUEST', 'request_id and decision are required');
  }

  const result = context.runManager.approve(run.id, requestId, decision, {
    scope,
    message: typeof body.message === 'string' ? body.message : undefined,
  });
  if (result.status !== 200) {
    throw new HttpError(result.status, result.status === 404 ? 'RUN_NOT_FOUND' : 'APPROVAL_NOT_PENDING', result.error);
  }

  return json(200, {
    run_id: result.run.id,
    request_id: requestId,
    status: result.run.status,
  });
}
