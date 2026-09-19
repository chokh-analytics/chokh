import { useId, type InputHTMLAttributes, type JSX, type ReactNode } from 'react';

import styles from './Field.module.css';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  help?: ReactNode;
  problem?: string;
}

// A label, an input, and the sentence underneath that says what the input is
// for. The label is tied to the input by a generated id and the help by
// aria-describedby, so a screen reader reads the same three things in the same
// order a pair of eyes does.
export function Field({ label, help, problem, className, ...rest }: FieldProps): JSX.Element {
  const id = useId();
  const helpId = `${id}-help`;
  const problemId = `${id}-problem`;
  const described = [help === undefined ? '' : helpId, problem === undefined ? '' : problemId]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={[styles.field, className ?? ''].filter(Boolean).join(' ')}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        aria-describedby={described === '' ? undefined : described}
        aria-invalid={problem === undefined ? undefined : true}
        {...rest}
      />
      {help !== undefined && (
        <p className={styles.help} id={helpId}>
          {help}
        </p>
      )}
      {problem !== undefined && (
        <p className={styles.problem} id={problemId} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
