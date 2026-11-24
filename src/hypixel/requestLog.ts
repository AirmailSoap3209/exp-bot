import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface KeyedRequestLogEntry {
  time: string;
  path: string;
  status: number;
  remaining?: number;
  limit?: number;
  durationMs: number;
  attempt: number;
}

/** Past this size the log moves to <file>.1 (replacing the previous one) and starts fresh. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Appends one JSON line per keyed request. Never receives the API key. */
export class RequestLog {
  private ready: Promise<unknown>;
  private writes = 0;

  constructor(private readonly file: string, private readonly maxBytes = MAX_BYTES) {
    this.ready = mkdir(dirname(file), { recursive: true });
  }

  async write(entry: KeyedRequestLogEntry): Promise<void> {
    await this.ready;
    // Checking the size every 100 writes keeps this cheap.
    if (this.writes++ % 100 === 0) await this.rotateIfLarge();
    await appendFile(this.file, JSON.stringify(entry) + '\n', 'utf8');
  }

  private async rotateIfLarge(): Promise<void> {
    try {
      if ((await stat(this.file)).size >= this.maxBytes) await rename(this.file, `${this.file}.1`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('request log rotation failed', err);
    }
  }
}
