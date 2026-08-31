import Stripe from "stripe";
import type { ActivityStore } from "./activityStore.js";
import { logger } from "./logger.js";
import { watchContractorCircleMember } from "./pendingWelcome.js";

const HANDLED_EVENT_TYPES = new Set(["checkout.session.completed", "customer.subscription.created"]);

export interface StripeWebhookConfig {
  webhookSecret: string;
  secretKey?: string;
  contractorCirclePriceIds: string[];
  contractorCircleProductIds: string[];
}

export interface StripeLookups {
  listCheckoutLineItems: (sessionId: string) => Promise<unknown[]>;
  retrieveCustomer: (customerId: string) => Promise<{ email?: string | null; name?: string | null } | undefined>;
}

export interface StripeWebhookResult {
  status: number;
  body: {
    ok: boolean;
    error?: string;
    ignored?: boolean;
    reason?: string;
    pendingWelcomeId?: string;
  };
}

type StripeObject = Record<string, unknown>;

export async function handleStripeWebhook(input: {
  rawBody: Buffer | string;
  signature: string | undefined;
  config: StripeWebhookConfig;
  store: ActivityStore;
  lookups?: StripeLookups;
}): Promise<StripeWebhookResult> {
  if (!input.config.webhookSecret) {
    logger.error("STRIPE_WEBHOOK_SECRET is not configured; refusing Stripe webhook.");
    return { status: 401, body: { ok: false, error: "Stripe webhook is not configured" } };
  }

  if (!input.signature) {
    return { status: 400, body: { ok: false, error: "Missing Stripe-Signature header" } };
  }

  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(input.rawBody, input.signature, input.config.webhookSecret);
  } catch (error: any) {
    logger.warn("Stripe webhook signature verification failed.", error?.message);
    return { status: 400, body: { ok: false, error: "Invalid Stripe signature" } };
  }

  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    return ignored(`Unhandled event type ${event.type}`);
  }

  const object = asObject(event.data.object);
  if (!object) {
    return ignored("Event object missing");
  }

  const lookups = input.lookups ?? (input.config.secretKey ? createStripeLookups(input.config.secretKey) : undefined);
  const ids = await resolvePriceAndProductIds(event.type, object, lookups);
  if (!matchesContractorCircle(ids, input.config)) {
    return ignored(ids.reason ?? "Not a Contractor Circle price or product");
  }

  const member = await resolveMemberIdentity(object, lookups);
  if (member?.reason && !member.expectedName && !member.email) {
    return ignored(member.reason);
  }
  if (!member?.expectedName && !member?.email) {
    return ignored("Missing customer name and email");
  }

  const pending = await watchContractorCircleMember(input.store, {
    expectedName: member.expectedName || emailLocalPart(member.email) || member.email || "Contractor Circle member",
    email: member.email,
  });
  logger.info(`Stripe Contractor Circle purchase queued pending welcome ${pending.id}.`, {
    eventId: event.id,
    eventType: event.type,
    email: member.email,
    expectedName: pending.expectedName,
  });

  return {
    status: 200,
    body: { ok: true, pendingWelcomeId: pending.id },
  };
}

export function createStripeLookups(secretKey: string): StripeLookups {
  const stripe = new Stripe(secretKey);
  return {
    async listCheckoutLineItems(sessionId) {
      const listed = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 });
      return listed.data as unknown[];
    },
    async retrieveCustomer(customerId) {
      const customer = await stripe.customers.retrieve(customerId);
      if ("deleted" in customer && customer.deleted) return undefined;
      return { email: customer.email, name: customer.name };
    },
  };
}

export function extractPriceAndProductIds(value: unknown): { priceIds: string[]; productIds: string[] } {
  const priceIds = new Set<string>();
  const productIds = new Set<string>();
  collectStripeIds(value, priceIds, productIds);
  return { priceIds: [...priceIds], productIds: [...productIds] };
}

export function extractMemberIdentity(object: StripeObject): { expectedName: string; email?: string } | undefined {
  const details = asObject(object.customer_details);
  const metadata = asObject(object.metadata);

  const email = firstString(details?.email, object.customer_email, metadata?.email);
  const name = firstString(details?.name, metadata?.name, object.customer_name);

  if (!name && !email) return undefined;

  return {
    expectedName: name || emailLocalPart(email) || email || "Contractor Circle member",
    email,
  };
}

