/**
 * The ONLY path by which model-authored text reaches the chat. Text arrives
 * here after the guard checks, then streams word by word into one bubble
 * (spec 7.1 streaming). Free model text outside tools is never shown.
 */
import { randomUUID } from 'node:crypto';
import type { Citation } from '../shared/ipc';
import type { Host, TaskContext } from './types';

export async function streamAssistant(
  host: Host,
  text: string,
  sources?: Citation[],
  signal?: AbortSignal,
): Promise<void> {
  const id = randomUUID();
  host.chat.emit({ t: 'assistant_start', id });
  const parts = text.match(/\S+\s*/g) ?? [text];
  for (let i = 0; i < parts.length; i += 3) {
    if (signal?.aborted) break;
    host.chat.emit({ t: 'assistant_delta', id, text: parts.slice(i, i + 3).join('') });
    await host.sleep(18);
  }
  host.chat.emit({ t: 'assistant_end', id, sources: sources && sources.length ? sources : undefined });
}

/** "Last verified" footer after a fact bubble (spec rule 10). */
export function emitLastVerified(host: Host, ctx: TaskContext, sourceIds: string[] | undefined): void {
  let date = ctx.corpusLastUpdated;
  if (!date) {
    const dates = (sourceIds ?? [])
      .map((id) => ctx.chunks.get(id)?.citation.retrieved_at ?? '')
      .filter(Boolean)
      .map((d) => d.slice(0, 10))
      .sort();
    date = dates.at(-1) ?? null;
  }
  if (date) host.chat.emit({ t: 'last_verified', date });
}
