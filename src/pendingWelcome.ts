import type { ActivityStore } from "./activityStore.js";

export const CONTRACTOR_CIRCLE_MEMBERSHIP_NOTE = "Stripe Contractor Circle Membership active.";

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

  return [...new Set(keywords)];
}

export async function watchContractorCircleMember(
  store: ActivityStore,
  input: {
    expectedName: string;
    email?: string;
    keywords?: string[];
  },
) {
  return store.recordPendingWelcome({
    expectedName: input.expectedName,
    email: input.email,
    keywords: [...deriveWatchKeywords(input.expectedName, input.email), ...(input.keywords ?? [])],
    contractorCircleMember: true,
    note: CONTRACTOR_CIRCLE_MEMBERSHIP_NOTE,
  });
}
