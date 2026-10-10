/** A Planner that replays a fixed script (no LLM) and records every tool result. */
import type { Planner, PlannerDeps } from '../src/agent/planner';
import type { ToolOutput } from '../src/agent/types';

export type Step = { tool: string; input: unknown } | { text: string };

export function scripted(steps: Step[] | ((last: ToolOutput | null, i: number) => Step | null)) {
  const results: ToolOutput[] = [];
  const factory = (deps: PlannerDeps): Planner => ({
    name: 'scripted',
    async run() {
      let last: ToolOutput | null = null;
      for (let i = 0; i < 30; i += 1) {
        const step = typeof steps === 'function' ? steps(last, i) : steps[i];
        if (!step) return;
        if ('text' in step) {
          await deps.onFreeText(step.text);
          return;
        }
        last = await deps.exec(step.tool, step.input);
        results.push(last);
        if (last.stop || (step.tool === 'finish' && !last.error)) return;
      }
    },
    cancel() {},
  });
  return { factory, results };
}
