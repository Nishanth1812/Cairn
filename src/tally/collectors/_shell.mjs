// Shell commands carry no tool name, so tag them: 'cairn-waymark' (the index) or 'shell-search' (grep/rg/find…), the adoption metric's two sides.
const WAYMARK = /\bcairn(?:\.mjs)?["']?\s+waymark\b/, SEARCH = /(?:^|[\s|;&(])(?:rg|grep|egrep|fgrep|ag|ack|fd|find|Select-String)\s|git\s+grep/;
export const shellTag = (cmd) => typeof cmd !== 'string' ? null : WAYMARK.test(cmd) ? 'cairn-waymark' : SEARCH.test(cmd) ? 'shell-search' : null;
