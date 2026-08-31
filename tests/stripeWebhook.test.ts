import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { ActivityStore } from "../src/activityStore.js";
import { config } from "../src/config.js";
import type { AppConfig } from "../src/config.js";
import type { ContractorCircleBot } from "../src/discord.js";
import { watchContractorCircleMember } from "../src/pendingWelcome.js";
import { createHttpApp } from "../src/server.js";
import { handleStripeWebhook, type StripeLookups } from "../src/stripeWebhook.js";
import type { PendingWelcome } from "../src/types.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

const WEBHOOK_SECRET = "whsec_test_contractor_circle";
const CIRCLE_PRICE_ID = "price_circle";
const CIRCLE_PRODUCT_ID = "prod_circle";
const INTENSIVE_PRICE_ID = "price_intensive";
const INTENSIVE_PRODUCT_ID = "prod_intensive";

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Stripe Contractor Circle webhook", () => {
  it("rejects missing or invalid Stripe signatures", async () => {
    const ctx = await startTestServer();
    const payload = JSON.stringify(makeEvent("checkout.session.completed", productionCheckout()));

    const missing = await fetch(`${ctx.baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ ok: false, error: "Missing Stripe-Signature header" });

    const invalid = await fetch(`${ctx.baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=not-a-real-signature",
      },
      body: payload,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, error: "Invalid Stripe signature" });

    expect(await readPendingWelcomes(ctx.dataDir)).toEqual([]);
  });

  it("requires retrieving Checkout line items and ignores non-Circle prices", async () => {
    const dataDir = await makeDataDir();
    const store = new ActivityStore(dataDir);
    const session = productionCheckout("Pat Intensive", "pat@example.com");
    expect(session).not.toHaveProperty("line_items");

    const result = await handleSignedEvent({
      store,
      event: makeEvent("checkout.session.completed", session),
      lookups: mockLookups({
        lineItems: [productionLineItem(INTENSIVE_PRICE_ID, INTENSIVE_PRODUCT_ID)],
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      ignored: true,
      reason: "Not a Contractor Circle price or product",
    });
    expect(await readPendingWelcomes(dataDir)).toEqual([]);
  });

  it("adds a pending welcome after retrieving Circle line items from a minimal Checkout session", async () => {
    const dataDir = await makeDataDir();
    const store = new ActivityStore(dataDir);
    const session = productionCheckout("Andrew Ernst", "a.ernst@acernst.com");
    expect(session).not.toHaveProperty("line_items");

    let retrievedSessionId: string | undefined;
    const result = await handleSignedEvent({
      store,
      event: makeEvent("checkout.session.completed", session),
      lookups: mockLookups({
        lineItems: (sessionId) => {
          retrievedSessionId = sessionId;
          return [productionLineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)];
        },
      }),
    });

    expect(retrievedSessionId).toBe(session.id);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.pendingWelcomeId).toMatch(/^pending:/);

    const pendingWelcomes = await readPendingWelcomes(dataDir);
    expect(pendingWelcomes).toHaveLength(1);
    expect(pendingWelcomes[0]).toMatchObject({
      id: result.body.pendingWelcomeId,
      expectedName: "Andrew Ernst",
      email: "a.ernst@acernst.com",
      contractorCircleMember: true,
      note: "Stripe Contractor Circle Membership active.",
    });
    expect(pendingWelcomes[0]?.keywords).toEqual(
      expect.arrayContaining(["andrew ernst", "andrewernst", "aernst", "acernst", "andrew", "ernst"]),
    );

    const match = await store.pendingWelcomeForMember({
      username: "aernst",
      displayName: "Andrew",
    });
    expect(match?.id).toBe(pendingWelcomes[0]?.id);
  });

  it("does not treat line_items on the Checkout event as production data", async () => {
    const dataDir = await makeDataDir();
    const store = new ActivityStore(dataDir);
    const result = await handleSignedEvent({
      store,
      event: makeEvent("checkout.session.completed", {
        ...productionCheckout(),
        line_items: {
          object: "list",
          data: [productionLineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)],
        },
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      ignored: true,
      reason: "STRIPE_SECRET_KEY is required to identify Checkout line items",
    });
    expect(await readPendingWelcomes(dataDir)).toEqual([]);
  });

  it("retrieves the customer when subscription.created only has a customer id string", async () => {
    const dataDir = await makeDataDir();
    const store = new ActivityStore(dataDir);
    const subscription = productionSubscription("cus_circle_1");
    expect(typeof subscription.customer).toBe("string");
    expect(subscription.customer).toBe("cus_circle_1");

    const result = await handleSignedEvent({
      store,
      event: makeEvent("customer.subscription.created", subscription),
      lookups: mockLookups({
        customers: {
          cus_circle_1: { name: "Andrew Ernst", email: "a.ernst@acernst.com" },
        },
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, pendingWelcomeId: "pending:a-ernst-acernst-com" });
    expect(await readPendingWelcomes(dataDir)).toHaveLength(1);
  });

  it("does not use an expanded customer object on the subscription event", async () => {
    const dataDir = await makeDataDir();
    const store = new ActivityStore(dataDir);
    const result = await handleSignedEvent({
      store,
      event: makeEvent("customer.subscription.created", {
        ...productionSubscription("cus_circle_1"),
        customer: {
          id: "cus_circle_1",
          email: "a.ernst@acernst.com",
          name: "Andrew Ernst",
        },
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.ignored).toBe(true);
    expect(await readPendingWelcomes(dataDir)).toEqual([]);
  });

  it("does not double-add when checkout and subscription events fire for the same email", async () => {
    const dataDir = await makeDataDir();
    const store = new ActivityStore(dataDir);
    const lookups = mockLookups({
      lineItems: [productionLineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)],
      customers: {
        cus_circle_1: { name: "Andrew Ernst", email: "a.ernst@acernst.com" },
      },
    });

    const checkout = await handleSignedEvent({
      store,
      lookups,
      event: makeEvent("checkout.session.completed", productionCheckout("Andrew Ernst", "a.ernst@acernst.com", "cus_circle_1")),
    });
    const subscription = await handleSignedEvent({
      store,
      lookups,
      event: makeEvent("customer.subscription.created", productionSubscription("cus_circle_1")),
    });

    expect(checkout.status).toBe(200);
    expect(subscription.status).toBe(200);
    expect(subscription.body).toMatchObject({ ok: true, pendingWelcomeId: "pending:a-ernst-acernst-com" });
    expect(await readPendingWelcomes(dataDir)).toHaveLength(1);
  });

  it("keeps watch:member as a manual fallback on the same JSON watchlist", async () => {
    const dir = await makeDataDir();
    const store = new ActivityStore(dir);
    const pending = await watchContractorCircleMember(store, {
      expectedName: "Caleb Morrow",
      email: "caleb@acernst.com",
      keywords: ["cmorrow"],
    });

    const pendingWelcomes = await readPendingWelcomes(dir);
    expect(pendingWelcomes).toHaveLength(1);
    expect(pendingWelcomes[0]?.id).toBe(pending.id);
    expect(pendingWelcomes[0]?.keywords).toEqual(expect.arrayContaining(["cmorrow", "caleb", "morrow"]));

    const match = await store.pendingWelcomeForMember({
      username: "cmorrow",
      displayName: "Caleb Morrow",
    });
    expect(match?.id).toBe(pending.id);
  });
});

async function handleSignedEvent(input: {
  store: ActivityStore;
  event: ReturnType<typeof makeEvent>;
  lookups?: StripeLookups;
}) {
  const payload = JSON.stringify(input.event);
  return handleStripeWebhook({
    rawBody: payload,
    signature: Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
    config: {
      webhookSecret: WEBHOOK_SECRET,
      contractorCirclePriceIds: [CIRCLE_PRICE_ID],
      contractorCircleProductIds: [CIRCLE_PRODUCT_ID],
    },
    store: input.store,
    lookups: input.lookups,
  });
}

function mockLookups(options?: {
  lineItems?: unknown[] | ((sessionId: string) => unknown[]);
  customers?: Record<string, { email?: string; name?: string }>;
}): StripeLookups {
  return {
    listCheckoutLineItems: async (sessionId) => {
      const items = options?.lineItems;
      if (typeof items === "function") return items(sessionId);
      return items ?? [];
    },
    retrieveCustomer: async (customerId) => options?.customers?.[customerId],
  };
}

function productionCheckout(name = "Andrew Ernst", email = "a.ernst@acernst.com", customerId = "cus_circle_1") {
  return {
    id: `cs_${email.replace(/[^a-z0-9]+/gi, "_")}`,
    object: "checkout.session",
    customer: customerId,
    customer_email: email,
    customer_details: { email, name },
    mode: "subscription",
    payment_status: "paid",
    status: "complete",
    subscription: "sub_circle_1",
  };
}

function productionSubscription(customerId: string) {
  return {
    id: "sub_circle_1",
    object: "subscription",
    customer: customerId,
    items: {
      object: "list",
      data: [
        {
          id: "si_circle_1",
          object: "subscription_item",
          price: {
            id: CIRCLE_PRICE_ID,
            object: "price",
            product: CIRCLE_PRODUCT_ID,
          },
        },
      ],
    },
  };
}

function productionLineItem(priceId: string, productId: string) {
  return {
    id: `li_${priceId}`,
    object: "item",
    price: {
      id: priceId,
      object: "price",
      product: productId,
    },
    quantity: 1,
  };
}

function makeEvent(type: string, object: Record<string, unknown>) {
  return {
    id: `evt_${type}_${typeof object.id === "string" ? object.id : "x"}`,
    object: "event",
    api_version: "2026-01-28.acacia",
    created: Math.floor(Date.now() / 1000),
    type,
    data: { object },
    livemode: true,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  };
}

async function startTestServer() {
  const dataDir = await makeDataDir();
  const store = new ActivityStore(dataDir);
  const app = createHttpApp(testConfig(), {} as ContractorCircleBot, store);
  const server = await listen(app);
  closers.push(server.close);
  return { ...server, dataDir, store };
}

function testConfig(): AppConfig {
  return {
    ...config,
    stripe: {
      webhookSecret: WEBHOOK_SECRET,
      secretKey: "",
      contractorCirclePriceIds: [CIRCLE_PRICE_ID],
      contractorCircleProductIds: [CIRCLE_PRODUCT_ID],
    },
  };
}

async function readPendingWelcomes(dataDir: string): Promise<PendingWelcome[]> {
  try {
    const raw = await readFile(path.join(dataDir, "activity.json"), "utf8");
    return (JSON.parse(raw).pendingWelcomes ?? []) as PendingWelcome[];
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function makeDataDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "alpdiscordbot-stripe-"));
  dirs.push(dir);
  return dir;
}

function listen(app: ReturnType<typeof createHttpApp>) {
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind test HTTP server."));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
      });
    });
    server.on("error", reject);
  });
}
