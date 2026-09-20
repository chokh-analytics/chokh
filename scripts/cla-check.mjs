// Every contributor of a pull request is on the signature list.
//
// ADR-0073 decision 5. Without a contributor licence agreement the company
// loses the right to move a line of the core into packages/ee, or to change the
// licence of a future version, the moment a stranger's patch is in the file.
// That is not a thing anybody notices going wrong; it is a door that quietly
// shuts.
//
// It reads a file in the repository rather than talking to a service. The
// signature is the row the contributor added in their own first pull request,
// and git authorship of that commit is the evidence they added it. Nobody has
// to click anything, nothing is stored anywhere else, and the check works on a
// fork of this repository the same way it works here.
//
// It runs on pull_request and never on pull_request_target. A fork's pull
// request must run with a read-only token and no secrets: pull_request_target
// on unreviewed code from a stranger is how a repository gets taken over, and a
// CLA check is exactly the sort of small trusted job somebody would reach for
// it to write.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNATURES = 'CLA-SIGNATURES.md';

// A bot is not a person and has nothing to license. Listed by name rather than
// by a pattern, because "anything ending in [bot]" is a login somebody can
// register.
const BOTS = new Set(['github-actions[bot]', 'dependabot[bot]', 'renovate[bot]']);

export function readSignatures(source = readFileSync(join(root, SIGNATURES), 'utf8')) {
  const logins = new Set();
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      continue;
    }
    const first = trimmed.split('|')[1]?.trim() ?? '';
    // The header row and the dashes under it are table furniture, not people.
    if (first === '' || first === 'GitHub login' || /^-+$/.test(first)) {
      continue;
    }
    logins.add(first.toLowerCase());
  }
  return logins;
}

export function unsigned(authors, signatures) {
  return [...new Set(authors)]
    .filter((login) => login !== '' && !BOTS.has(login))
    .filter((login) => !signatures.has(login.toLowerCase()));
}

async function authorsFromEvent() {
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  if (eventPath === undefined) {
    throw new Error('Not running on a GitHub event. Pass --authors to check a list by hand.');
  }
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const pull = event.pull_request;
  if (pull === undefined) {
    throw new Error('This event is not a pull request.');
  }

  const authors = [pull.user?.login ?? ''];
  const token = process.env['GITHUB_TOKEN'];
  const response = await fetch(`${pull.commits_url}?per_page=100`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
  if (!response.ok) {
    throw new Error(`Could not read the pull request's commits: ${response.status}`);
  }
  for (const commit of await response.json()) {
    // Only an author GitHub could name. A Co-Authored-By trailer with no
    // account behind it is not somebody who can sign anything, and the person
    // who pushed the commit has already been counted as its author.
    if (typeof commit.author?.login === 'string') {
      authors.push(commit.author.login);
    }
  }
  return authors;
}

function report(authors, signatures) {
  const missing = unsigned(authors, signatures);
  if (missing.length === 0) {
    console.warn(`OK   every contributor has signed the CLA: ${authors.join(', ')}`);
    return 0;
  }
  console.error(`FAIL the CLA is not signed by: ${missing.join(', ')}`);
  console.error('');
  console.error('Add one row to CLA-SIGNATURES.md in this pull request. The agreement is CLA.md,');
  console.error('and the short version is that you keep the copyright in what you write.');
  return 1;
}

// The verify line, on every push rather than on the day a stranger arrives.
//
// A check that has never refused anything is a check nobody knows the shape of.
// This runs a signed login and an invented one through the same function the
// real path uses and fails unless the first passes and the second does not.
function dryRun(signatures) {
  const signed = [...signatures][0];
  if (signed === undefined) {
    console.error(`FAIL ${SIGNATURES} lists nobody, so this check would pass anything.`);
    return 1;
  }
  const stranger = 'nobody-has-ever-signed-this-0000';
  const accepted = unsigned([signed], signatures).length === 0;
  const refused = unsigned([stranger], signatures).length === 1;
  const botsPass = unsigned([...BOTS], signatures).length === 0;

  if (accepted && refused && botsPass) {
    console.warn(
      `OK   the CLA check accepts ${signed}, refuses ${stranger}, and lets bots through.`,
    );
    return 0;
  }
  console.error(
    `FAIL the CLA check is not working: accepted=${accepted} refused=${refused} bots=${botsPass}`,
  );
  return 1;
}

// Only when this file is the program, so a test can import the two functions.
const invoked = process.argv[1];
if (invoked !== undefined && invoked.endsWith('cla-check.mjs')) {
  const argv = process.argv.slice(2);
  const signatures = readSignatures();
  const listed = argv.indexOf('--authors');

  if (argv.includes('--dry-run')) {
    process.exit(dryRun(signatures));
  } else if (listed !== -1) {
    const authors = (argv[listed + 1] ?? '').split(',').map((login) => login.trim());
    process.exit(report(authors, signatures));
  } else {
    try {
      process.exit(report(await authorsFromEvent(), signatures));
    } catch (error) {
      console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
}
