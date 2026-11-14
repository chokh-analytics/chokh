// Which accounts another application signs in.
//
// The SSO exchange keys the account it provisions on the other application's
// own id for the person, as `sso_<sub>`, and sets that account's place in a
// team from the token on every arrival. So such an account is managed there,
// whole: this product does not give it a role on a single site, does not
// invite its address, and does not let its team role be edited from the Team
// page, because whatever it was given here would outlive a permission the
// other application later takes away (the person arrives as a viewer, and a
// row on one site still shows them addresses).
//
// An account made by registration or by an invitation is `u_<uuid>` and never
// has this prefix.

export const SSO_ACCOUNT_PREFIX = 'sso_';

export function ssoAccountId(sub: string): string {
  return `${SSO_ACCOUNT_PREFIX}${sub}`;
}

export function isSsoManaged(userId: string): boolean {
  return userId.startsWith(SSO_ACCOUNT_PREFIX);
}

// The one refusal for all three: a role on a site, an invitation, an edit of
// the team role.
export const MANAGED_BY_SSO = {
  status: 409,
  code: 'MANAGED_BY_SSO',
  message:
    'That account is signed in by another application, which sets its role on every arrival. Change it there',
} as const;
