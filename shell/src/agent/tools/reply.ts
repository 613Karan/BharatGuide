import { z } from 'zod';
import { checkUserFacingText, citationsFor } from '../guardrails';
import { emitLastVerified, streamAssistant } from '../speak';
import type { ToolDef } from '../types';

const schema = z.object({
  text: z.string().min(1).max(1200).describe('One short message: ONE step at a time, plain English, markdown allowed.'),
  kind: z.enum(['ui', 'fact']).describe('"fact" for any form, document, fee, deadline, eligibility rule or step from the sources; "ui" for pure UI guidance like "Click here".'),
  source_ids: z.array(z.string()).optional().describe('Required for facts: ids like "S1" returned by search_docs in this task.'),
});

export const reply: ToolDef<z.infer<typeof schema>> = {
  name: 'reply',
  description:
    'Send one chat message to the user. Facts must cite source_ids from search_docs; the system rejects facts (form IDs, amounts, durations, quoted names) that are not in the cited sources.',
  schema,
  async execute(input, ctx, host) {
    const check = checkUserFacingText(input.text, input.kind, input.source_ids, ctx.chunks);
    if (!check.ok) return { error: check.reason };
    const sources = check.isFact ? citationsFor(input.source_ids, ctx.chunks) : undefined;
    await streamAssistant(host, input.text, sources, ctx.signal);
    if (check.isFact) emitLastVerified(host, ctx, input.source_ids);
    return { ok: true, shown: true };
  },
};
