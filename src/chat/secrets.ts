/** A profile's ephemeral redaction knowledge survives replacement runtimes, never storage. */
export class SecretRegistry {
  private readonly values = new Set<string>();
  private ordered: string[] = [];
  private matcher: RegExp | null | undefined;

  add(value: string): void {
    if (!value || this.values.has(value)) return;
    this.values.add(value);
    this.matcher = undefined;
    this.ordered = [];
  }

  clear(): void {
    this.values.clear(); this.ordered = []; this.matcher = undefined;
  }

  redact(text: string): string {
    if (!this.values.size || !text) return text;
    if (this.matcher === undefined) {
      this.ordered = [...this.values].sort((a, b) => b.length - a.length);
      // Very large credentials should not require an oversized RegExp to redact short messages.
      if (this.ordered.reduce((size, value) => size + value.length * 2 + 1, 0) > 65_536) this.matcher = null;
      else {
        try { this.matcher = new RegExp(this.ordered.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'); }
        catch { this.matcher = null; }
      }
    }
    if (this.matcher) {
      this.matcher.lastIndex = 0;
      // One pass prevents another short secret from modifying an inserted redaction marker.
      return text.replace(this.matcher, '[redacted]');
    }
    const parts: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      let start = -1;
      let length = 0;
      for (const secret of this.ordered) {
        if (secret.length > text.length - cursor) continue;
        const found = text.indexOf(secret, cursor);
        if (found >= 0 && (start < 0 || found < start || found === start && secret.length > length)) {
          start = found; length = secret.length;
        }
      }
      if (start < 0) break;
      parts.push(text.slice(cursor, start), '[redacted]'); cursor = start + length;
    }
    parts.push(text.slice(cursor));
    return parts.join('');
  }
}
