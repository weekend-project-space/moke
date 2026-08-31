// Compatibility facade. Persistence responsibilities live in ./messaging.
import { MessagingStorePersistence } from './messaging/messaging-migrations.js';

export * from './messaging/messaging-store-types.js';
export { MessagingStoreCorruptionError } from './messaging/messaging-store-files.js';

export class JsonMessagingStore extends MessagingStorePersistence {}
