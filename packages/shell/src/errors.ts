import type { ShellErrorCode } from './types.js';

export class ShellRequestError extends Error {
  readonly code: ShellErrorCode;

  constructor(code: ShellErrorCode, message: string) {
    super(message);
    this.name = 'ShellRequestError';
    this.code = code;
  }
}
