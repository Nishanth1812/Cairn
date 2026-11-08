import { fileURLToPath } from 'node:url';

process.argv[1] = fileURLToPath(new URL('./context.js', import.meta.url));
await import('./context.js');
