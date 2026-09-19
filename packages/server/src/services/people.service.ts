import {
  gateRealtime,
  gateVisitorProfile,
  identityFieldsOfUser,
  type Gated,
} from '../lib/identity-gate.js';
import { attempt, type Outcome } from '../lib/store-error.js';
import {
  ONLINE_WINDOW_MS,
  type AnalyticsStore,
  type RealtimeSnapshot,
  type UserProfile,
  type VisitorProfile,
} from '../store/AnalyticsStore.js';

// The reads that are about people rather than about traffic: who is here now,
// one visitor's history, one identified person's history, and whether they are
// online.
//
// Every one of them goes through the identity gate, and every one answers with
// the fields that survived it so the caller can write the audit row from the same
// pass. That is the whole reason these four are in one file: they are the four
// places a response can name somebody, and keeping them together is what makes
// "every read that passes the gate writes a row" checkable by reading.

export function realtime(
  store: AnalyticsStore,
  siteId: string,
  identityAllowed: boolean,
): Promise<Outcome<Gated<RealtimeSnapshot>>> {
  return attempt(async () => gateRealtime(await store.realtime(siteId), identityAllowed));
}

export function visitor(
  store: AnalyticsStore,
  siteId: string,
  visitorId: string,
  identityAllowed: boolean,
): Promise<Outcome<Gated<VisitorProfile> | null>> {
  return attempt(async () => {
    const found = await store.visitor(siteId, visitorId);
    return found === null ? null : gateVisitorProfile(found, identityAllowed);
  });
}

// No gate argument: reaching this route at all means naming a person, so the
// route refuses it outright without read:identity rather than answering a
// stripped profile that would be a user lookup with the user taken out.
export function user(
  store: AnalyticsStore,
  siteId: string,
  userId: string,
): Promise<Outcome<Gated<UserProfile> | null>> {
  return attempt(async () => {
    const found = await store.user(siteId, userId);
    return found === null ? null : { value: found, fields: identityFieldsOfUser(found) };
  });
}

// The online badge beside somebody's name.
export interface UserPresence {
  online: boolean;
  // Where they are and when the stay began, present only while they are online.
  page?: string;
  since?: number;
  // The last sign of life, from the presence set while they are online and from
  // their visitor row afterwards. Null for somebody with no history at all.
  lastSeenAt: number | null;
}

export function userPresence(
  store: AnalyticsStore,
  siteId: string,
  userId: string,
): Promise<Outcome<UserPresence | null>> {
  return attempt(async () => {
    // The presence set first, because that is the cheap question and the one the
    // answer usually is: a sorted set read, not an aggregation.
    //
    // The online minute and not the half hour: this answers a yes or no about
    // one person, and reading thirty minutes of everybody to answer it is
    // thirty times the range for the same word. Realtime asks for the whole
    // window because it draws the rest of it.
    const snapshot = await store.realtime(siteId, ONLINE_WINDOW_MS);
    const live = snapshot.visitors
      .filter((candidate) => candidate.userId === userId)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
    if (live !== undefined) {
      const answer: UserPresence = { online: true, since: live.since, lastSeenAt: live.lastSeenAt };
      if (live.path !== undefined) answer.page = live.path;
      return answer;
    }
    // Not online, so the only remaining question is whether they were ever here.
    const profile = await store.user(siteId, userId);
    return profile === null ? null : { online: false, lastSeenAt: profile.lastSeenAt };
  });
}
