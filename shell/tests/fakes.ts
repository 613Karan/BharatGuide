/** Test host/context builders. No Electron, no network, no LLM. */
import type { SearchResponse } from '../src/rag/client';
import type { ChatEvent } from '../src/shared/ipc';
import { StateMachine } from '../src/agent/stateMachine';
import { GrantStore } from '../src/agent/typingGrant';
import type { Host, TaskContext } from '../src/agent/types';
import { FakeBrowser, FakeGhost } from './fakeBrowser';

export * from './fakeBrowser';

export const FORM6_CHUNK =
  'GUIDELINES FOR FILLING UP THE APPLICATION FORM-6. Form 6 is for new voters who are 18 years or above. Attach "Proof of Age" and "Proof of Residence". The fee is Rs. 0. Decision within 30 days.';

export function okResponse(texts = [FORM6_CHUNK]): SearchResponse {
  return {
    abstain: false,
    reason: null,
    helpline: null,
    corpus_last_updated: '2026-10-10',
    results: texts.map((text, i) => ({
      chunk_id: `c${i}`,
      score: 0.9,
      is_hit: true,
      text,
      ui_labels: [],
      citation: {
        org: 'ECI',
        doc_title: 'Guidelines for Form-6',
        section_path: '1. General',
        pages: [1],
        publication_date: '2022-07-20',
        source_url: 'https://voters.eci.gov.in/guidelines/Form-6_en.pdf',
      },
    })),
  };
}

export function makeHost(overrides: Partial<{ rag: Host['rag']; browser: FakeBrowser; ghost: FakeGhost }> = {}) {
  const events: ChatEvent[] = [];
  const browser = overrides.browser ?? new FakeBrowser();
  const ghost = overrides.ghost ?? new FakeGhost();
  const logs: { kind: string; message: string; data?: unknown }[] = [];
  const push = (kind: string, message: string, data?: unknown): void => void logs.push({ kind, message, data });
  const host: Host = {
    browser,
    ghost,
    chat: { emit: (e) => events.push(e) },
    rag: overrides.rag ?? { search: async () => okResponse() },
    logger: { info: push, warn: push, error: push },
    config: {
      allowedHosts: ['voters.eci.gov.in', 'www.youtube.com', 'www.google.com'],
      helplineFallback: 'Voter Helpline 1950 | UIDAI 1947',
    },
    sleep: async () => undefined,
    now: () => Date.now(),
  };
  return { host, events, browser, ghost, logs };
}

export function makeCtx(state: 'Guiding' | 'RunningCommand' = 'Guiding', extra: Partial<TaskContext> = {}): TaskContext {
  const machine = new StateMachine();
  machine.apply(state === 'RunningCommand' ? 'search_command' : 'user_message');
  return {
    taskId: 'task-1',
    userMessage: 'test',
    userAskedClick: false,
    userAskedScroll: false,
    chunks: new Map(),
    sourceHosts: new Set(),
    corpusLastUpdated: null,
    searchCalls: 0,
    toolCalls: 0,
    consecutiveRejections: 0,
    lastSuccessfulTool: null,
    stopped: false,
    finished: false,
    signal: new AbortController().signal,
    machine,
    grants: new GrantStore(),
    ghostAt: null,
    ...extra,
  };
}

export function assistantText(events: ChatEvent[]): string {
  return events
    .filter((e) => e.t === 'assistant_delta')
    .map((e) => (e as { text: string }).text)
    .join('');
}
