/** Page perception types (spec 6.6). Rects are viewport-relative CSS px (== DIP at zoom 1). */
export type Rect = { x: number; y: number; width: number; height: number };

export type SnapElement = {
  id: string;
  role: string;
  name: string;
  rect: Rect;
  inViewport: boolean;
  /** Login/OTP/payment/Aadhaar/EPIC field or inside such a form (spec 6.7). */
  sensitive: boolean;
  isSearch: boolean;
  /** 1-based order among elements of the same role ("the second result"). */
  order: number;
};

export type PageSnapshot = {
  url: string;
  title: string;
  scrollY: number;
  scrollHeight: number;
  viewport: { width: number; height: number };
  elements: SnapElement[];
  searchFieldId: string | null;
  /** The only input value a snapshot may carry (spec rule 13). */
  searchValue?: string;
};

export type PageEvent = {
  type: 'focus' | 'click' | 'input' | 'navigation' | 'escape';
  elementId?: string | null;
  name?: string;
  isSearch?: boolean;
  /** Search box value only. */
  value?: string;
  url?: string;
  at: number;
};
