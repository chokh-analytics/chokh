// Leaving this dashboard for another address: an identity provider's sign-in
// page, and nothing else today.
//
// One object with one method, so the three places that send a browser away
// do it the same way, and so a test can stand in for the address bar: a test
// environment has no navigation to perform, and a page that called
// window.location itself could only be tested by not testing that line.
export const navigation = {
  leave(url: string): void {
    window.location.assign(url);
  },
};
