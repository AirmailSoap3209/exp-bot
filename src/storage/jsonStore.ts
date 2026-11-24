import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * One JSON document on disk, kept in memory after the first read.
 * Updates are serialised and written atomically (temp file + rename),
 * so a crash mid-write never leaves a truncated file.
 */
export class JsonStore<T> {
  private data: T | undefined;
  private loading: Promise<T> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly defaults: () => T,
  ) {}

  async read(): Promise<T> {
    if (this.data !== undefined) return this.data;
    this.loading ??= this.load().catch((err) => {
      this.loading = undefined; // let a later call retry once the file is fixed
      throw err;
    });
    return this.loading;
  }

  /** Applies `fn` to the document and saves it. Runs one update at a time. */
  update<R>(fn: (data: T) => R): Promise<R> {
    const run = async () => {
      const data = await this.read();
      const result = fn(data);
      await this.save(data);
      return result;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async load(): Promise<T> {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Could not read ${this.file}: ${(err as Error).message}. Fix or remove the file.`);
      }
      this.data = this.defaults();
    }
    return this.data;
  }

  private async save(data: T): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await rename(tmp, this.file);
  }
}
