import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';

import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'default' | 'quiet';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  // An icon only control still has a name, it is just not drawn. Required
  // rather than optional, because the one that gets forgotten is the one
  // nobody using a screen reader can press.
  label?: string;
  children?: ReactNode;
}

export function Button({
  variant = 'default',
  block = false,
  label,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const iconOnly = children === undefined;
  const classes = [
    styles.button,
    variant === 'primary' ? styles.primary : '',
    variant === 'quiet' ? styles.quiet : '',
    iconOnly ? styles.icon : '',
    block ? styles.block : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
