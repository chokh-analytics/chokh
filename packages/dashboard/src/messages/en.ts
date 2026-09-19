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
    siteOnline: '{count} online',
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

  realtime: {
    title: 'Realtime',
    live: 'Live',
    polling: 'Updating every {seconds}s',
    reconnecting: 'Reconnecting. Updating every {seconds}s meanwhile',
    lastSeen: 'Last seen',
    nobodyOnPage: 'Nobody is on a page right now.',
    nobodyFromCountry: 'Nobody is online right now.',
    perMinute: '{count} per minute now',
    sparkline: 'Pageviews per minute',
    sparklineLabel: '{label}, {total} in the last half hour',
    onPages: 'On these pages',
    fromCountries: 'From these countries',
    whereTheyAre: 'Where they are now',
    mapLabel: '{count} people in {cities} cities',
    mapNote: 'One dot per city, sized by how many people are in it.',
    listCaption: 'Everybody seen in the last half hour.',
    recentHeading: 'Seen in the last 30 minutes',
    visitor: 'Visitor',
    place: 'Location',
    address: 'Address',
    onlineFor: 'Online for',
    nobody: 'Nobody is on the site right now.',
    nobodyLede: 'The last half hour is empty too. The chart above still has its shape.',
  },

  reports: {
    showMore: 'Show up to {count}',
    pagesTitle: 'Pages',
    topPages: 'Top pages',
    tabAll: 'All pages',
    tabEntry: 'Entry',
    tabExit: 'Exit',
    engagement: 'How far people read',
    engagementHelp:
      'Measured when a page is closed. A page nobody has left yet has no number, so a page opened once and still open is absent here rather than a zero.',
    engagementLeaves: 'Exits measured',
    notFound: 'Pages that were not found',
    notFoundHelp:
      'Chokh does not see status codes: a 404 page is a pageview like any other. Send an event named 404 from your not-found page and it is counted here, with the path it happened on in the pages list above.',
    notFoundEmpty: 'No 404 events in this range.',
    notFoundSnippet: 'chokh.event("404")',
    sourcesTitle: 'Sources',
    channels: 'Channels',
    channelsHelp:
      'Where a visit came from, worked out from the referrer and the campaign tags. A visit belongs to exactly one channel.',
    referrers: 'Referrers',
    campaigns: 'Campaigns',
    tabSource: 'Source',
    tabMedium: 'Medium',
    tabCampaign: 'Campaign',
    tabTerm: 'Term',
    tabContent: 'Content',
    geoTitle: 'Geography',
    map: 'Visitors by country',
    mapEmpty: 'No visitors to place in this range.',
    mapLabel: '{count} visitors from {countries} countries',
    mapNote: 'The stronger the colour, the more visitors. Click a country to filter the report.',
    places: 'Places',
    tabCountry: 'Country',
    tabRegion: 'Region',
    tabCity: 'City',
    devicesTitle: 'Devices',
    deviceKinds: 'Devices',
    browsers: 'Browsers',
    systems: 'Operating systems',
    screens: 'Screen widths',
    screensHelp:
      'The browser window when the page loaded, in the buckets a stylesheet usually breaks at.',
    languages: 'Languages',
  },

  people: {
    title: 'People',
    lede: 'Look somebody up by the id your application identified them with, or by the visitor id on a row in Realtime.',
    lookupUser: 'Person',
    lookupUserHelp: 'The id you pass to identify(), usually your own user id.',
    lookupVisitor: 'Visitor',
    lookupVisitorHelp: 'The id Chokh gave a browser. Shown on every row of Realtime.',
    find: 'Look up',
    notFound: 'Nobody here answers to that id.',
    needsScope: 'Looking somebody up by their own id names a person, so it needs the read:identity permission. A visitor id does not.',
    logged: 'This lookup was written to the audit log.',
    profile: 'Profile',
    firstSeen: 'First seen',
    lastSeen: 'Last seen',
    sessions: 'Visits',
    knownAs: 'Known as',
    sameBrowser: 'Browsers',
    addresses: 'Addresses',
    home: 'Usually connects from',
    homeNote: 'The place seen most often on this profile, not a count of visits from it.',
    online: 'Online now',
    onPage: 'Reading {path}',
    lastSeenAgo: 'Last seen {when}',
    hereNow: 'Here in the last half hour',
    hereNowNote: 'Anybody the site has seen in the last thirty minutes. Open one to read their history.',
    nobodyHereNow: 'Nobody has been on the site in the last half hour.',
    stay: 'Visit',
    stayOf: '{count} things over {duration}',
    stayOne: '1 thing',
    expand: 'Show what happened',
    collapse: 'Hide what happened',
    firstTouch: 'First brought here by',
    lastTouch: 'Last brought back by',
    traits: 'What you told us about them',
    timeline: 'What they did',
    timelineNote: 'The last {count} things, newest first. Raw events age out at the site retention, so a profile outlives its own timeline.',
    timelineEmpty: 'Nothing left in the raw events for this person.',
    backToLookup: 'Look somebody else up',
    eventTypes: {
      pageview: 'Read',
      event: 'Did',
      heartbeat: 'Still reading',
      leave: 'Left',
      identify: 'Identified',
      vital: 'Page timing',
    },
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
    note: 'Nothing fires while you are typing, and nothing takes a key the browser already uses.',
    earlier: 'The window before this one',
    later: 'The window after this one',
    compare: 'Turn the comparison on or off',
    clearFilters: 'Clear the filters',
    theme: 'Light or dark',
    help: 'This card',
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
