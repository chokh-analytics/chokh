// The API reference page and the OpenAPI file, from the routes and the
// examples api-reference.mjs recorded.
import { allRoutes, jsonSchema } from './api-reference.mjs';

// Who may call a route, from the route table, in words.
function who(needs) {
  switch (needs.kind) {
    case 'public':
      return 'Anybody.';
    case 'share':
      return 'Whoever holds the share link, and its password when it has one.';
    case 'principal':
      return 'Anybody signed in, or any key.';
    case 'person':
      return 'A person signed in. Never a key.';
    case 'site':
      return needs.person === true
        ? `A person signed in with \`${needs.scope}\` on the site. Never a key.`
        : `A session or a key with \`${needs.scope}\` on the site.`;
    case 'teamOwner':
      return 'A person signed in who owns the team. Never a key.';
    case 'anyTeamOwner':
      return 'A person signed in who owns a team. Never a key.';
    case 'register':
      return 'Anybody, for the first account of an install; after that, a person who owns a team.';
    default:
      throw new Error(`No words for ${needs.kind}`);
  }
}

function typeOf(schema) {
  if (schema === undefined) {
    return 'any';
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.map((value) => `\`${value}\``);
    return values.length > 8 ? `one of ${values.slice(0, 8).join(', ')} and more` : `one of ${values.join(', ')}`;
  }
  if (schema.type === 'array') {
    return `a list of ${typeOf(schema.items)}`;
  }
  const choices = schema.anyOf ?? schema.oneOf;
  if (choices !== undefined) {
    return choices
      .map(typeOf)
      .filter((value, index, all) => all.indexOf(value) === index)
      .join(' or ');
  }
  const words = {
    object: 'an object',
    integer: 'a whole number',
    number: 'a number',
    boolean: 'true or false',
    string: 'text',
  };
  return words[schema.type] ?? 'any';
}

function fields(schema) {
  const json = jsonSchema(schema);
  if (json.type !== 'object' || json.properties === undefined) {
    return ['One of these shapes:', '', '```json', JSON.stringify(json, null, 2), '```'].join('\n');
  }
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties)
    .map(([name, inner]) => `- \`${name}\`, ${typeOf(inner)}${required.has(name) ? ', required' : ''}`)
    .join('\n');
}

// An example as it is shown: every list cut to its first three items, so a
// page of examples stays a page.
function shorten(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 3).map(shorten);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shorten(inner)]));
  }
  return value;
}

const INTRO = `---
title: API reference
lead: Every route of the server, who may call it, what it takes, and what it answered on an invented site.
description: The Chokh HTTP API, route by route, generated from the server's own route table and schemas.
---

This page is generated from the server's route table, its schemas and
\`route-docs.ts\` in \`packages/server\` and \`packages/ee\`, and every example
is the answer the real server gave. The same is in [openapi.json](/openapi.json)
for your own tools.

## How to call it

Every answer is JSON in one envelope: \`{ "success": true, "data": ..., "meta": ... }\`,
or \`{ "success": false, "error": { "code", "message", "details" } }\` with
the status that fits. A route that changes something is sent JSON.

A caller is somebody signed in, with the \`chokh_session\` cookie that
signing in sets, or a key, sent as \`Authorization: Bearer <token>\`. A key
carries scopes on one site: \`read:stats\` reads reports, \`read:identity\`
also reads who people are, \`write:events\` sends events from a server, and
\`admin\` changes the site. A route marked Chokh Pro answers only on an
install whose licence key names its feature.

Times are Unix milliseconds. A report's \`from\` and \`to\` also take a date
and time written as ISO 8601.

**About the examples.** They come from Saltwind Coffee, a site invented for
these pages, recorded from the server at noon UTC on 1 October 2026. An id
the server made at random is shown as \`g_example1\` and so on, and every
list is cut to its first three items. Routes of Chokh Pro, a redirect, the
realtime stream, the badge picture and the check a load balancer reads have
no recorded example.`;

export function apiPage(examples) {
  const parts = [INTRO];
  for (const group of allRoutes()) {
    parts.push(`## ${group.group}`);
    for (const route of group.routes) {
      const lines = [`### ${route.method} ${route.url}`, '', route.doc.summary, '', `**Who:** ${who(route.rule.needs)}`];
      if (route.rule.feature !== undefined) {
        lines.push('', `**Chokh Pro:** the \`${route.rule.feature}\` feature.`);
      }
      if (route.doc.query !== undefined) {
        lines.push('', '**Query:**', '', fields(route.doc.query));
      }
      if (route.doc.body !== undefined) {
        lines.push('', '**Body:**', '', fields(route.doc.body));
      }
      const example = examples[route.key];
      if (example !== undefined) {
        const text = typeof example.body === 'string';
        const shown = text
          ? example.body.replace(/\r\n/g, '\n').split('\n').slice(0, 6).join('\n')
          : JSON.stringify(shorten(example.body), null, 2);
        lines.push('', `**Answered ${example.status}:**`, '', `\`\`\`${text ? 'text' : 'json'}`, shown, '```');
      }
      parts.push(lines.join('\n'));
    }
  }
  return `${parts.join('\n\n')}\n`;
}

const FAILURE = {
  type: 'object',
  required: ['success', 'error'],
  properties: {
    success: { type: 'boolean', enum: [false] },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
    },
  },
};

export function openApi(examples) {
  const paths = {};
  for (const group of allRoutes()) {
    for (const route of group.routes) {
      const path = route.url.replace(/:(\w+)/g, '{$1}');
      const parameters = [...route.url.matchAll(/:(\w+)/g)].map(([, name]) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      if (route.doc.query !== undefined) {
        const json = jsonSchema(route.doc.query);
        const required = new Set(json.required ?? []);
        for (const [name, schema] of Object.entries(json.properties ?? {})) {
          parameters.push({ name, in: 'query', required: required.has(name), schema });
        }
      }
      const example = examples[route.key];
      const answered =
        example === undefined
          ? { 200: { description: 'The envelope with the answer.' } }
          : {
              [example.status]: {
                description: 'Recorded on the invented site of the docs.',
                content: {
                  [typeof example.body === 'string' ? 'text/csv' : 'application/json']: { example: example.body },
                },
              },
            };
      paths[path] = {
        ...(paths[path] ?? {}),
        [route.method.toLowerCase()]: {
          summary: route.doc.summary,
          tags: [group.group],
          ...(parameters.length === 0 ? {} : { parameters }),
          ...(route.doc.body === undefined
            ? {}
            : { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(route.doc.body) } } } }),
          responses: {
            ...answered,
            default: {
              description: 'A refusal, in the envelope.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Failure' } } },
            },
          },
          'x-chokh-who': who(route.rule.needs),
          ...(route.rule.feature === undefined ? {} : { 'x-chokh-feature': route.rule.feature }),
        },
      };
    }
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Chokh',
      version: '0.1.0',
      description: "The HTTP API of a Chokh install, generated from the server's route table and schemas.",
    },
    servers: [{ url: 'https://analytics.example.com' }],
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'chokh_session' },
        key: { type: 'http', scheme: 'bearer' },
      },
      schemas: { Failure: FAILURE },
    },
    security: [{ session: [] }, { key: [] }],
    paths,
  };
}
