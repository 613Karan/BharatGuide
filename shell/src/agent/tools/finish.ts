import { z } from 'zod';
import { checkUserFacingText, citationsFor } from '../guardrails';
import { emitLastVerified, streamAssistant } from '../speak';
import type { ToolDef } from '../types';

const schema = z.object({
  message: z.string().max(600).describe('Short closing summary for the user (optional facts need source_ids)'),
  source_ids: z.array(z.string()).optional(),
});

export const finish: ToolDef<z.infer<typeof schema>> = {
  name: 'finish',
  description: 'End the task with a short summary. Drops any unused typing grant.',
  schema,
  async execute(input, ctx, host) {
    const message = input.message.trim();
    if (message) {
      const check = checkUserFacingText(message, 'ui', input.source_ids, ctx.chunks);
      if (!check.ok) return { error: check.reason };
      const sources = check.isFact ? citationsFor(input.source_ids, ctx.chunks) : undefined;
      await streamAssistant(host, message, sources, ctx.signal);
      if (check.isFact) emitLastVerified(host, ctx, input.source_ids);
    }
    ctx.grants.drop();
    ctx.finished = true;
    return { ok: true, done: true };
  },
};
