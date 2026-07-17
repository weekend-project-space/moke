import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import type { Session, SessionSummary } from '@moke/protocol';

const SAVE_DEBOUNCE_MS = 80;
const MAX_RETRY_DELAY_MS = 5_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const INDEX_VERSION = 1;

export type SessionSummaryFactory = (session: Session) => SessionSummary;

export type SessionRepository = {
  initialize(): void;
  list(): SessionSummary[];
  get(sessionId: string): Session | undefined;
  save(session: Session): void;
  flush(): void;
};

type SessionStoreInput = {
  storePath: string;
  legacyStatePath: string;
  summarizeSession: SessionSummaryFactory;
};

type LegacyState = { sessions?: Session[] };
type SessionIndex = { version: number; sessions: SessionSummary[] };

export class JsonSessionStore implements SessionRepository {
  private readonly sessionsPath: string;
  private readonly indexPath: string;
  private readonly indexDirtyPath: string;
  private readonly migrationMarkerPath: string;
  private readonly summaries = new Map<string, SessionSummary>();
  private readonly loadedSessions = new Map<string, Session>();
  private readonly pendingSessions = new Map<string, Session>();
  private saveTimer: NodeJS.Timeout | undefined;
  private retryDelay = SAVE_DEBOUNCE_MS;

  constructor(private readonly input: SessionStoreInput) {
    this.sessionsPath = join(input.storePath, 'sessions');
    this.indexPath = join(input.storePath, 'index.json');
    this.indexDirtyPath = join(input.storePath, '.index-dirty');
    this.migrationMarkerPath = join(input.storePath, '.migration-in-progress');
  }

  initialize() {
    this.migrateLegacyState();
    mkdirSync(this.input.storePath, { recursive: true });

    if (existsSync(this.indexDirtyPath) || !this.loadIndex()) {
      this.rebuildIndex();
      return;
    }

    const sessionFileIds = this.listSessionFileIds();
    if (
      sessionFileIds.size !== this.summaries.size
      || [...sessionFileIds].some((sessionId) => !this.summaries.has(sessionId))
    ) {
      this.rebuildIndex();
    }
  }

  list() {
    return [...this.summaries.values()];
  }

  get(sessionId: string) {
    assertSafeSessionId(sessionId);
    const loaded = this.loadedSessions.get(sessionId);
    if (loaded) return loaded;

    const filePath = this.sessionPath(sessionId);
    if (!existsSync(filePath)) return undefined;
    try {
      const session = this.readSessionFile(filePath, sessionId);
      this.loadedSessions.set(session.id, session);
      return session;
    } catch (error) {
      console.warn(`Failed to load session from ${filePath}:`, error);
      this.quarantineSession(filePath);
      if (this.summaries.delete(sessionId)) {
        try {
          this.writeIndex();
        } catch (indexError) {
          console.warn(`Failed to remove corrupted session ${sessionId} from the index:`, indexError);
        }
      }
      return undefined;
    }
  }

  save(session: Session) {
    assertSafeSessionId(session.id);
    this.loadedSessions.set(session.id, session);
    this.summaries.set(session.id, this.input.summarizeSession(session));
    this.pendingSessions.set(session.id, session);
    this.scheduleFlush(SAVE_DEBOUNCE_MS);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.pendingSessions.size === 0) return;

