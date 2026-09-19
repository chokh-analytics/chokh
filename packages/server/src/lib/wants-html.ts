// Whether a request came from somebody looking at a page rather than from a
// program.
//
// Two places ask it and they have to agree: the not found handler, which serves
// the single page application to a browser and the failure envelope to
// everything else, and the SSO exchange, which redirects a person to the sign
// in page and answers a program with the envelope. A browser that got JSON in
// its address bar and a program that got HTML are the same bug twice.
export function wantsHtml(accept: string | undefined): boolean {
  return accept !== undefined && accept.includes('text/html');
}
