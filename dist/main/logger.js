"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Append-only, timestamped log of every tool call, state change and result
 * (spec section 10: "Log every tool call, state and result locally with a
 * timestamp"). Records are also kept in memory so tests can assert on them.
 */
class Logger {
    filePath;
    records = [];
    echoToConsole;
    constructor(options) {
        fs.mkdirSync(options.dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = path.join(options.dir, options.fileName ?? `ghost-cursor-${stamp}.jsonl`);
        this.echoToConsole = options.echoToConsole ?? true;
        fs.writeFileSync(this.filePath, '', 'utf8');
    }
    get all() {
        return this.records;
    }
    /** Records of one kind, in order. Used by tests and by the exit checks. */
    recordsOf(kind) {
        return this.records.filter((record) => record.kind === kind);
    }
    log(kind, message, data, level = 'info') {
        const record = { at: new Date().toISOString(), level, kind, message, data };
        this.records.push(record);
        try {
            fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
        }
        catch {
            // Logging must never crash the agent; the in-memory copy still records it.
        }
        if (this.echoToConsole) {
            const suffix = data ? ' ' + JSON.stringify(data) : '';
            // eslint-disable-next-line no-console
            console.log(`[${record.at}] ${kind}: ${message}${suffix}`);
        }
        return record;
    }
    info(kind, message, data) {
        return this.log(kind, message, data, 'info');
    }
    warn(kind, message, data) {
        return this.log(kind, message, data, 'warn');
    }
    error(kind, message, data) {
        return this.log(kind, message, data, 'error');
    }
    toolCall(call, context) {
        return this.log('tool_call', `planner called ${call.tool}`, { call, ...context });
    }
    toolResult(result) {
        return this.log('tool_result', `${result.tool} ${result.ok ? 'succeeded' : 'failed'}`, { result }, result.ok ? 'info' : 'warn');
    }
    denied(call, reason) {
        return this.log('denied', `${call.tool} rejected by guardrails`, { call, reason }, 'warn');
    }
    stateChange(from, to, trigger) {
        return this.log('state', `${from} -> ${to}`, { from, to, trigger });
    }
    grant(action, grant, detail) {
        return this.log('grant', `typing grant ${action}`, {
            taskId: grant?.taskId ?? null,
            // The granted title is logged: it is the user's own message, and the log
            // is local. No field values are ever logged.
            text: grant?.text ?? null,
            usesLeft: grant?.usesLeft ?? null,
            detail: detail ?? null,
        }, action === 'created' ? 'info' : 'warn');
    }
    halt(reason) {
        return this.log('halt', `agent halted: ${reason}`, { reason }, 'error');
    }
}
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map