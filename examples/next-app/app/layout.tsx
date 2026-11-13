import { Analytics } from '@chokh/next';
import type { ReactNode } from 'react';

export const metadata = { title: 'Chokh on Next' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics site="s_next" visitorId="persistent" vitals errors />
      </body>
    </html>
  );
}
