import type { ActivityStore } from "./activityStore.js";
import { deriveWatchKeywords } from "./watchKeywords.js";

export const CONTRACTOR_CIRCLE_MEMBERSHIP_NOTE = "Stripe Contractor Circle Membership active.";

export { deriveWatchKeywords } from "./watchKeywords.js";

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
