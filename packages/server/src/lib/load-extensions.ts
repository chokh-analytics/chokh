import type { ServerExtension } from '../plugins/extensions.js';

// The one file in the MIT core that knows packages/ee exists.
//
// It loads a path and not a package name, and that is the whole trick. A
// declared dependency on @chokh/ee would be a cycle, because packages/ee
// depends on this package for the envelope, the scope hook and the extension
// contract; and a package name would tie the load to whatever an installer
// decided to link where. A path next door is true in the workspace, true in
// the image, and true in a checkout where somebody has deleted the directory,
// which is the case that matters most: an install that wants nothing but the
// free product removes packages/ee and everything still builds and boots.
//
// The same relative path works from src/lib and from dist/lib, because both sit
// three levels under packages/.
//
// The import is caught because "not there" is an ordinary state and not an
// error. A self-hoster who never wanted the paid half should not be reading a
// stack trace about it.
//
// Everything else in the core is refused from touching packages/ee by
// scripts/ee-boundary.mjs and by an ESLint rule, with this file as the single
// named exemption. If a second file ever needs the exemption, that is the sign
// the seam is in the wrong place, not that the list needs another row.

const EE_ENTRY = new URL('../../../ee/dist/index.js', import.meta.url);

export interface ExtensionLoad {
  extensions: ServerExtension[];
  // Why there are none, for the boot log. "absent" is a complete install of the
  // free product and not a fault, so it is logged at info and never at warn.
  reason: 'loaded' | 'absent' | 'failed';
  error?: unknown;
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

export async function loadExtensions(entry: URL = EE_ENTRY): Promise<ExtensionLoad> {
  try {
    const loaded: unknown = await import(entry.href);
    const extension = (loaded as { extension?: ServerExtension }).extension;
    if (extension === undefined) {
      // Present and the wrong shape is a build that went wrong rather than an
      // install that chose the free product, so it is reported and not
      // swallowed.
      return {
        extensions: [],
        reason: 'failed',
        error: new Error(`${entry.href} exports no extension`),
      };
    }
    return { extensions: [extension], reason: 'loaded' };
  } catch (error) {
    if (isModuleNotFound(error)) {
      return { extensions: [], reason: 'absent' };
    }
    return { extensions: [], reason: 'failed', error };
  }
}