    mkdirSync(this.input.storePath, { recursive: true });
    writeFileSync(this.indexDirtyPath, `${new Date().toISOString()}\n`);
    const pending = [...this.pendingSessions.values()];
    for (const session of pending) this.writeSession(session);
    this.writeIndex();
    rmSync(this.indexDirtyPath, { force: true });
    for (const session of pending) this.pendingSessions.delete(session.id);
    this.retryDelay = SAVE_DEBOUNCE_MS;
  }

  private scheduleFlush(delay: number) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try {
        this.flush();
      } catch (error) {
        console.warn('Failed to flush session store:', error);
        this.scheduleFlush(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
      }
    }, delay);
  }

  private loadIndex() {
    if (!existsSync(this.indexPath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Partial<SessionIndex>;
      if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.sessions) || parsed.sessions.some((item) => !isSessionSummary(item))) {
        return false;
      }
      this.summaries.clear();
      for (const summary of parsed.sessions) this.summaries.set(summary.id, summary);
      return true;
    } catch (error) {
      console.warn(`Failed to load session index from ${this.indexPath}:`, error);
      return false;
    }
  }

  private rebuildIndex() {
    this.summaries.clear();
    this.loadedSessions.clear();
    for (const session of this.readAllSessions()) {
      this.summaries.set(session.id, this.input.summarizeSession(session));
    }
    this.writeIndex();
    rmSync(this.indexDirtyPath, { force: true });
  }

  private writeIndex() {
    const temporaryPath = `${this.indexPath}.${process.pid}.tmp`;
    const index: SessionIndex = {
      version: INDEX_VERSION,
      sessions: [...this.summaries.values()],
    };
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(index, null, 2)}\n`);
      renameSync(temporaryPath, this.indexPath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private writeSession(session: Session) {
    assertSafeSessionId(session.id);
    const path = this.sessionPath(session.id);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(this.sessionsPath, { recursive: true });
      writeFileSync(temporaryPath, `${JSON.stringify(session, null, 2)}\n`);
      renameSync(temporaryPath, path);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private readAllSessions() {
    if (!existsSync(this.sessionsPath)) return [];
    const sessions: Session[] = [];
    for (const entry of readdirSync(this.sessionsPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = join(this.sessionsPath, entry.name);
      try {
        sessions.push(this.readSessionFile(filePath, basename(entry.name, '.json')));
      } catch (error) {
        console.warn(`Failed to load session from ${filePath}:`, error);
        this.quarantineSession(filePath);
      }
    }
    return sessions;
  }

  private readSessionFile(filePath: string, expectedId: string) {
    const session = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<Session>;
    if (!isSession(session) || session.id !== expectedId) throw new Error('invalid session shape or filename');
    return session as Session;
  }

  private listSessionFileIds() {
    if (!existsSync(this.sessionsPath)) return new Set<string>();
    return new Set(
      readdirSync(this.sessionsPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => basename(entry.name, '.json'))
        .filter((sessionId) => SESSION_ID_PATTERN.test(sessionId)),
    );
  }

  private quarantineSession(filePath: string) {
    const corruptPath = join(this.sessionsPath, '.corrupt');
    const targetPath = join(corruptPath, `${basename(filePath)}.${Date.now()}.${process.pid}.corrupt`);
    try {
      mkdirSync(corruptPath, { recursive: true });
      renameSync(filePath, targetPath);
    } catch (error) {
      console.warn(`Failed to quarantine corrupted session ${filePath}:`, error);
    }
  }

  private sessionPath(sessionId: string) {
    return join(this.sessionsPath, `${sessionId}.json`);
  }

  private migrateLegacyState() {
    const legacyExists = existsSync(this.input.legacyStatePath);
    const storeExists = existsSync(this.sessionsPath);
    const markerExists = existsSync(this.migrationMarkerPath);

    if (!legacyExists) {
      if (markerExists) rmSync(this.migrationMarkerPath, { force: true });
      return;
    }
    if (storeExists && !markerExists) {
      throw new Error(`Legacy state and session store both exist. Resolve manually: ${this.input.legacyStatePath}`);
    }

    if (markerExists && storeExists) rmSync(this.sessionsPath, { recursive: true, force: true });
    mkdirSync(this.sessionsPath, { recursive: true });
    writeFileSync(this.migrationMarkerPath, `${new Date().toISOString()}\n`);
    const parsed = JSON.parse(readFileSync(this.input.legacyStatePath, 'utf8')) as LegacyState;
    if (!Array.isArray(parsed.sessions) || parsed.sessions.some((session) => !isSession(session))) {
      throw new Error(`Legacy state contains invalid sessions: ${this.input.legacyStatePath}`);
    }
    const sessions = parsed.sessions as Session[];
    for (const session of sessions) this.writeSession(session);

    const loaded = this.readAllSessions();
    if (loaded.length !== sessions.length || loaded.some((session) => !sessions.some((item) => item.id === session.id))) {
      throw new Error(`Legacy state migration validation failed for ${this.input.legacyStatePath}`);
    }

    let backupPath = `${this.input.legacyStatePath}.bak`;
    if (existsSync(backupPath)) backupPath = `${backupPath}.${Date.now()}`;
    renameSync(this.input.legacyStatePath, backupPath);
    rmSync(this.migrationMarkerPath, { force: true });
  }
}

function assertSafeSessionId(id: string) {
  if (!SESSION_ID_PATTERN.test(id)) throw new Error(`Invalid session id: ${id}`);
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Session>;
  return SESSION_ID_PATTERN.test(candidate.id || '')
    && typeof candidate.title === 'string'
    && typeof candidate.created_at === 'string'
    && typeof candidate.updated_at === 'string'
    && Array.isArray(candidate.messages)
    && !!candidate.metadata && typeof candidate.metadata === 'object';
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionSummary>;
  return SESSION_ID_PATTERN.test(candidate.id || '')
    && typeof candidate.title === 'string'
    && typeof candidate.created_at === 'string'
    && typeof candidate.updated_at === 'string'
    && typeof candidate.archived === 'boolean'
    && typeof candidate.pinned === 'boolean'
    && typeof candidate.preview === 'string'
    && Number.isInteger(candidate.message_count)
    && (candidate.message_count || 0) >= 0;
}
