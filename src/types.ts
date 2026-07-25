export type AdapterId = 'cursor' | 'claude' | 'codex' | 'pi';

export type CanonicalTool =
  | 'terminal' | 'read' | 'edit' | 'write' | 'glob' | 'grep'
  | 'web-search' | 'web-fetch' | 'todo' | 'ask-user' | 'subagent' | 'mcp' | 'other';

// Native stores are private, versioned formats. Adapters validate fields before use.
export type NativeRecord = Record<string, any>;
export type ToolInput = Record<string, any>;

export interface UserEvent { kind: 'user'; ts: string; text: string; }
export interface AssistantTextEvent { kind: 'assistant-text'; ts: string; text: string; }
export interface ThinkingEvent { kind: 'thinking'; ts: string; text: string; signature: string; }
export interface ToolEvent {
  kind: 'tool'; ts: string; tool: CanonicalTool; input: ToolInput;
  output: string; isError: boolean; origName?: string;
}
export interface MarkerEvent { kind: 'marker'; ts: string; text: string; }
export type CanonicalEvent = UserEvent | AssistantTextEvent | ThinkingEvent | ToolEvent | MarkerEvent;

export interface SessionInfo { id: string; title: string; updatedAt: number; count?: number; file?: string; }
export interface ListedSession extends SessionInfo { source: AdapterId; sourceLabel: string; }
export interface ReadSessionResult { title: string; events: CanonicalEvent[]; skipped: Record<string, number>; }
export interface WriteSessionResult { id: string; resumeHint: string; }
export interface WriteSessionMeta { source?: string; sourceModel?: string; }
export interface Adapter {
  id: AdapterId; label: string; available(): boolean; listSessions(cwd: string): SessionInfo[];
  readSession(cwd: string, sessionId: string): ReadSessionResult; writeReady(): string | null;
  writeSession(cwd: string, title: string, events: CanonicalEvent[], meta?: WriteSessionMeta): WriteSessionResult;
  writeNotes?: string[];
}
export interface MigrationStats {
  total: number; user: number; assistantText: number; thinking: number; markers: number;
  tools: Record<string, number>; mcp: Record<string, number>; other: Record<string, number>;
  subagents: number; skipped: Record<string, number>;
}
export interface MigrationResult {
  title: string; stats: MigrationStats; summary: string; reportFile: string;
  targetId: string; resumeHint: string;
}
