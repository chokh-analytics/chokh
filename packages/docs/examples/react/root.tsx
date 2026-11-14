import type { ReactNode } from 'react';
import { ChokhProvider } from '@chokh/react';

export function Root({ children }: { children: ReactNode }) {
  return (
    <ChokhProvider site="my_site" src="https://analytics.example.com/a.js" vitals errors>
      {children}
    </ChokhProvider>
  );
}
