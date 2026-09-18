// The Chokh tracker.
//
// This is the shell AN-REPO01 leaves behind: it builds, it ships in the image
// and CI measures it, so the 3 KB budget is enforced from the first commit.
// The behaviour (pageviews, heartbeats, the leave beacon, custom events,
// identify, consent, outbound and download clicks, web vitals) lands in
// AN-TRK01.
(function chokh(window: Window): void {
  void window;
})(window);
