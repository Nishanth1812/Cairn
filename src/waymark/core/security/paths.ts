function normalizePath(path: string): string[] {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part.toLowerCase());
  }
  return parts;
}

export function isSensitivePath(relativePath: string): boolean {
  const parts = normalizePath(relativePath);
  if (parts.some((part) => ['.git', '.hg', '.svn', '.ssh', '.aws', '.gnupg', '.docker', '.kube'].includes(part))) return true;
  return parts.some((part) =>
    part === '.env' || part.startsWith('.env.') || part.endsWith('.env') ||
    /\.(?:pem|key|pkcs12|pfx)$/.test(part) ||
    /^id_(?:rsa|ed25519)/.test(part) ||
    /^.*\.tfstate.*$/.test(part) ||
    part === 'credentials.json' || /^service-account.*\.json$/.test(part),
  );
}

export function shouldExcludePath(relativePath: string): boolean {
  return isSensitivePath(relativePath);
}
