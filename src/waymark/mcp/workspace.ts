import type Database from 'better-sqlite3';
import { createMcpHandler } from './server.js';
import type { WorkspaceRepo } from '../onboarding/workspace.js';

type Args = Record<string, unknown>;
type Reply = { content: Array<{ type: 'text'; text: string }>; isError: boolean };
const reply = (text: string, isError = false): Reply => ({ content: [{ type: 'text', text }], isError });
const textOf = (value: unknown) => ((value as Reply).content?.[0]?.text ?? '');

/** MCP handler for a folder that is not a Git repo but contains several: search tools fan out, reads use `<repo>/<path>`. */
export function createWorkspaceHandler(db: Database.Database, repos: WorkspaceRepo[]) {
  const handlers = new Map(repos.map((repo) => [repo.name, createMcpHandler(db, { id: repo.id, rootPath: repo.rootPath })]));
  const names = repos.map((repo) => repo.name).join(', ');
  return async (method: string, params: Args = {}): Promise<unknown> => {
    if (method !== 'tools/call') {
      const results = await Promise.all([...handlers.values()].map((handle) => handle(method, params)));
      return results[0];
    }
    const name = params.name, args = (params.arguments ?? {}) as Args;
    if (name === 'weft_search' || name === 'weft_context') {
      const sections = await Promise.all(repos.map(async (repo) => {
        const result = await handlers.get(repo.name)!(method, params);
        const text = textOf(result).trim();
        return text ? `## ${repo.name}\n${text.split('\n').map((line) => (/^\S+:\d+/.test(line) ? `${repo.name}/${line}` : line)).join('\n')}` : '';
      }));
      return reply(sections.filter(Boolean).join('\n\n') || 'No matches in this workspace.');
    }
    const repoName = typeof args.repo === 'string' ? args.repo : typeof args.path === 'string' ? args.path.replace(/\\/g, '/').split('/')[0] : '';
    const handle = handlers.get(repoName ?? '');
    if (!handle) return reply(`This folder holds several repositories (${names}). Name one: start the path with it (${repos[0]!.name}/src/file.ts) or pass repo.`, true);
    const rest = name === 'weft_read' ? { ...args, path: String(args.path).replace(/\\/g, '/').split('/').slice(1).join('/') } : args;
    return handle(method, { ...params, arguments: rest });
  };
}
