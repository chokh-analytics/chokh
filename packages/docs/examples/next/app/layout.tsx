import type { ReactNode } from 'react';
import { Analytics } from '@chokh/next';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics site="my_site" vitals errors />
      </body>
    </html>
  );
}
