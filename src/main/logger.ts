import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentState, LogRecord, ToolCall, ToolResult, TypingGrant } from '../shared/types';

export interface LoggerOptions {
  /** Directory for the JSONL log file. Created if missing. */
  dir: string;
  fileName?: string;
  echoToConsole?: boolean;
}

/**
 * Append-only, timestamped log of every tool call, state change and result
 * (spec section 10: "Log every tool call, state and result locally with a
 * timestamp"). Records are also kept in memory so tests can assert on them.
 */
export class Logger {
  readonly filePath: string;
  private readonly records: LogRecord[] = [];
  private readonly echoToConsole: boolean;

  constructor(options: LoggerOptions) {
    fs.mkdirSync(options.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(options.dir, options.fileName ?? `ghost-cursor-${stamp}.jsonl`);
    this.echoToConsole = options.echoToConsole ?? true;
    fs.writeFileSync(this.filePath, '', 'utf8');
  }

  get all(): readonly LogRecord[] {
    return this.records;
  }

  /** Records of one kind, in order. Used by tests and by the exit checks. */
  recordsOf(kind: LogRecord['kind']): LogRecord[] {
    return this.records.filter((record) => record.kind === kind);
  }

  log(
    kind: LogRecord['kind'],
    message: string,
    data?: Record<string, unknown>,
    level: LogRecord['level'] = 'info',
  ): LogRecord {
    const record: LogRecord = { at: new Date().toISOString(), level, kind, message, data };
    this.records.push(record);
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // Logging must never crash the agent; the in-memory copy still records it.
    }
    if (this.echoToConsole) {
      const suffix = data ? ' ' + JSON.stringify(data) : '';
      // eslint-disable-next-line no-console
      console.log(`[${record.at}] ${kind}: ${message}${suffix}`);
    }
    return record;
  }

  info(kind: LogRecord['kind'], message: string, data?: Record<string, unknown>): LogRecord {
    return this.log(kind, message, data, 'info');
  }

  warn(kind: LogRecord['kind'], message: string, data?: Record<string, unknown>): LogRecord {
    return this.log(kind, message, data, 'warn');
  }

  error(kind: LogRecord['kind'], message: string, data?: Record<string, unknown>): LogRecord {
    return this.log(kind, message, data, 'error');
  }

  toolCall(call: ToolCall, context: Record<string, unknown>): LogRecord {
    return this.log('tool_call', `planner called ${call.tool}`, { call, ...context });
  }

  toolResult(result: ToolResult): LogRecord {
    return this.log(
      'tool_result',
      `${result.tool} ${result.ok ? 'succeeded' : 'failed'}`,
      { result },
      result.ok ? 'info' : 'warn',
    );
  }

  denied(call: ToolCall, reason: string): LogRecord {
    return this.log('denied', `${call.tool} rejected by guardrails`, { call, reason }, 'warn');
  }

  stateChange(from: AgentState, to: AgentState, trigger: string): LogRecord {
    return this.log('state', `${from} -> ${to}`, { from, to, trigger });
  }

  grant(action: 'created' | 'consumed' | 'dropped' | 'expired', grant: TypingGrant | null, detail?: string): LogRecord {
    return this.log(
      'grant',
      `typing grant ${action}`,
      {
        taskId: grant?.taskId ?? null,
        // The granted title is logged: it is the user's own message, and the log
        // is local. No field values are ever logged.
        text: grant?.text ?? null,
        usesLeft: grant?.usesLeft ?? null,
        detail: detail ?? null,
      },
      action === 'created' ? 'info' : 'warn',
    );
  }

  halt(reason: string): LogRecord {
    return this.log('halt', `agent halted: ${reason}`, { reason }, 'error');
  }
}
