import type { ApprovalMode, SessionEnvironment } from '@moke/protocol';
import type { RunOrigin } from './run-state.js';

export type ToolApprovalReviewRequest = {
  approvalId: string;
  runId: string;
  sessionId: string;
  userRequest: string;
  environment: SessionEnvironment;
  origin: RunOrigin;
  tool: string;
  source?: { type: 'local' | 'mcp'; server_id?: string };
  input: Record<string, unknown>;
};

export type AiApprovalReview =
  | { decision: 'approved'; reason: string }
  | { decision: 'rejected'; reason: string }
  | { decision: 'escalated'; reason: string };

export interface AiApprovalReviewer {
  review(request: ToolApprovalReviewRequest, options: { signal?: AbortSignal }): Promise<AiApprovalReview>;
}

export type ApprovalReviewContext = {
  approvalMode: ApprovalMode;
  environment: SessionEnvironment;
  runId: string;
  sessionId: string;
  origin: RunOrigin;
  userRequest: string;
  signal?: AbortSignal;
};
