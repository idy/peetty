import type { ChatEntry } from './types.ts';

/** Preserve array/entry identities unless complete text actually requires sanitizing. */
export function sanitizeEntries(entries: ChatEntry[], sanitizeText?: (text: string) => string): ChatEntry[] {
  if (!sanitizeText) return entries;
  let changed = false;
  const sanitized = entries.map((entry) => {
    const text = sanitizeText(entry.text);
    if (text === entry.text) return entry;
    changed = true;
    return { ...entry, text };
  });
  return changed ? sanitized : entries;
}

/** An edit carries its original value so a stale view cannot replace a newer edit. */
export interface EntryChange {
  entry: ChatEntry;
  before?: ChatEntry;
}

export function equalEntry(first: ChatEntry, second: ChatEntry): boolean {
  return first.id === second.id && first.role === second.role && first.text === second.text && first.createdAt === second.createdAt;
}

/** Omissions are not deletions. A mutation mask keeps bounded views out of the archive. */
export function entryChanges(previous: readonly ChatEntry[], next: readonly ChatEntry[], changedIds?: readonly string[]): EntryChange[] {
  const known = new Map(previous.map((entry) => [entry.id, entry]));
  const selected = changedIds === undefined ? undefined : new Set(changedIds);
  const changes: EntryChange[] = [];
  for (const entry of next) {
    if (selected && !selected.has(entry.id)) continue;
    const before = known.get(entry.id);
    if (!before || !equalEntry(before, entry)) changes.push({ entry, ...(before ? { before } : {}) });
  }
  return changes;
}

/** Preserve committed order and never reinsert missing edits. Legacy callers may keep last-writer wins. */
export function applyEntryChanges(current: readonly ChatEntry[], changes: readonly EntryChange[], protectEdits = false): ChatEntry[] {
  const pending = new Map(changes.map((change) => [change.entry.id, change]));
  const merged = current.map((entry) => {
    const change = pending.get(entry.id);
    pending.delete(entry.id);
    if (!change || (protectEdits && (!change.before || !equalEntry(entry, change.before)))) return entry;
    return change.entry;
  });
  for (const change of pending.values()) if (!change.before) merged.push(change.entry);
  return merged;
}
