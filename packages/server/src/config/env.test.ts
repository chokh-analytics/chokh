import { describe, expect, it } from 'vitest';

import { envSchema } from './env.js';

const MONGO = 'mongodb://mongo:27017/chokh';
const POSTGRES = 'postgresql://chokh:secret@postgres:5432/chokh';
const SECRET = 'c'.repeat(32);

// A compose file writing GEOIP_LICENSE_KEY: ${GEOIP_LICENSE_KEY:-} hands over an
// empty string, and an empty string has to mean unset or the server refuses to
// start for a variable nobody was asked to set.
describe('envSchema', () => {
  it('reads an empty optional variable as unset', () => {
    const parsed = envSchema.parse({
      GEOIP_LICENSE_KEY: '',
      MONGODB_URI: '',
      REDIS_URL: '',
      DASHBOARD_DIR: '',
    });

    expect(parsed.GEOIP_LICENSE_KEY).toBeUndefined();
    expect(parsed.MONGODB_URI).toBeUndefined();
    expect(parsed.REDIS_URL).toBeUndefined();
    expect(parsed.DASHBOARD_DIR).toBeUndefined();
  });

  it('falls back to the default when a variable with one arrives empty', () => {
    const parsed = envSchema.parse({ GEOIP_DIR: '', REAL_IP_HEADER: '', TRUST_PROXY: '' });

    expect(parsed.GEOIP_DIR).toBe('./data/geo');
    expect(parsed.REAL_IP_HEADER).toBe('x-forwarded-for');
    expect(parsed.TRUST_PROXY).toEqual([]);
  });

  it('keeps a value that was actually set', () => {
    const parsed = envSchema.parse({
      GEOIP_LICENSE_KEY: 'a-key',
      GEOIP_DIR: '/var/lib/chokh/geo',
      PORT: '4200',
    });

    expect(parsed.GEOIP_LICENSE_KEY).toBe('a-key');
    expect(parsed.GEOIP_DIR).toBe('/var/lib/chokh/geo');
    expect(parsed.PORT).toBe(4200);
  });

  it('reads the trusted proxies as a list, ignoring spacing and empty entries', () => {
    const parsed = envSchema.parse({ TRUST_PROXY: '173.245.48.0/20, 172.30.0.1/32 ,' });

    expect(parsed.TRUST_PROXY).toEqual(['173.245.48.0/20', '172.30.0.1/32']);
  });

  it('holds a campus behind one address by default', () => {
    const parsed = envSchema.parse({});

    // A tab posts three batches a minute, so the default has to carry about a
    // thousand open tabs on one NAT address.
    expect(parsed.COLLECT_RATE_LIMIT_IP).toBe(3000);
    expect(parsed.COLLECT_RATE_LIMIT_SITE).toBe(60000);
  });

  it('takes a rate limit the operator set instead', () => {
    expect(envSchema.parse({ COLLECT_RATE_LIMIT_IP: '120' }).COLLECT_RATE_LIMIT_IP).toBe(120);
  });

  it('refuses a rate limit that would refuse everything', () => {
    expect(() => envSchema.parse({ COLLECT_RATE_LIMIT_IP: '0' })).toThrow();
    expect(() => envSchema.parse({ COLLECT_RATE_LIMIT_IP: '-1' })).toThrow();
  });

  it('reads the real IP header whatever case it was written in', () => {
    expect(envSchema.parse({ REAL_IP_HEADER: 'CF-Connecting-IP' }).REAL_IP_HEADER).toBe(
      'cf-connecting-ip',
    );
  });

  it('refuses a real IP header the collector does not know how to trust', () => {
    expect(() => envSchema.parse({ REAL_IP_HEADER: 'X-Real-IP' })).toThrow();
  });

  // The signed forwarded mode believes a header instead of a peer range, so
  // without the secret it is a header anybody can set and every visitor could
  // claim any address. A boot that cannot do the mode says so rather than doing
  // something weaker under the same name.
  describe('the signed forwarded mode', () => {
    const SECRET = 'test-proxy-secret-not-a-real-key-0000';

    it('refuses the mode without the proxy secret', () => {
      expect(() => envSchema.parse({ REAL_IP_HEADER: 'X-Chokh-Forwarded-For' })).toThrow(
        /CHOKH_PROXY_SECRET/,
      );
      expect(() =>
        envSchema.parse({ REAL_IP_HEADER: 'X-Chokh-Forwarded-For', CHOKH_PROXY_SECRET: '' }),
      ).toThrow(/CHOKH_PROXY_SECRET/);
    });

    it('takes the mode with one', () => {
      const parsed = envSchema.parse({
        REAL_IP_HEADER: 'X-Chokh-Forwarded-For',
        CHOKH_PROXY_SECRET: SECRET,
      });

      expect(parsed.REAL_IP_HEADER).toBe('x-chokh-forwarded-for');
      expect(parsed.CHOKH_PROXY_SECRET).toBe(SECRET);
    });

    it('refuses a secret too short to be one', () => {
      expect(() =>
        envSchema.parse({ REAL_IP_HEADER: 'X-Chokh-Forwarded-For', CHOKH_PROXY_SECRET: 'short' }),
      ).toThrow(/CHOKH_PROXY_SECRET/);
    });

    it('asks nothing of an install that does not use the mode', () => {
      expect(envSchema.parse({}).CHOKH_PROXY_SECRET).toBeUndefined();
      expect(envSchema.parse({ REAL_IP_HEADER: 'CF-Connecting-IP' }).CHOKH_PROXY_SECRET).toBe(
        undefined,
      );
    });
  });

  describe('the API variables', () => {
    it('has a twelve hour session, a five minute SSO token and ten attempts a minute', () => {
      const parsed = envSchema.parse({});

      expect(parsed.SESSION_TTL_HOURS).toBe(12);
      expect(parsed.SSO_MAX_AGE_SECONDS).toBe(300);
      expect(parsed.AUTH_RATE_LIMIT).toBe(10);
      // No SSO secret means POST /api/sso refuses everything, which is the right
      // default: an SSO endpoint nobody configured is an open door.
      expect(parsed.SSO_SECRET).toBeUndefined();
      // Unset means "Secure in production", decided by cookieSecure() rather than
      // here, so a developer on plain http can still sign in.
      expect(parsed.COOKIE_SECURE).toBeUndefined();
    });

    it('takes the values an operator set', () => {
      const parsed = envSchema.parse({
        SESSION_SECRET: 'a'.repeat(32),
        SESSION_TTL_HOURS: '1',
        SSO_SECRET: 'b'.repeat(40),
        SSO_MAX_AGE_SECONDS: '60',
        AUTH_RATE_LIMIT: '3',
        COOKIE_SECURE: 'false',
      });

      expect(parsed.SESSION_TTL_HOURS).toBe(1);
      expect(parsed.SSO_MAX_AGE_SECONDS).toBe(60);
      expect(parsed.AUTH_RATE_LIMIT).toBe(3);
      expect(parsed.COOKIE_SECURE).toBe(false);
    });

    // A short secret is a secret somebody can search for.
    it('refuses a secret too short to be one', () => {
      expect(() => envSchema.parse({ SESSION_SECRET: 'short' })).toThrow();
      expect(() => envSchema.parse({ SSO_SECRET: 'short' })).toThrow();
    });

    it('reads an empty secret as unset rather than as a secret of no length', () => {
      const parsed = envSchema.parse({ SESSION_SECRET: '', SSO_SECRET: '', COOKIE_SECURE: '' });

      expect(parsed.SESSION_SECRET).toBeUndefined();
      expect(parsed.SSO_SECRET).toBeUndefined();
      expect(parsed.COOKIE_SECURE).toBeUndefined();
    });

    // A generated secret is different in every process and after every restart: on
    // one container that signs everybody out on a deploy, and on two it signs half
    // the requests out all the time.
    it('refuses to run in production without a session secret', () => {
      expect(() => envSchema.parse({ NODE_ENV: 'production', MONGODB_URI: MONGO })).toThrow(
        /SESSION_SECRET/,
      );
      expect(
        envSchema.parse({
          NODE_ENV: 'production',
          SESSION_SECRET: 'c'.repeat(32),
          MONGODB_URI: MONGO,
        }).NODE_ENV,
      ).toBe('production');
    });

    it('does not ask a developer for one', () => {
      expect(envSchema.parse({ NODE_ENV: 'development' }).SESSION_SECRET).toBeUndefined();
      expect(envSchema.parse({ NODE_ENV: 'test' }).SESSION_SECRET).toBeUndefined();
    });
  });
});

