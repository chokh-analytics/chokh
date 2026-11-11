// How many destinations fit in the bar's row, the rest going under More
// (AN-DSH03).
//
// Measured rather than decided by breakpoints, because what fits depends on
// the site's name and the account's beside it, and those vary by install. The
// rule this exists for: no destination is ever hidden without a control on
// screen that reveals it. So either every destination is in the row, or the
// ones that are not are behind More, which is the row's last item.

export interface NavFit {
  // The first `shown` destinations are in the row, in order.
  shown: number;
  // Whether More is drawn at all.
  more: boolean;
  // Whether the page somebody is on is behind More, so the trigger carries
  // the current mark in its place.
  currentInMore: boolean;
}

// widths: each destination's drawn width, in order. available: the row's
// width. moreWidth: the More trigger's. gap: the space between two items.
// current: the index of the page somebody is on, or -1 for none of them.
export function fitNav(
  widths: readonly number[],
  available: number,
  moreWidth: number,
  gap: number,
  current: number,
): NavFit {
  const all = widths.reduce((sum, width, index) => sum + width + (index === 0 ? 0 : gap), 0);
  // Nothing measured yet (a test environment, or before the first layout):
  // everything is in the row, which is what the server would have drawn.
  if (available <= 0 || all <= available) {
    return { shown: widths.length, more: false, currentInMore: false };
  }
  let used = moreWidth;
  let shown = 0;
  for (const width of widths) {
    const next = used + gap + width;
    if (next > available) break;
    used = next;
    shown += 1;
  }
  return { shown, more: true, currentInMore: current >= shown };
}
