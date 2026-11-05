const configuredDomain = process.env.NEXT_PUBLIC_JITSI_DOMAIN?.trim().toLowerCase();

export const JITSI_DOMAIN = configuredDomain && /^[a-z0-9.-]+$/.test(configuredDomain)
  ? configuredDomain
  : "meet.jit.si";

export function isJitsiMeetingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === JITSI_DOMAIN && url.pathname.length > 1;
  } catch {
    return false;
  }
}

export function createJitsiMeetingUrl(room: string): string {
  return `https://${JITSI_DOMAIN}/${encodeURIComponent(room)}`;
}
