import Stripe from "stripe";
import type { ActivityStore } from "./activityStore.js";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { watchContractorCircleMember } from "./pendingWelcome.js";
import { purchaseMatchesContractorCircle } from "./stripeCircle.js";
import { extractPriceAndProductIds } from "./stripeWebhook.js";

export interface StripePollerConfig {
  secretKey?: string;
  contractorCirclePriceIds: string[];
  contractorCircleProductIds: string[];
  lookbackMinutes: number;
}

export interface CheckoutSessionSummary {
  id: string;
  customer?: string | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
}

export interface SubscriptionSummary {
  id: string;
  customer: string;
}

export interface StripePurchaseClient {
  listCompletedCheckoutSessions(params: { createdGte: number }): Promise<CheckoutSessionSummary[]>;
  listCheckoutLineItems(sessionId: string): Promise<unknown[]>;
  listSubscriptions(params: { createdGte: number; priceId: string }): Promise<SubscriptionSummary[]>;
  retrieveCustomer(customerId: string): Promise<{ email?: string | null; name?: string | null } | undefined>;
}

export interface StripePollResult {
  skipped: boolean;
  added: number;
  examined: number;
}

let missingKeyLogged = false;

export function resetStripePollerMissingKeyLog() {
  missingKeyLogged = false;
}

export function createStripePurchaseClient(secretKey: string): StripePurchaseClient {
  const stripe = new Stripe(secretKey);
  return {
    async listCompletedCheckoutSessions({ createdGte }) {
      const sessions = await collect(
        stripe.checkout.sessions.list({
          limit: 100,
          status: "complete",
          created: { gte: createdGte },
        }),
      );
      return sessions.map((session) => ({
        id: session.id,
        customer: typeof session.customer === "string" ? session.customer : session.customer?.id,
        customer_email: session.customer_email,
        customer_details: session.customer_details
          ? { email: session.customer_details.email, name: session.customer_details.name }
          : null,
      }));
    },
    async listCheckoutLineItems(sessionId) {
      const listed = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 });
      return listed.data as unknown[];
    },
    async listSubscriptions({ createdGte, priceId }) {
      const subscriptions = await collect(
        stripe.subscriptions.list({
          limit: 100,
          price: priceId,
          created: { gte: createdGte },
        }),
      );
      return subscriptions.map((subscription) => ({
        id: subscription.id,
        customer: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
      }));
    },
    async retrieveCustomer(customerId) {
      const customer = await stripe.customers.retrieve(customerId);
      if ("deleted" in customer && customer.deleted) return undefined;
      return { email: customer.email, name: customer.name };
    },
  };
}

export async function pollStripeCirclePurchases(input: {
  store: ActivityStore;
  config: StripePollerConfig;
  client?: StripePurchaseClient;
  now?: Date;
}): Promise<StripePollResult> {
  const client = input.client ?? (input.config.secretKey ? createStripePurchaseClient(input.config.secretKey) : undefined);
  if (!client) {
    if (!missingKeyLogged) {
      logger.info("STRIPE_SECRET_KEY is not set; skipping Contractor Circle Stripe poll.");
      missingKeyLogged = true;
    }
    return { skipped: true, added: 0, examined: 0 };
  }

  const now = input.now ?? new Date();
  const createdGte = await resolveCreatedGte(input.store, now, input.config.lookbackMinutes);
  const configured = {
    priceIds: input.config.contractorCirclePriceIds,
    productIds: input.config.contractorCircleProductIds,
  };

  let examined = 0;
  let added = 0;
  const seenEmails = new Set<string>();

  const checkoutSessions = await client.listCompletedCheckoutSessions({ createdGte });
  for (const session of checkoutSessions) {
    examined += 1;
    const email = firstString(session.customer_details?.email, session.customer_email);
    const nameFromSession = firstString(session.customer_details?.name);
    if (email && (seenEmails.has(email.toLowerCase()) || (await input.store.findPendingWelcomeByEmail(email)))) {
      continue;
    }

    const lineItems = await client.listCheckoutLineItems(session.id);
    if (!purchaseMatchesContractorCircle(extractPriceAndProductIds(lineItems), configured)) {
      continue;
    }

    const customerId = typeof session.customer === "string" ? session.customer : undefined;
    const retrieved =
      customerId && (!email || !nameFromSession) ? await client.retrieveCustomer(customerId) : undefined;
    const name = firstString(nameFromSession, retrieved?.name);
    const resolvedEmail = firstString(email, retrieved?.email);
    const queued = await queueCircleMember(input.store, name, resolvedEmail, seenEmails);
    if (queued) added += 1;
  }

  for (const priceId of configured.priceIds) {
    const subscriptions = await client.listSubscriptions({ createdGte, priceId });
    for (const subscription of subscriptions) {
      examined += 1;
      const customer = await client.retrieveCustomer(subscription.customer);
      const queued = await queueCircleMember(
        input.store,
        customer?.name ?? undefined,
        customer?.email ?? undefined,
        seenEmails,
      );
      if (queued) added += 1;
    }
  }

  if (added > 0) {
    logger.info(`Stripe poll queued ${added} Contractor Circle pending welcome(s).`);
  }

  await input.store.setStripePollWatermark(now);
  return { skipped: false, added, examined };
}

export async function runScheduledStripePoll(appConfig: AppConfig, store: ActivityStore) {
  try {
    await pollStripeCirclePurchases({
      store,
      config: {
        secretKey: appConfig.stripe.secretKey,
        contractorCirclePriceIds: appConfig.stripe.contractorCirclePriceIds,
        contractorCircleProductIds: appConfig.stripe.contractorCircleProductIds,
        lookbackMinutes: appConfig.stripe.lookbackMinutes,
      },
    });
  } catch (error: any) {
    logger.error("Contractor Circle Stripe poll failed.", error?.message);
  }
}

async function queueCircleMember(
  store: ActivityStore,
  name: string | undefined,
  email: string | undefined,
  seenEmails: Set<string>,
) {
  if (!email) return false;
  const normalizedEmail = email.toLowerCase();
  if (seenEmails.has(normalizedEmail)) return false;
  if (await store.findPendingWelcomeByEmail(email)) {
    seenEmails.add(normalizedEmail);
    return false;
  }

  await watchContractorCircleMember(store, {
    expectedName: name || emailLocalPart(email) || email,
    email,
  });
  seenEmails.add(normalizedEmail);
  return true;
}

async function resolveCreatedGte(store: ActivityStore, now: Date, maxLookbackMinutes: number) {
  const watermark = await store.getStripePollWatermark();
  if (watermark) {
    return Math.floor(watermark.getTime() / 1000);
  }
  return Math.floor((now.getTime() - maxLookbackMinutes * 60 * 1000) / 1000);
}

async function collect<T extends { id: string }>(iterator: AsyncIterable<T>, cap = 200): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterator) {
    items.push(item);
    if (items.length >= cap) break;
  }
  return items;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function emailLocalPart(email: string) {
  return email.split("@")[0] || email;
}
