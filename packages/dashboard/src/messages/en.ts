// Every English string the dashboard shows lives here, so another language can
// follow without hunting through components. See AGENTS.md section 3.
export const messages = {
  appName: 'Chokh',
  tagline: 'Open source, first-party web analytics.',
  status: 'Pre-release. The dashboard is built in AN-DSH01.',
} as const;

export type Messages = typeof messages;
