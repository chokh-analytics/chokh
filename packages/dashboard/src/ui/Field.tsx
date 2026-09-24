import {
  useId,
  type InputHTMLAttributes,
  type JSX,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

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

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  help?: ReactNode;
  problem?: string;
  options: { value: string; label: string }[];
}

// The same three parts as a Field, around a select.
//
// A native select rather than a listbox of divs, because it is the one control
// that already works on a phone, with a keyboard, with a screen reader and with
// four hundred options in it, and a timezone list is four hundred options.
export function SelectField({
  label,
  help,
  problem,
  options,
  className,
  ...rest
}: SelectFieldProps): JSX.Element {
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
      <select
        id={id}
        className={styles.input}
        aria-describedby={described === '' ? undefined : described}
        aria-invalid={problem === undefined ? undefined : true}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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

interface TextareaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  help?: ReactNode;
  problem?: string;
}

// The same three parts, around a textarea: a list somebody types one entry
// per line, in the mono face so a path reads as a path.
export function TextareaField({
  label,
  help,
  problem,
  className,
  ...rest
}: TextareaFieldProps): JSX.Element {
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
      <textarea
        id={id}
        className={[styles.input, styles.textarea].join(' ')}
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
