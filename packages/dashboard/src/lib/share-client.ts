import type { Client } from './client.js';

// The client a shared page reads through (AN-RPT01).
//
// Every report hook asks for `/api/sites/<id>/...`, and the public share
// answers the same reports at `/api/share/<token>/...` with the same query and
// the same shape. Rewriting the path here is what lets the shared page use the
// Overview's own hooks and cards unchanged: the site id in the path is
// whatever the page's synthetic site says, and the token is what the server
// reads. Nothing else about a request changes, which is the point.

const SITE_PATH = /^\/api\/sites\/[^/]+\//;

export function shareClient(base: Client, token: string): Client {
  const rewrite = (path: string): string =>
    path.replace(SITE_PATH, `/api/share/${encodeURIComponent(token)}/`);
  return {
    get: <T,>(path: string, params?: Parameters<Client['get']>[1]) =>
      base.get<T>(rewrite(path), params),
    post: <T,>(path: string, body?: unknown) => base.post<T>(rewrite(path), body),
    put: <T,>(path: string, body?: unknown) => base.put<T>(rewrite(path), body),
    patch: <T,>(path: string, body: unknown) => base.patch<T>(rewrite(path), body),
    delete: <T,>(path: string) => base.delete<T>(rewrite(path)),
    url: (path: string, params?: Parameters<Client['url']>[1]) => base.url(rewrite(path), params),
  };
}