// One deployment, one database. MONGODB_URI is MongoDB and DATABASE_URL is
// PostgreSQL; a process handed both would have to guess, and one handed
// neither would keep every row in memory until its next restart.
describe('which database', () => {
  const production = { NODE_ENV: 'production', SESSION_SECRET: SECRET };

  it('takes either one', () => {
    expect(envSchema.parse({ ...production, MONGODB_URI: MONGO }).MONGODB_URI).toBe(MONGO);
    expect(envSchema.parse({ ...production, DATABASE_URL: POSTGRES }).DATABASE_URL).toBe(POSTGRES);
    expect(
      envSchema.parse({ ...production, DATABASE_URL: 'postgres://u:p@h/db?sslmode=verify-full' })
        .DATABASE_URL,
    ).toContain('sslmode=verify-full');
  });

  it('refuses both, in every mode, and names the two and what it found', () => {
    for (const mode of ['production', 'development', 'test']) {
      const refused = envSchema.safeParse({
        NODE_ENV: mode,
        SESSION_SECRET: SECRET,
        MONGODB_URI: MONGO,
        DATABASE_URL: POSTGRES,
      });
      expect(refused.success).toBe(false);
      const said = refused.error?.issues.map((issue) => issue.message).join(' ') ?? '';
      expect(said).toContain('MONGODB_URI and DATABASE_URL are both set');
      // Never the values: a connection string carries a password.
      expect(said).not.toContain('secret');
      expect(said).not.toContain('mongo:27017');
    }
  });

  it('refuses neither in production, and names the two and what it found', () => {
    const refused = envSchema.safeParse(production);
    expect(refused.success).toBe(false);
    const said = refused.error?.issues.map((issue) => issue.message).join(' ') ?? '';
    expect(said).toContain('Neither MONGODB_URI nor DATABASE_URL is set');
    expect(said).toContain('lose every row at the next restart');
  });

  it('runs on memory with neither outside production, which is what a laptop wants', () => {
    for (const mode of ['development', 'test']) {
      const parsed = envSchema.parse({ NODE_ENV: mode });
      expect(parsed.MONGODB_URI).toBeUndefined();
      expect(parsed.DATABASE_URL).toBeUndefined();
    }
  });

  it('reads an empty one as unset, the way a compose file hands it over', () => {
    const parsed = envSchema.parse({ ...production, MONGODB_URI: '', DATABASE_URL: POSTGRES });
    expect(parsed.MONGODB_URI).toBeUndefined();
    expect(envSchema.safeParse({ ...production, MONGODB_URI: '', DATABASE_URL: '' }).success).toBe(
      false,
    );
  });

  it('refuses a DATABASE_URL that is not a PostgreSQL URL', () => {
    for (const url of ['mongodb://mongo/chokh', 'mysql://h/db', 'localhost:5432', 'postgres']) {
      expect(() => envSchema.parse({ ...production, DATABASE_URL: url })).toThrow(
        /PostgreSQL connection string/,
      );
    }
  });

  it('takes a pool size and a statement limit, and refuses ones that cannot work', () => {
    const parsed = envSchema.parse({
      ...production,
      DATABASE_URL: POSTGRES,
      DATABASE_POOL_SIZE: '4',
      DATABASE_STATEMENT_TIMEOUT_MS: '5000',
    });
    expect(parsed.DATABASE_POOL_SIZE).toBe(4);
    expect(parsed.DATABASE_STATEMENT_TIMEOUT_MS).toBe(5000);
    const unset = envSchema.parse({ ...production, DATABASE_URL: POSTGRES, DATABASE_POOL_SIZE: '' });
    expect(unset.DATABASE_POOL_SIZE).toBeUndefined();
    expect(unset.DATABASE_STATEMENT_TIMEOUT_MS).toBeUndefined();
    for (const bad of [
      { DATABASE_POOL_SIZE: '0' },
      { DATABASE_POOL_SIZE: '2.5' },
      { DATABASE_POOL_SIZE: 'ten' },
      { DATABASE_STATEMENT_TIMEOUT_MS: '5' },
    ]) {
      expect(envSchema.safeParse({ ...production, DATABASE_URL: POSTGRES, ...bad }).success).toBe(
        false,
      );
    }
  });
});
