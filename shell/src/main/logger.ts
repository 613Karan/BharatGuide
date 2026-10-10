/**
 * Local JSONL log (spec 8.4, 12): timestamp, kind, message, small data object.
 * Everything is redacted before writing. Raw user/page text is only logged when
 * DEBUG_LOG=1, and even then redacted. Rotated at 5 MB.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactDeep } from '../rag/redact';
import type { LoggerPort } from '../agent/types';

const MAX_BYTES = 5 * 1024 * 1024;
const RAW_KEYS = new Set(['input', 'text', 'query', 'message', 'page']);

export class FileLogger implements LoggerPort {
  private readonly file: string;

  constructor(dir: string, private readonly debug: boolean) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'shell.jsonl');
  }

  private write(level: string, kind: string, message: string, data?: Record<string, unknown>): void {
    let safe = data ? (redactDeep(data) as Record<string, unknown>) : undefined;
    if (safe && !this.debug) {
      safe = Object.fromEntries(Object.entries(safe).filter(([key]) => !RAW_KEYS.has(key)));
    }
    const line = JSON.stringify({ at: new Date().toISOString(), level, kind, message: redactDeep(message), ...(safe ? { data: safe } : {}) });
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch {
      // Logging must never break the app.
    }
    if (this.debug) console.log(line);
  }

  info(kind: string, message: string, data?: Record<string, unknown>): void {
    this.write('info', kind, message, data);
  }
  warn(kind: string, message: string, data?: Record<string, unknown>): void {
    this.write('warn', kind, message, data);
  }
  error(kind: string, message: string, data?: Record<string, unknown>): void {
    this.write('error', kind, message, data);
  }
}
