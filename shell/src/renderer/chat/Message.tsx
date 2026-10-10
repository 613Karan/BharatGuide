import { useState } from 'react';
import Markdown from 'react-markdown';
import type { Citation } from '../../shared/ipc';
import type { Item } from './store';

const CARD_ICON: Record<string, string> = { abstain: 'ℹ️', service_down: '⚠️', halted: '⏹', redaction: '🔒' };
const CARD_TITLE: Record<string, string> = {
  abstain: 'Not in the official documents',
  service_down: 'Cannot reach the knowledge base',
  halted: 'Task stopped',
  redaction: 'Personal data removed',
};

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Links in model markdown are not followed directly; they go through the allowlist. */
function SafeLink({ href, children, onOpen }: { href?: string; children?: React.ReactNode; onOpen: (url: string) => void }) {
  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        if (href) onOpen(href);
      }}
    >
      {children}
    </a>
  );
}

function SourceChip({ sources, onOpen }: { sources: Citation[]; onOpen: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`sources ${open ? 'open' : ''}`}>
      <button className="chip" onClick={() => setOpen(!open)}>
        📄 Source{sources.length > 1 ? `s (${sources.length})` : ''} {open ? '▴' : '▾'}
      </button>
      {open && (
        <ul>
          {sources.map((c, i) => (
            <li key={i}>
              <div className="src-title">
                <b>{c.org}</b> · {c.doc_title}
              </div>
              <div className="src-meta">
                {c.section_path && <span>Section: {c.section_path}</span>}
                {c.pages?.length > 0 && <span>Page {c.pages.join(', ')}</span>}
                {c.publication_date && <span>Published {c.publication_date}</span>}
              </div>
              {c.source_url && (
                <a href="#" onClick={(e) => { e.preventDefault(); onOpen(c.source_url); }}>
                  Open official document ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Message({ item, onOpen }: { item: Item; onOpen: (url: string) => void }) {
  if (item.kind === 'user') {
    return (
      <div className="row user" title={time(item.at)}>
        <div className="bubble user">{item.text}</div>
      </div>
    );
  }
  if (item.kind === 'card') {
    return (
      <div className={`card card-${item.card}`}>
        <div className="card-head">
          <span>{CARD_ICON[item.card]}</span> {CARD_TITLE[item.card]}
        </div>
        <div>{item.body}</div>
        {item.helpline && <div className="helpline">📞 {item.helpline}</div>}
      </div>
    );
  }
  return (
    <div className="row assistant" title={time(item.at)}>
      <div className="bubble assistant">
        <Markdown components={{ a: ({ href, children }) => <SafeLink href={href} onOpen={onOpen}>{children}</SafeLink> }}>
          {item.text || ' '}
        </Markdown>
        {item.sources && item.sources.length > 0 && <SourceChip sources={item.sources} onOpen={onOpen} />}
      </div>
    </div>
  );
}
