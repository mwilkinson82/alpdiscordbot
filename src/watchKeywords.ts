const DENIED_WATCH_KEYWORDS = new Set([
  "gmail",
  "googlemail",
  "yahoo",
  "ymail",
  "hotmail",
  "outlook",
  "live",
  "msn",
  "icloud",
  "aol",
  "proton",
  "protonmail",
  "zoho",
  "yandex",
  "gmx",
  "fastmail",
  "tutanota",
  "mail",
  "email",
  "comcast",
  "sbcglobal",
  "att",
  "verizon",
  "rocketmail",
  "mailinator",
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "io",
  "co",
  "uk",
  "us",
  "info",
  "biz",
  "app",
  "dev",
  "xyz",
  "online",
  "shop",
  "cloud",
  "site",
  "www",
]);

export function isDeniedWatchKeyword(keyword: string) {
  return DENIED_WATCH_KEYWORDS.has(keyword.toLowerCase());
}

export function isAllowedWatchKeyword(keyword: string) {
  if (keyword.length < 3) return false;
  if (isDeniedWatchKeyword(keyword)) return false;
  const tokens = keyword.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.some((token) => isDeniedWatchKeyword(token))) return false;
  return true;
}

export function deriveWatchKeywords(expectedName: string, email?: string): string[] {
  const keywords: string[] = [];

  const nameTokens = expectedName
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.replace(/[^a-zA-Z0-9]/g, "").length >= 3);
  keywords.push(...nameTokens);

  const compactName = expectedName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (compactName.length >= 3) {
    keywords.push(compactName);
  }

  const tokens = expectedName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    const initialLast = `${first.charAt(0)}${last}`.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (initialLast.length >= 3) {
      keywords.push(initialLast);
    }
  }

  if (email?.includes("@")) {
    const [local = "", domain = ""] = email.split("@");
    const localCompact = local.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (localCompact.length >= 3) {
      keywords.push(localCompact);
    }
    const domainLabel = (domain.split(".")[0] || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (domainLabel.length >= 3) {
      keywords.push(domainLabel);
    }
  }

  return [...new Set(keywords.filter((keyword) => isAllowedWatchKeyword(keyword)))];
}
