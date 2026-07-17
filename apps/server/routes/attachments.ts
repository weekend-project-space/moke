import { HttpError, rawResponse, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';

export function registerAttachmentRoutes(router: Router<RoutesContext>) {
  router.get('/api/attachments/:sha256', ({ context, params, raw }) => {
    const attachment = context.attachmentStore.open(params.sha256);
    if (!attachment) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');

    raw.res.writeHead(200, {
      'Content-Type': attachment.mimeType,
      'Content-Length': attachment.data.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${attachment.sha256}"`,
      'Access-Control-Allow-Origin': '*',
    });
    raw.res.end(attachment.data);
    return rawResponse();
  });
}
