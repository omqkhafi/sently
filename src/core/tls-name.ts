/**
 * Decide the TLS SNI name for an SMTP connection.
 *
 * An explicit `servername` is always used. Hostnames are sent as SNI.
 * IP addresses are omitted unless the caller set `servername`.
 *
 * @param host - SMTP host passed to `connect`
 * @param explicit - Caller-supplied `tls.servername`
 */
export function tlsServerName(host: string, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  if (isIpAddress(host)) {
    return undefined;
  }
  return host;
}

/**
 * Whether `host` is an IPv4 or IPv6 literal (optional brackets).
 *
 * @param host - Hostname or address
 */
export function isIpAddress(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    return true;
  }
  return bare.includes(":");
}
