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
  fetchCheckoutLineItems?: (sessionId: string) => Promise<unknown[]>;
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

  const ids = await resolvePriceAndProductIds(object, input);
  if (!matchesContractorCircle(ids, input.config)) {
    return ignored("Not a Contractor Circle price or product");
  }

  const member = extractMemberIdentity(object);
  if (!member) {
    return ignored("Missing customer name and email");
  }

  const pending = await watchContractorCircleMember(input.store, member);
  logger.info(`Stripe Contractor Circle purchase queued pending welcome ${pending.id}.`, {
    eventId: event.id,
    eventType: event.type,
    email: member.email,
    expectedName: member.expectedName,
  });

  return {
    status: 200,
    body: { ok: true, pendingWelcomeId: pending.id },
  };
}

export function createCheckoutLineItemFetcher(secretKey: string) {
  const stripe = new Stripe(secretKey);
  return async (sessionId: string) => {
    const listed = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 });
    return listed.data as unknown[];
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
  const customer = asObject(object.customer);
  const metadata = asObject(object.metadata);

  const email = firstString(
    details?.email,
    object.customer_email,
    customer?.email,
    metadata?.email,
  );
  const name = firstString(details?.name, customer?.name, metadata?.name, object.customer_name);

  if (!name && !email) return undefined;

  return {
    expectedName: name || emailLocalPart(email) || email || "Contractor Circle member",
    email,
  };
}

function matchesContractorCircle(
  ids: { priceIds: string[]; productIds: string[] },
  config: StripeWebhookConfig,
) {
  if (!config.contractorCirclePriceIds.length && !config.contractorCircleProductIds.length) {
    logger.warn("Contractor Circle Stripe price/product IDs are not configured; ignoring Stripe events.");
    return false;
  }

  const priceSet = new Set(config.contractorCirclePriceIds);
  const productSet = new Set(config.contractorCircleProductIds);
  return ids.priceIds.some((id) => priceSet.has(id)) || ids.productIds.some((id) => productSet.has(id));
}

async function resolvePriceAndProductIds(
  object: StripeObject,
  input: {
    config: StripeWebhookConfig;
    fetchCheckoutLineItems?: (sessionId: string) => Promise<unknown[]>;
  },
) {
  const fromPayload = extractPriceAndProductIds(object);
  if (fromPayload.priceIds.length || fromPayload.productIds.length) {
    return fromPayload;
  }

  const sessionId = typeof object.id === "string" && object.object === "checkout.session" ? object.id : undefined;
  if (!sessionId) return fromPayload;

  const fetcher =
    input.fetchCheckoutLineItems ||
    (input.config.secretKey ? createCheckoutLineItemFetcher(input.config.secretKey) : undefined);
  if (!fetcher) {
    logger.info("Checkout session has no line items in the event; set STRIPE_SECRET_KEY to retrieve them.");
    return fromPayload;
  }

  const lineItems = await fetcher(sessionId);
  return extractPriceAndProductIds({ line_items: { data: lineItems } });
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
