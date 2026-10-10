/** Status subtitle mapping (spec 7.2). Derived by code from tool events, never from model text. */
import type { ToolName } from './stateMachine';

function hostname(url: unknown): string {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return 'the site';
  }
}

function short(text: unknown, max = 40): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export type StatusLookup = {
  tabTitle(id: string): string | null;
  elementName(id: string): string | null;
};

/** Returns the subtitle for a tool start, or undefined to leave it unchanged. */
export function statusForTool(tool: ToolName, input: Record<string, unknown>, lookup: StatusLookup): string | null | undefined {
  switch (tool) {
    case 'search_docs':
      return 'Searching official documents…';
    case 'reply':
      return null;
    case 'navigate':
    case 'open_tab':
      return `Opening ${hostname(input.url)}…`;
    case 'switch_tab':
      return `Switching to ${short(lookup.tabTitle(String(input.tab_id)) ?? 'the tab')}…`;
    case 'point_at': {
      if (input.target_area === 'toolbar') {
        const id = String(input.target_id ?? '');
        if (id === 'address_bar') return 'Pointing at the address bar…';
        if (id.startsWith('tab:')) return 'Pointing at the tab…';
        return 'Pointing at the toolbar…';
      }
      const name = lookup.elementName(String(input.target_id ?? ''));
      return name ? `Pointing at '${short(name)}'…` : 'Pointing…';
    }
    case 'click': {
      const name = lookup.elementName(String(input.element_id ?? ''));
      return `Clicking '${short(name ?? 'it')}'…`;
    }
    case 'scroll':
      return `Scrolling ${input.direction === 'up' ? 'up' : 'down'}…`;
    case 'type_in_search':
      return 'Typing your search…';
    case 'press_enter':
      return 'Submitting your search…';
    case 'wait_for_user':
      return `Waiting for you to ${short(String(input.hint ?? 'continue').replace(/^to\s+/i, ''), 60)}`;
    case 'finish':
      return null;
    default:
      return undefined;
  }
}

export const STATUS_THINKING = 'Thinking…';
export const STATUS_RETRY = 'Double-checking…';
export function statusFound(n: number): string {
  return `Found ${n} relevant section${n === 1 ? '' : 's'}`;
}
