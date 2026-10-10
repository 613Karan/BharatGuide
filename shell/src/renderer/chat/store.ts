/** Chat state reducer: turns ChatEvents into the message list (pure, testable). */
import type { AgentState, CardKind, ChatEvent, Citation } from '../../shared/ipc';

export type Item =
  | { kind: 'user'; id: string; text: string; at: number }
  | { kind: 'assistant'; id: string; text: string; at: number; done: boolean; sources?: Citation[] }
  | { kind: 'card'; id: string; card: CardKind; body: string; helpline?: string; at: number };

export type ChatState = {
  items: Item[];
  state: AgentState;
  status: string | null;
  lastVerified: string | null;
  service: 'ok' | 'warming_up' | 'down' | 'unknown';
  waitingFirstToken: boolean;
};

export const initialState: ChatState = {
  items: [],
  state: 'Idle',
  status: null,
  lastVerified: null,
  service: 'unknown',
  waitingFirstToken: false,
};

let seq = 0;

export function reduce(s: ChatState, e: ChatEvent): ChatState {
  const at = Date.now();
  switch (e.t) {
    case 'user_msg':
      return { ...s, items: [...s.items, { kind: 'user', id: e.id, text: e.text, at }], waitingFirstToken: true };
    case 'assistant_start':
      return { ...s, items: [...s.items, { kind: 'assistant', id: e.id, text: '', at, done: false }], waitingFirstToken: false };
    case 'assistant_delta':
      return {
        ...s,
        items: s.items.map((it) => (it.kind === 'assistant' && it.id === e.id ? { ...it, text: it.text + e.text } : it)),
      };
    case 'assistant_end':
      return {
        ...s,
        items: s.items.map((it) => (it.kind === 'assistant' && it.id === e.id ? { ...it, done: true, sources: e.sources } : it)),
      };
    case 'status':
      return { ...s, status: e.text };
    case 'state':
      return {
        ...s,
        state: e.state,
        status: e.state === 'Idle' || e.state === 'Halted' ? null : s.status,
        waitingFirstToken: e.state === 'Idle' || e.state === 'Halted' ? false : s.waitingFirstToken,
      };
    case 'card':
      seq += 1;
      return {
        ...s,
        items: [...s.items, { kind: 'card', id: `card-${seq}`, card: e.kind, body: e.body, helpline: e.helpline, at }],
        waitingFirstToken: e.kind === 'redaction' ? s.waitingFirstToken : false,
      };
    case 'last_verified':
      return { ...s, lastVerified: e.date };
    case 'service':
      return { ...s, service: e.status };
    default:
      return s;
  }
}
