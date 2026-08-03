/**
 * Lets the test runner follow the source's `.js` import specifiers.
 *
 * Source files import `./sked.js` because that is what the emitted bundle
 * needs; esbuild rewrites the extension to `.ts` when it resolves. Node's
 * type stripping does no such rewriting, so a runtime import between two lib
 * modules would fail to resolve under `node --test` — which is why every
 * cross-file lib import used to have to be type-only.
 *
 * Fifteen lines here are cheaper than either a bundler in the test path or a
 * rule that library code may not import library code.
 */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const candidate = new URL(specifier.slice(0, -'.js'.length) + '.ts', context.parentURL);
      // No `format`: Node infers it from the `.ts` extension, which is what
      // routes the file through type stripping rather than plain ESM parsing.
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