function matchesContractorCircle(
  ids: { priceIds: string[]; productIds: string[]; reason?: string },
  config: StripeWebhookConfig,
) {
  if (ids.reason && !ids.priceIds.length && !ids.productIds.length) {
    return false;
  }
  if (!config.contractorCirclePriceIds.length && !config.contractorCircleProductIds.length) {
    logger.warn("Contractor Circle Stripe price/product IDs are not configured; ignoring Stripe events.");
    return false;
  }

  const priceSet = new Set(config.contractorCirclePriceIds);
  const productSet = new Set(config.contractorCircleProductIds);
  return ids.priceIds.some((id) => priceSet.has(id)) || ids.productIds.some((id) => productSet.has(id));
}

async function resolvePriceAndProductIds(
  eventType: string,
  object: StripeObject,
  lookups: StripeLookups | undefined,
): Promise<{ priceIds: string[]; productIds: string[]; reason?: string }> {
  if (eventType === "checkout.session.completed") {
    const sessionId = typeof object.id === "string" ? object.id : undefined;
    if (!sessionId) {
      return { priceIds: [], productIds: [], reason: "Checkout session id missing" };
    }
    if (!lookups?.listCheckoutLineItems) {
      logger.error("STRIPE_SECRET_KEY is required to retrieve Checkout line items.");
      return {
        priceIds: [],
        productIds: [],
        reason: "STRIPE_SECRET_KEY is required to identify Checkout line items",
      };
    }
    const lineItems = await lookups.listCheckoutLineItems(sessionId);
    return extractPriceAndProductIds(lineItems);
  }

  return extractPriceAndProductIds(object);
}

async function resolveMemberIdentity(
  object: StripeObject,
  lookups: StripeLookups | undefined,
): Promise<{ expectedName?: string; email?: string; reason?: string } | undefined> {
  const fromPayload = extractMemberIdentity(object);
  const payloadName = firstString(asObject(object.customer_details)?.name, object.customer_name);
  if (fromPayload?.email && payloadName) {
    return fromPayload;
  }

  const customerId = typeof object.customer === "string" ? object.customer : undefined;
  if (!customerId) {
    return fromPayload;
  }

  if (!lookups?.retrieveCustomer) {
    if (fromPayload) return fromPayload;
    logger.error("STRIPE_SECRET_KEY is required to retrieve Stripe customer identity.");
    return { reason: "STRIPE_SECRET_KEY is required to retrieve customer identity" };
  }

  const customer = await lookups.retrieveCustomer(customerId);
  const email = firstString(fromPayload?.email, customer?.email);
  const name = firstString(payloadName, customer?.name);

  if (!name && !email) return undefined;

  return {
    expectedName: name || emailLocalPart(email) || email || "Contractor Circle member",
    email,
  };
}

function collectStripeIds(value: unknown, priceIds: Set<string>, productIds: Set<string>, depth = 0) {
  if (!value || depth > 6) return;

  if (typeof value === "string") {
    addStripeId(value, priceIds, productIds);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStripeIds(item, priceIds, productIds, depth + 1);
    return;
  }

  if (typeof value !== "object") return;
  const obj = value as StripeObject;

  addStripeId(obj.id, priceIds, productIds);
  addStripeId(obj.price, priceIds, productIds);
  addStripeId(obj.product, priceIds, productIds);
  addStripeId(obj.price_id, priceIds, productIds);
  addStripeId(obj.product_id, priceIds, productIds);

  const price = asObject(obj.price);
  if (price) {
    addStripeId(price.id, priceIds, productIds);
    addStripeId(price.product, priceIds, productIds);
    const nestedProduct = asObject(price.product);
    if (nestedProduct) addStripeId(nestedProduct.id, priceIds, productIds);
  }

  const product = asObject(obj.product);
  if (product) addStripeId(product.id, priceIds, productIds);

  for (const key of ["data", "line_items", "items", "lines", "display_items", "metadata"]) {
    if (key in obj) collectStripeIds(obj[key], priceIds, productIds, depth + 1);
  }
}

function addStripeId(value: unknown, priceIds: Set<string>, productIds: Set<string>) {
  if (typeof value !== "string") return;
  if (value.startsWith("price_")) priceIds.add(value);
  if (value.startsWith("prod_")) productIds.add(value);
}

function asObject(value: unknown): StripeObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as StripeObject;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function emailLocalPart(email: string | undefined) {
  if (!email?.includes("@")) return undefined;
  return email.split("@")[0] || undefined;
}

function ignored(reason: string): StripeWebhookResult {
  return { status: 200, body: { ok: true, ignored: true, reason } };
}
