import { hasPromptSearchIntent } from '../hooks/promptIntent.js';

type HookInput = { cwd?: string; prompt?: string; filePath?: string; path?: string; pattern?: string; ranged?: boolean; tool?: string; command?: string; session?: string };
async function readHookInput(timeoutMs = 150): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
  return new Promise((done) => {
    let raw = '';
    const finish = () => { try {
      const parsed = JSON.parse(raw) as { session_id?: unknown; agent_id?: unknown; cwd?: unknown; prompt?: unknown; tool_name?: unknown; tool_input?: { file_path?: unknown; path?: unknown; pattern?: unknown; offset?: unknown; limit?: unknown; command?: unknown } };
      done({ session: typeof parsed.session_id === 'string' ? `${parsed.session_id}-${typeof parsed.agent_id === 'string' ? parsed.agent_id : ''}` : undefined, cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined, prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
        filePath: typeof parsed.tool_input?.file_path === 'string' ? parsed.tool_input.file_path : undefined, path: typeof parsed.tool_input?.path === 'string' ? parsed.tool_input.path : undefined, pattern: typeof parsed.tool_input?.pattern === 'string' ? parsed.tool_input.pattern : undefined, ranged: parsed.tool_input?.offset != null || parsed.tool_input?.limit != null, tool: typeof parsed.tool_name === 'string' ? parsed.tool_name : undefined, command: typeof parsed.tool_input?.command === 'string' ? parsed.tool_input.command : undefined });
    } catch { done({}); } };
    const timer = setTimeout(() => { process.stdin.pause(); finish(); }, timeoutMs);
    process.stdin.setEncoding('utf8').on('data', (chunk: string) => { raw += chunk; }).once('end', () => { clearTimeout(timer); finish(); });
  });
}

// Kept apart from the command router so a hook only loads the modules it needs (every session start and stop pays this).
export async function runHookCommand(event: string | undefined): Promise<{ code: number; data?: string }> {
  const logFailure = async (error: unknown) => { try { const { hookStateDir, logHookFailure } = await import('../hooks/claude.js'); await logHookFailure(hookStateDir(), error); } catch { /* Hooks must remain silent and successful when state storage is unavailable. */ } };
  try {
    if (event !== 'session-start' && event !== 'user-prompt-submit' && event !== 'pre-tool-use' && event !== 'stop' && event !== 'pre-compact') { await logFailure(new Error(`Unknown hook event: ${event ?? ''}`)); return { code: 0 }; }
    // Claude Code sends the event payload as JSON on stdin; only the prompt hook needs it.
    const input: HookInput = event === 'user-prompt-submit' || event === 'pre-tool-use' ? await readHookInput() : {};
    if (event === 'user-prompt-submit' && !hasPromptSearchIntent(input.prompt ?? '')) return { code: 0 };
    const { runHookSafely } = await import('../integrations/claude-code/safeHook.js');
    const data = await runHookSafely(async () => {
      if (event === 'pre-tool-use') { const { hookStateDir } = await import('../hooks/claude.js'); return (await import('../hooks/prompt.js')).runReadNudge({ stateDir: hookStateDir(), cwd: input.cwd, filePath: input.filePath, path: input.path, pattern: input.pattern, ranged: input.ranged, tool: input.tool, command: input.command, session: input.session }); }
      if (event === 'user-prompt-submit') { const { hookStateDir } = await import('../hooks/claude.js'); return (await import('../hooks/prompt.js')).runPromptHook({ stateDir: hookStateDir(), cwd: input.cwd, prompt: input.prompt ?? '' }); }
      if (event === 'session-start') { const [{ hookStateDir, prefetchGitState, runSessionStartHook }, { ensureRepoOnboarded }] = await Promise.all([import('../hooks/claude.js'), import('../onboarding/auto.js')]); prefetchGitState(process.cwd()); const onboarded = await ensureRepoOnboarded(process.cwd(), { spawnIndex: false });
        if (onboarded.reason === 'not-git') return (await import('../onboarding/workspace.js')).workspaceHint(process.cwd(), hookStateDir());
        return runSessionStartHook({ stateDir: hookStateDir(), disableDetachedIndex: true });
      }
      const { hookStateDir, runCheckpointHook } = await import('../hooks/claude.js');
      await runCheckpointHook({ stateDir: hookStateDir() });
      return '';
    }, 400);
    if (data === undefined) await logFailure(new Error(`Hook timed out: ${event} in ${process.cwd()}${input.tool ? `, ${input.tool}` : ''}`));
    return { code: 0, data: data || undefined };
  } catch (error) { await logFailure(error); return { code: 0 }; }
}
