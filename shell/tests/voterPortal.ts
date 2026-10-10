/** A voters.eci.gov.in-like page: voter-ID navigation links + a sensitive EPIC input. */
import type { SnapElement } from '../src/shared/page';
import { makeHost, snapshot } from './fakes';

const el = (id: string, role: string, name: string, y: number, sensitive = false): SnapElement => ({
  id, role, name, rect: { x: 300, y, width: 220, height: 40 }, inViewport: true, sensitive, isSearch: false, order: 1,
});

export const FILL_FORM6 = el('e10', 'link', 'Fill Form 6', 160);
export const E_EPIC = el('e11', 'link', 'Download e-EPIC (Voter ID card)', 220);
export const SEARCH_ROLL = el('e12', 'button', 'Search in Electoral Roll', 280);
export const EPIC_INPUT = el('e13', 'textbox', 'EPIC Number / Voter ID', 340, true);
export const OFFSCREEN_VOTERID: SnapElement = { ...el('e14', 'link', 'Voter ID services', 1400), inViewport: false };

export function portal() {
  const made = makeHost();
  made.browser.snap = {
    ...snapshot([FILL_FORM6, E_EPIC, SEARCH_ROLL, EPIC_INPUT, OFFSCREEN_VOTERID]),
    url: 'https://voters.eci.gov.in/',
  };
  return made;
}
