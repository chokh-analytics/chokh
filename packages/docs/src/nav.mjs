// The navigation and the pages, held to each other both ways: a page that is
// in no menu is a page nobody finds, and a menu entry with no page is a link
// to nothing. Throws, naming both lists, when they disagree.
export function checkNav(nav, slugs) {
  const listed = nav.flatMap((group) => group.pages);
  const missing = listed.filter((slug) => !slugs.includes(slug));
  const unlisted = slugs.filter((slug) => !listed.includes(slug));
  if (missing.length > 0 || unlisted.length > 0) {
    throw new Error(
      `The navigation and the pages disagree. In the navigation with no page: ${missing.join(', ') || 'none'}. A page not in the navigation: ${unlisted.join(', ') || 'none'}.`,
    );
  }
  if (new Set(listed).size !== listed.length) {
    throw new Error('A page is named twice in the navigation');
  }
  return listed;
}
