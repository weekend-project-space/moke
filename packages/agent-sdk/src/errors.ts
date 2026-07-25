import type { PendingApproval, PendingAsk } from '@moke/protocol';

export class MokeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class MokeApiError extends MokeError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class MokeNetworkError extends MokeError {}

export class MokeProtocolError extends MokeError {
  constructor(
    message: string,
    readonly path?: Array<string | number>,
    readonly received?: unknown,
  ) {
    super(message);
  }
}

export class MokeRunError extends MokeError {
  constructor(readonly runId: string, readonly code: string, message: string) {
    super(message);
  }
}

export class MokeInteractionRequiredError extends MokeError {
  constructor(
    readonly runId: string,
    readonly interaction: PendingAsk | PendingApproval,
  ) {
    super(`Run ${runId} requires interaction`);
  }
}
