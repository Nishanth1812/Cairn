import { performance } from 'node:perf_hooks';

process.env.CAIRN_TIMING_BOOT = String(performance.now());
