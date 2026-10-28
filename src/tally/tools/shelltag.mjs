import assert from 'node:assert/strict';
import { shellTag } from '../collectors/_shell.mjs';
for (const [cmd, tag] of [['cairn waymark search "x"', 'cairn-waymark'], ['node "H:/x/bin/cairn.mjs" waymark context q', 'cairn-waymark'], ['cd a && rg -n foo src', 'shell-search'], ['git grep foo', 'shell-search'], ['ls -la | grep tally', 'shell-search'], ['npm test', null], ['echo finding', null], [undefined, null]]) assert.equal(shellTag(cmd), tag, String(cmd));
console.log('shellTag ok');
