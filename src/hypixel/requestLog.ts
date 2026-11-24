import { appendFile, mkdir } from 'node:fs/promises';
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

/** Appends one JSON line per keyed request. Never receives the API key. */
export class RequestLog {
  private ready: Promise<unknown>;

  constructor(private readonly file: string) {
    this.ready = mkdir(dirname(file), { recursive: true });
  }

  async write(entry: KeyedRequestLogEntry): Promise<void> {
    await this.ready;
    await appendFile(this.file, JSON.stringify(entry) + '\n', 'utf8');
  }
}
