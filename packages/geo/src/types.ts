export interface GeoLocation {
  country?: string;
  region?: string;
  city?: string;
  lat?: number;
  lon?: number;
  tz?: string;
}

export interface UserAgentInfo {
  browser?: string;
  browserVersion?: string;
  os?: string;
  osVersion?: string;
  device?: 'desktop' | 'mobile' | 'tablet';
  brand?: string;
  model?: string;
}

// The subset of the Client Hints request headers the collector reads. Only the
// three low entropy ones arrive without the page asking for more, so the rest
// are optional everywhere.
export interface ClientHints {
  ua?: string;
  fullVersionList?: string;
  mobile?: string;
  platform?: string;
  platformVersion?: string;
  model?: string;
}
