// Where the isolated test home keeps the state database; mirrors config/paths.ts (Windows uses LOCALAPPDATA, others XDG_STATE_HOME).
import { join } from 'node:path';

export const stateDbPath = (home) => process.platform === 'win32' ? join(home, 'l', 'weft', 'state', 'weft.db') : join(home, 's', 'weft', 'weft.db');
