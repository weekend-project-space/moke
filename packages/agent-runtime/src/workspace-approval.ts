export type PathApprovalDetails = {
  path: string;
  suggestedRoot: string;
  reason?: string;
};

export class PathRequiresApprovalError extends Error {
  readonly code = 'PATH_REQUIRES_APPROVAL';

  constructor(readonly details: PathApprovalDetails) {
    super(details.reason || `Path requires approval: ${details.path}`);
    this.name = 'PathRequiresApprovalError';
  }
}

export function isPathRequiresApprovalError(error: unknown): error is PathRequiresApprovalError {
  return error instanceof PathRequiresApprovalError;
}
