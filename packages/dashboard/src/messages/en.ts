// Every English string the dashboard shows lives here, so another language can
// follow without hunting through components. AGENTS.md rule 8.
//
// Three rules the test beside this file holds:
//
// One leaf is one whole sentence or one whole label. Nothing is assembled at a
// call site out of two halves, because the order of those halves is exactly
// what a translation changes.
//
// Interpolation is {name}, resolved by format() below. A string with a value in
// the middle of it is still one string.
//
// Nothing here is HTML or JSX. A message that carries markup is a message a
// translator can break the page with.
//
// metricHelp is not decoration. The most important string in this file is the
// one explaining that visitors over several days is the sum of each day's
// uniques, so a person who came on three days counts three times. A dashboard
// that does not say that is quietly lying about its headline number.

export const messages = {
  app: {
    name: 'Chokh',
    tagline: 'Open source, first-party web analytics.',
    wordmarkAlt: 'Chokh',
  },

  nav: {
    overview: 'Overview',
    realtime: 'Realtime',
    pages: 'Pages',
    sources: 'Sources',
    geo: 'Geo',
    devices: 'Devices',
    people: 'People',
    skipToContent: 'Skip to the report',
    theme: 'Light or dark',
    themeLight: 'Switch to light',
    themeDark: 'Switch to dark',
    shortcuts: 'Keyboard shortcuts',
    account: 'Account',
    copyLink: 'Copy a link to this view',
    copied: 'Link copied.',
    signOut: 'Sign out',
    siteSwitcher: 'Switch site',
    noOtherSites: 'This is the only site you can read.',
  },

  auth: {
    signInTitle: 'Sign in to Chokh',
    signInLede: 'Your own analytics, on your own server.',
    email: 'Email',
    password: 'Password',
    signIn: 'Sign in',
    signingIn: 'Signing in',
    firstAccountPrompt: 'First time here?',
    firstAccountLink: 'Create the owner account',
    createTitle: 'Create the owner account',
    createLede:
      'The first account owns this install. Every account after it is created by an owner.',
    name: 'Name',
    create: 'Create the account',
    alreadyHaveOwner: 'This install already has an owner. Ask them for an account.',
    backToSignIn: 'Back to sign in',
    ssoExpired: 'That sign-in link has expired. Open the dashboard again from where you came.',
    ssoRefused:
      'That sign-in link could not be used. Open the dashboard again from where you came.',
    signedOut: 'You are signed out.',
  },

  range: {
    today: 'Today',
    yesterday: 'Yesterday',
    last7: '7 days',
    last30: '30 days',
    custom: 'Custom',
    customFrom: 'From',
    customTo: 'To',
    apply: 'Apply',
    compare: 'Compare',
    compareOff: 'No comparison',
    comparePrevious: 'Previous period',
    comparePreviousYear: 'Previous year',
    previousLabel: 'Previous period',
    earlier: 'Earlier',
    later: 'Later',
    timezoneNote: 'Times in {timezone}',
    backwards: 'That range ends before it starts.',
    tooLong: 'Chokh keeps at most {days} days, so a longer range has nothing to read.',
    presets: 'Date range',
    interval: 'Interval',
    intervalMinute: 'Minute',
    intervalHour: 'Hour',
    intervalDay: 'Day',
    intervalWeek: 'Week',
    intervalMonth: 'Month',
  },

  metrics: {
    onlineNow: 'Online now',
    visitors: 'Visitors',
    pageviews: 'Pageviews',
    visits: 'Visits',
    viewsPerVisit: 'Views per visit',
    bounceRate: 'Bounce rate',
    avgDuration: 'Avg visit',
    timeOnPage: 'Time on page',
    scrollDepth: 'Scroll depth',
    leaves: 'Exits measured',
    share: 'Share',
    signedInSplit: '{signedIn} signed in, {anonymous} anonymous',
  },

  metricHelp: {
    visitors:
      'Unique people. Over a range of several days this is the sum of each day, so somebody who came on three days counts three times. Within one day it is an exact count.',
    pageviews: 'Every page load, including a person reloading the same page.',
    visits: 'A stay. One person coming back after half an hour of silence is a second visit.',
    viewsPerVisit: 'Pageviews divided by visits.',
    bounceRate: 'The share of visits that read one page and left.',
    avgDuration: 'From the first thing a visitor did to the last, averaged over visits.',
    onlineNow: 'A sign of life in the last minute.',
    timeOnPage:
      'Measured when a page is closed, so the last page of a visit counts too. Pages nobody has closed yet have no number.',
    scrollDepth: 'How far down the page people got, in quarters, when they left it.',
    notForPages:
      'A visit spans pages, so a bounce rate and a visit duration cannot belong to one of them.',
    rawOnly: 'Read from raw events, so this report sees back {days} days and no further.',
  },

  dimensions: {
    page: 'Page',
    entry: 'Entry page',
    exit: 'Exit page',
    referrer: 'Referrer',
    channel: 'Channel',
    country: 'Country',
    region: 'Region',
    city: 'City',
    browser: 'Browser',
    os: 'Operating system',
    device: 'Device',
    screen: 'Screen',
    lang: 'Language',
    event: 'Event',
    utm_source: 'Campaign source',
    utm_medium: 'Campaign medium',
    utm_campaign: 'Campaign',
    utm_term: 'Campaign term',
    utm_content: 'Campaign content',
    bot: 'Crawler',
  },

  channels: {
    direct: 'Direct',
    organic: 'Organic search',
    social: 'Social',
    referral: 'Referral',
    email: 'Email',
    paid: 'Paid',
    ai: 'AI assistants',
  },

  devices: {
    desktop: 'Desktop',
    mobile: 'Mobile',
    tablet: 'Tablet',
  },

  overview: {
    title: 'Overview',
    chartPeak: 'Peak {value} at {when}',
    chartPrevious: '{label}: {value}',
    chartNow: 'now',
    topPages: 'Top pages',
    sources: 'Sources',
    countries: 'Countries',
    deviceTypes: 'Devices',
    viewAllPages: 'View all pages',
    viewAllSources: 'View all sources',
    viewGeography: 'View full geography',
    viewAllDevices: 'View all devices',
  },

  filters: {
    add: 'Add a filter',
    clear: 'Clear filters',
    remove: 'Remove this filter',
    dimension: 'Dimension',
    operator: 'Operator',
    value: 'Value',
    apply: 'Apply',
    is: 'is',
    isNot: 'is not',
    contains: 'contains',
    notFilterable:
      'A stay spans pages, so it cannot be filtered to one entry page, exit page or channel yet.',
    unsupported: 'That filter cannot be answered: {message}',
  },

  states: {
    loading: 'Loading',
    empty: 'Nothing in this range.',
    emptyFiltered: 'No visitors matched these filters.',
    emptyChart: 'No data in this range.',
    noSites: 'No sites yet',
    noSitesLede: 'Add the site you want to measure, then put one line in its pages.',
    waitingTitle: 'Waiting for the first pageview',
    waitingLede: 'Put this in the pages of {domain}, then open one.',
    waitingWatching: 'Watching for it now.',
    firstReceived: 'The first visitor is in. Opening your numbers.',
    error: 'That did not load.',
    errorCode: 'The server said {code}.',
    retry: 'Try again',
    noBaseline: 'no baseline',
    noChange: 'no change',
    notAvailable: 'not available',
    unknown: 'Unknown',
    unknownHelp: 'The browser sent nothing for this one.',
  },

  sites: {
    addTitle: 'Add a site',
    addLede:
      'A name to recognise it by, the domain it runs on, and the zone its days are drawn in.',
    name: 'Name',
    namePlaceholder: 'My site',
    domain: 'Domain',
    domainPlaceholder: 'example.com',
    domainHelp: 'Without the protocol. A key is bound to this domain and works nowhere else.',
    team: 'Team',
    teamHelp: 'Who owns this site. It cannot be moved to another team later.',
    timezone: 'Timezone',
    timezoneHelp:
      'Every day boundary, every rollup and every chart bucket is drawn in this zone. It cannot be changed once there is history.',
    create: 'Add the site',
    creating: 'Adding',
    snippetTitle: 'Put this in your pages',
    snippetLede: 'One line, before the closing body tag, on every page you want measured.',
    copySnippet: 'Copy',
    copySecret: 'Copy the secret',
    snippetCopied: 'Copied.',
    secretTitle: 'Your identify secret',
    secretLede:
      'Shown once and never again. Keep it on your server: it is what signs an identify, and a browser that could read it could name anybody.',
    settings: 'Site settings',
    retention: 'Raw events kept for {days} days',
    visitorIdMode: 'Visitor id: {mode}',
    ipMode: 'Addresses: {mode}',
  },

  identity: {
    columnHidden: 'Addresses are hidden. They need the read:identity permission.',
    granted: 'Addresses are shown because this account has read:identity. Each read is logged.',
    userNeedsScope: 'This lookup names a person, so it needs the read:identity permission.',
    anonymous: 'Visitor',
  },

  a11y: {
    chartLabel: '{metric} by {interval}, {range}',
    rangeFromTo: '{from} to {to}',
    metricHelp: 'What {metric} means',
    chartTable: 'The numbers behind the chart above.',
    bucket: 'Time',
    liveCount: '{count} online now,',
    mainLandmark: 'Report',
    loadingRegion: 'Loading the report',
  },

  shortcuts: {
    title: 'Keyboard shortcuts',
    close: 'Close',
    groupGo: 'Go to',
    groupRange: 'Range',
    groupView: 'View',
  },
} as const;

export type Messages = typeof messages;

// {name} becomes a value. Ten lines, because a message with a number in the
// middle is still one message and must not be two strings joined at a call
// site: the order of those two halves is the first thing a translation changes.
//
// A placeholder nobody supplied is left alone rather than replaced with
// "undefined", so a missing value shows up as itself in a screenshot instead of
// as a word that looks deliberate.
export function format(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
