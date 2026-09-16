/**
 * Rotating browser-identity profiles for the stealth fetch client.
 *
 * These exist so requests look like ordinary browser traffic to generic
 * WAF/heuristic filters. They do NOT bypass authentication, paywalls, or
 * access controls — see README "Responsible use".
 */

export interface UaProfile {
  /** Full User-Agent header value. */
  userAgent: string;
  /** sec-ch-ua value; empty for non-Chromium profiles. */
  secChUa: string;
  /** sec-ch-ua-platform value. */
  platform: "Windows" | "macOS" | "Linux" | "";
  mobile: boolean;
  accept: string;
  acceptLanguage: string;
}

const DESKTOP_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";

export const UA_PROFILES: readonly UaProfile[] = [
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: "Windows",
    mobile: false,
    accept: DESKTOP_ACCEPT,
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: "macOS",
    mobile: false,
    accept: DESKTOP_ACCEPT,
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="130", "Google Chrome";v="130", "Not_A Brand";v="99"',
    platform: "Linux",
    mobile: false,
    accept: DESKTOP_ACCEPT,
    acceptLanguage: "en-GB,en;q=0.9,en-US;q=0.8",
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    secChUa: "",
    platform: "",
    mobile: false,
    accept: DESKTOP_ACCEPT,
    acceptLanguage: "en-US,en;q=0.5",
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    secChUa: "",
    platform: "",
    mobile: false,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    secChUa:
      '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: "Windows",
    mobile: false,
    accept: DESKTOP_ACCEPT,
    acceptLanguage: "en-US,en;q=0.9",
  },
];

const CHROMIUM_HINT = /Chrome\/(\d+)\./;

/** Pick a random profile from the pool. */
export function pickProfile(random: () => number = Math.random): UaProfile {
  const idx = Math.floor(random() * UA_PROFILES.length) % UA_PROFILES.length;
  return UA_PROFILES[idx]!;
}

/**
 * Build a profile for a caller-supplied UA string. If it looks like a Chromium
 * UA we synthesize plausible client hints; otherwise hints are omitted.
 */
export function profileForUserAgent(userAgent: string): UaProfile {
  const known = UA_PROFILES.find((p) => p.userAgent === userAgent);
  if (known) return known;
  const m = CHROMIUM_HINT.exec(userAgent);
  const platform = userAgent.includes("Windows")
    ? "Windows"
    : userAgent.includes("Mac")
      ? "macOS"
      : userAgent.includes("Linux") || userAgent.includes("X11")
        ? "Linux"
        : "";
  return {
    userAgent,
    secChUa: m
      ? `"Chromium";v="${m[1]}", "Not_A Brand";v="24"`
      : "",
    platform,
    mobile: /Mobile|Android|iPhone/.test(userAgent),
    accept: DESKTOP_ACCEPT,
    acceptLanguage: "en-US,en;q=0.9",
  };
}

/** Assemble a realistic browser header set (order-preserving). */
export function buildBrowserHeaders(
  profile: UaProfile,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": profile.userAgent,
    accept: profile.accept,
    "accept-language": profile.acceptLanguage,
    "accept-encoding": "gzip, deflate, br",
    "upgrade-insecure-requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    priority: "u=0, i",
  };
  if (profile.secChUa) {
    headers["sec-ch-ua"] = profile.secChUa;
    headers["sec-ch-ua-mobile"] = profile.mobile ? "?1" : "?0";
    headers["sec-ch-ua-platform"] = `"${profile.platform}"`;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      headers[k.toLowerCase()] = v;
    }
  }
  return headers;
}
