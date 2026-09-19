// What every component test gets before it starts.
//
// Two things, and the first one is not optional: testing library renders into a
// document that outlives the test unless somebody tears it down, so without
// this a query in the fourth test finds the second test's page and fails with
// "found multiple elements", which reads like a bug in the component.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
