import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface OpenCodeTool { name: 'search_codebase' | 'get_checkpoint'; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] } }
export interface OpenCodeToolState { bypassed: boolean; tools: OpenCodeTool[] }

const tools: OpenCodeTool[] = [
  { name: 'search_codebase', description: 'Search the indexed repository for relevant code.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1 } }, required: ['query'] } },
  { name: 'get_checkpoint', description: 'Retrieve the latest task checkpoint.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
];

export function getOpenCodeToolState(options: { enabled?: boolean; weftAvailable?: boolean } = {}): OpenCodeToolState {
  const bypassed = options.enabled === false || options.weftAvailable === false;
  return { bypassed, tools: bypassed ? [] : tools };
}

export function createOpenCodeManifest(options: { enabled?: boolean; weftAvailable?: boolean } = {}) {
  const state = getOpenCodeToolState(options);
  return { $schema: 'https://opencode.ai/config.json', tools: Object.fromEntries(state.tools.map((tool) => [tool.name, { description: tool.description, input: tool.inputSchema }])), bypassed: state.bypassed };
}
export async function writeOpenCodeManifest(repoRoot: string, options: { enabled?: boolean; weftAvailable?: boolean } = {}): Promise<OpenCodeToolState> {
  const state = getOpenCodeToolState(options);
  if (!state.bypassed) {
    const path = join(repoRoot, '.opencode', 'tools', 'weft.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(createOpenCodeManifest(options), null, 2)}\n`, 'utf8');
  }
  return state;
}
