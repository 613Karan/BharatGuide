/**
 * RAG client (spec 9.5). Runs in the main process only; the service token
 * never reaches a renderer. The query is redacted again here as a backstop.
 */
import type { Citation } from '../shared/ipc';
import { redactText } from './redact';

export type SearchFilters = { org?: 'ECI' | 'UIDAI'; doc_type?: string[]; form_id?: string };

export type SearchResult = {
  chunk_id: string;
  doc_id?: string;
  score: number;
  is_hit: boolean;
  text: string;
  ui_labels: string[];
  citation: Citation & { retrieved_at?: string };
};

export type SearchResponse = {
  abstain: boolean;
  reason: 'no_relevant_source' | 'out_of_scope' | null;
  helpline: string | null;
  results: SearchResult[];
  corpus_last_updated: string | null;
};

export type Health = {
  ok: boolean;
  model_loaded: boolean;
  warming_up: boolean;
  qdrant_reachable: boolean;
  point_count: number | null;
  corpus_last_updated: string | null;
};

export class RagUnavailableError extends Error {}

export class RagClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, topK = 5, filters?: SearchFilters, signal?: AbortSignal): Promise<SearchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ query: redactText(query), top_k: topK, filters: filters ?? null }),
        signal: controller.signal,
      });
      if (!response.ok) throw new RagUnavailableError(`knowledge base returned HTTP ${response.status}`);
      return (await response.json()) as SearchResponse;
    } catch (error) {
      if (error instanceof RagUnavailableError) throw error;
      throw new RagUnavailableError(`knowledge base unreachable: ${String(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async health(): Promise<Health | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      return (await response.json()) as Health;
    } catch {
      return null;
    }
  }
}
