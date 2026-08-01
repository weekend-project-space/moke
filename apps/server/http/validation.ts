import { z } from 'zod';

export type ValidationIssue = {
  path: Array<string | number>;
  message: string;
};

export class RequestValidationError extends Error {
  readonly status = 400;
  readonly code = 'VALIDATION_ERROR';

  constructor(readonly issues: ValidationIssue[]) {
    super('Request validation failed');
    this.name = 'RequestValidationError';
  }
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestValidationError(result.error.issues.map((issue) => ({
      path: issue.path.filter((segment): segment is string | number =>
        typeof segment === 'string' || typeof segment === 'number'),
      message: issue.message,
    })));
  }
  return result.data;
}

export async function parseBody<T>(body: () => Promise<unknown>, schema: z.ZodType<T>) {
  return parseInput(schema, await body());
}

export function parseParams<T>(params: Record<string, string>, schema: z.ZodType<T>) {
  return parseInput(schema, params);
}

export function parseQuery<T>(query: URLSearchParams, schema: z.ZodType<T>) {
  return parseInput(schema, Object.fromEntries(query.entries()));
}
