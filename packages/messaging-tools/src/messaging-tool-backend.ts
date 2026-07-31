import type {
  MessagingOutboundRequest,
  MessagingOutboundResult,
  MessagingPlatform,
  OutboundContent,
} from '@moke/messaging-core';

export type MessagingTargetResolution =
  | { status: 'resolved'; bindingId: string }
  | { status: 'not_found' }
  | { status: 'ambiguous'; count: number };

export type MessagingOutboundAccess = {
  workspaceRoot: string;
  approvedRoots?: string[];
};

export type MessagingToolBackend = {
  resolveTarget(input: { platform: MessagingPlatform; sessionId: string }): MessagingTargetResolution;
  validateMediaPaths(contents: OutboundContent[], access: MessagingOutboundAccess): Promise<void>;
  send(input: MessagingOutboundRequest, access: MessagingOutboundAccess): Promise<MessagingOutboundResult>;
};
