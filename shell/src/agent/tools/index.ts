import type { ToolDef } from '../types';
import { click } from './click';
import { finish } from './finish';
import { navigate } from './navigate';
import { openTab } from './openTab';
import { pointAt } from './pointAt';
import { pressEnter } from './pressEnter';
import { reply } from './reply';
import { scroll } from './scroll';
import { searchDocs } from './searchDocs';
import { switchTab } from './switchTab';
import { typeInSearch } from './typeInSearch';
import { waitForUser } from './waitForUser';

/** The ONLY things a planner can call (spec 8.3). */
export const ALL_TOOLS: ToolDef[] = [
  searchDocs,
  reply,
  pointAt,
  click,
  scroll,
  openTab,
  switchTab,
  navigate,
  typeInSearch,
  pressEnter,
  waitForUser,
  finish,
];
