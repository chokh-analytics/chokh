Three modules load-extensions.test.ts imports by path: one that is a working
extension, one that is present and exports the wrong thing, and one that throws
on the way in. They live here rather than in a temp directory because the test
runner only serves files inside the package.

They are .mjs, so tsc ignores them and nothing here reaches dist.
