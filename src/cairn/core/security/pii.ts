type PIIKind = 'EMAIL' | 'PHONE' | 'SSN';

const piiPatterns: readonly { kind: PIIKind; regex: RegExp }[] = [
  { kind: 'EMAIL', regex: /(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi },
  { kind: 'PHONE', regex: /(?<!\d)(?:\(\d{3}\)[ -]?\d{3}[-. ]?\d{4}|\d{3}[-. ]\d{3}[-. ]\d{4})(?!\d)/g }, // bare 10-digit runs are token counts, epoch seconds and ids, not phones
  { kind: 'SSN', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
];

export class PIIVault {
  private readonly valueToPlaceholder = new Map<PIIKind, Map<string, string>>();
  private readonly placeholderToValue = new Map<string, string>();
  private readonly nextId = new Map<PIIKind, number>();

  mask(text: string): string {
    const matches: { start: number; end: number; value: string; kind: PIIKind }[] = [];
    for (const { kind, regex } of piiPatterns) {
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        if (match.index !== undefined) matches.push({ start: match.index, end: match.index + match[0].length, value: match[0], kind });
      }
    }
    matches.sort((a, b) => a.start - b.start);
    let result = '';
    let cursor = 0;
    for (const match of matches) {
      if (match.start < cursor) continue;
      const values = this.valueToPlaceholder.get(match.kind) ?? new Map<string, string>();
      this.valueToPlaceholder.set(match.kind, values);
      let placeholder = values.get(match.value);
      if (!placeholder) {
        const id = (this.nextId.get(match.kind) ?? 0) + 1;
        this.nextId.set(match.kind, id);
        placeholder = `[${match.kind}_${id}]`;
        values.set(match.value, placeholder);
        this.placeholderToValue.set(placeholder, match.value);
      }
      result += text.slice(cursor, match.start) + placeholder;
      cursor = match.end;
    }
    return result + text.slice(cursor);
  }

  restore(text: string): string {
    return text.replace(/\[(?:EMAIL|PHONE|SSN)_\d+\]/g, (placeholder) => this.placeholderToValue.get(placeholder) ?? placeholder);
  }

  clear(): void {
    this.valueToPlaceholder.clear();
    this.placeholderToValue.clear();
    this.nextId.clear();
  }
}
