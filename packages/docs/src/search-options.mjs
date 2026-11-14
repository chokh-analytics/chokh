// How the search index is built and read. One object for both, because an
// index loaded with options other than the ones it was built with answers
// nothing, without saying why.
export const SEARCH_OPTIONS = {
  fields: ['title', 'heading', 'text'],
  storeFields: ['title', 'heading', 'url', 'excerpt'],
  searchOptions: {
    boost: { heading: 3, title: 2 },
    prefix: true,
    fuzzy: 0.2,
  },
};
