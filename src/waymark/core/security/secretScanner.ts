export interface SecretFinding {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

interface Pattern {
  readonly type: string;
  readonly regex: RegExp;
}

const patterns: readonly Pattern[] = [
  { type: 'pem-private-key', regex: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY-----[\s\S]+?-----END\s+(?:RSA|DSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY-----/g },
  { type: 'github-token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[0-9a-zA-Z]{36,}/g },
  { type: 'github-token', regex: /github_pat_[a-zA-Z0-9_]{82}/g },
  { type: 'api-key-sk', regex: /sk-[a-zA-Z0-9]{20,}/g },
  { type: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/g },
  { type: 'aws-secret-key', regex: /aws_secret_access_key\s*=\s*[a-zA-Z0-9/+=]{40}/gi },
  { type: 'jwt', regex: /eyJ[a-zA-Z0-9_-]{10,}\.(?:[a-zA-Z0-9_-]{10,}\.){1,2}[a-zA-Z0-9_-]{10,}/g },
  { type: 'slack-token', regex: /xox[baprs]-[0-9a-zA-Z-]{10,}/g },
  { type: 'stripe-secret-key', regex: /sk_live_[0-9a-zA-Z]{24,}/g },
  { type: 'stripe-restricted-key', regex: /rk_live_[0-9a-zA-Z]{24,}/g },
  { type: 'gitlab-token', regex: /glpat-[a-zA-Z0-9\-=_]{20,}/g },
  { type: 'gcp-service-account', regex: /"type"\s*:\s*"service_account"/g },
  { type: 'gcp-private-key-id', regex: /"private_key_id"\s*:\s*"[^"]+"/g },
  { type: 'gcp-private-key', regex: /"private_key"\s*:\s*"(?:\\.|[^"\\])*"/g },
  { type: 'google-api-key', regex: /AIza[a-zA-Z0-9_-]{35}/g },
  { type: 'azure-storage-key', regex: /AccountKey=[a-zA-Z0-9+/=]{88}/gi },
  { type: 'digitalocean-token', regex: /do[por]_v1_[a-f0-9]{64}/g },
  { type: 'vault-token', regex: /hvs\.[a-zA-Z0-9_-]{24,}/g },
  { type: 'supabase-key', regex: /sbp_[a-f0-9]{40}/g },
  { type: 'github-app-token', regex: /ghs_[a-zA-Z0-9]{36}/g },
  { type: 'github-oauth-token', regex: /gho_[a-zA-Z0-9]{36}/g },
  { type: 'github-refresh-token', regex: /ghr_[a-zA-Z0-9]{36}/g },
  { type: 'generic-credential', regex: /(?<!REDACTED_)(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*["'][^"']+["']/gi },
  { type: 'generic-credential', regex: /(?<!REDACTED_)(?:api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*\S+/gi },
  { type: 'connection-string', regex: /(?:(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/)[^\s:@/]+:[^\s@/]+@[^\s]*/gi },
  { type: 'connection-string', regex: /[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi },
  { type: 'bearer-token', regex: /Authorization:\s*Bearer\s+[a-zA-Z0-9_\-.]+/gi },
];

const entropyCandidate = /[A-Za-z0-9+/=]{40,}/g;
const entropyHint = /(?:key|secret|token|password|passwd|credential|bearer|session|authorization)\b/i;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { type, regex } of patterns) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const start = match.index;
      if (start !== undefined) findings.push({ type, start, end: start + match[0].length });
    }
  }

  let lineOffset = 0;
  for (const line of text.split(/\r?\n/)) {
    if (entropyHint.test(line)) {
      entropyCandidate.lastIndex = 0;
      for (const match of line.matchAll(entropyCandidate)) {
        if (shannonEntropy(match[0]) <= 4.5) continue;
        const start = lineOffset + (match.index ?? 0);
        findings.push({ type: 'high-entropy-string', start, end: start + match[0].length });
      }
    }
    if (lineOffset + line.length < text.length) {
      lineOffset += line.length + (text.slice(lineOffset + line.length).startsWith('\r\n') ? 2 : 1);
    }
  }

  findings.sort((a, b) => a.start - b.start || b.end - a.end);
  const filtered: SecretFinding[] = [];
  for (const finding of findings) {
    if (!filtered.length || finding.start >= filtered[filtered.length - 1]!.end) filtered.push(finding);
  }
  return filtered;
}

export function containsSecret(text: string): boolean {
  return scanText(text).length > 0;
}

export function redactSecrets(text: string): string {
  const findings = scanText(text);
  let redacted = '';
  let cursor = 0;
  for (const finding of findings) {
    redacted += text.slice(cursor, finding.start) + `[REDACTED_SECRET:${finding.type}]`;
    cursor = finding.end;
  }
  return redacted + text.slice(cursor);
}
