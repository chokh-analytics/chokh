import { useEffect,
  useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import styles from './Popover.module.css';

// A small panel hanging off a button.
//
// Three behaviours, and all three are the ones people notice only when they are
// missing: Escape closes it, a click anywhere else closes it, and the focus
// goes back to the button that opened it so a keyboard is not stranded at the
// top of the document.

export interface PopoverProps {
  // What opens it. Given the open state so it can say aria-expanded.
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (props: { close: () => void }) => ReactNode;
  align?: 'left' | 'right';
  label: string;
}

export function Popover({ trigger, children, align = 'right', label }: PopoverProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    opener.current = document.activeElement as HTMLElement | null;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        opener.current?.focus();
      }
    };
    const onClick = (event: MouseEvent): void => {
      if (wrap.current !== null && !wrap.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('keydown', onKey);
    // Capture, so a click on something that stops propagation still closes it.
    document.addEventListener('mousedown', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick, true);
    };
  }, [open]);

  // Kept inside the viewport. A panel anchored to a control in the middle of a
  // phone's second row would otherwise run past the right edge and push the
  // whole page sideways, which is what the segments control did at 390.
  // Measured on opening and on resize, and moved by a margin rather than a
  // transform, because the arrival animation owns the transform.
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }
    const place = (): void => {
      const box = panel.current;
      if (box === null) {
        return;
      }
      box.style.marginLeft = '0px';
      const gutter =
        Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter')) ||
        16;
      const rect = box.getBoundingClientRect();
      const over = rect.right - (window.innerWidth - gutter);
      const under = gutter - rect.left;
      const shift = over > 0 ? -over : under > 0 ? under : 0;
      box.style.marginLeft = `${shift}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  return (
    <div className={styles.wrap} ref={wrap}>
      {trigger({ open, toggle: () => setOpen((was) => !was) })}
      {open && (
        <div
          ref={panel}
          className={[styles.panel, align === 'left' ? styles.left : ''].filter(Boolean).join(' ')}
          role="group"
          aria-label={label}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}
