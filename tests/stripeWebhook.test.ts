import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { ActivityStore } from "../src/activityStore.js";
import { config } from "../src/config.js";
import type { ContractorCircleBot } from "../src/discord.js";
import { watchContractorCircleMember } from "../src/pendingWelcome.js";
import { createHttpApp } from "../src/server.js";
import { handleStripeWebhook } from "../src/stripeWebhook.js";
import type { AppConfig } from "../src/config.js";
import type { PendingWelcome } from "../src/types.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

const WEBHOOK_SECRET = "whsec_test_contractor_circle";
const CIRCLE_PRICE_ID = "price_circle";
const CIRCLE_PRODUCT_ID = "prod_circle";
const INTENSIVE_PRICE_ID = "price_intensive";

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Stripe Contractor Circle webhook", () => {
  it("rejects missing or invalid Stripe signatures", async () => {
    const ctx = await startTestServer();
    const payload = JSON.stringify(
      makeEvent("checkout.session.completed", circleCheckout("Andrew Ernst", "a.ernst@acernst.com")),
    );

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

  it("ignores non-Contractor Circle payments", async () => {
    const ctx = await startTestServer();
    const response = await postStripeEvent(
      ctx.baseUrl,
      makeEvent("checkout.session.completed", {
        ...circleCheckout("Pat Intensive", "pat@example.com"),
        line_items: {
          object: "list",
          data: [{ price: { id: INTENSIVE_PRICE_ID, product: "prod_intensive" } }],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      ignored: true,
      reason: "Not a Contractor Circle price or product",
    });
    expect(await readPendingWelcomes(ctx.dataDir)).toEqual([]);
  });

  it("adds a pending welcome from a Contractor Circle checkout", async () => {
    const ctx = await startTestServer();
    const response = await postStripeEvent(
      ctx.baseUrl,
      makeEvent(
        "checkout.session.completed",
        circleCheckout("Andrew Ernst", "a.ernst@acernst.com"),
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; pendingWelcomeId?: string };
    expect(body.ok).toBe(true);
    expect(body.pendingWelcomeId).toMatch(/^pending:/);

    const pendingWelcomes = await readPendingWelcomes(ctx.dataDir);
    expect(pendingWelcomes).toHaveLength(1);
    expect(pendingWelcomes[0]).toMatchObject({
      id: body.pendingWelcomeId,
      expectedName: "Andrew Ernst",
      email: "a.ernst@acernst.com",
      contractorCircleMember: true,
      note: "Stripe Contractor Circle Membership active.",
    });
    expect(pendingWelcomes[0]?.keywords).toEqual(
      expect.arrayContaining(["andrew ernst", "andrewernst", "aernst", "acernst", "andrew", "ernst"]),
    );

    const match = await ctx.store.pendingWelcomeForMember({
      username: "aernst",
      displayName: "Andrew",
    });
    expect(match?.id).toBe(pendingWelcomes[0]?.id);
  });

  it("retrieves checkout line items when the event omits them", async () => {
    const dataDir = await makeDataDir();
    const store = new ActivityStore(dataDir);
    const session = circleCheckout("Andrew Ernst", "a.ernst@acernst.com");
    delete (session as { line_items?: unknown }).line_items;
    const event = makeEvent("checkout.session.completed", session);
    const payload = JSON.stringify(event);

    const result = await handleStripeWebhook({
      rawBody: payload,
      signature: Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      config: {
        webhookSecret: WEBHOOK_SECRET,
        contractorCirclePriceIds: [CIRCLE_PRICE_ID],
        contractorCircleProductIds: [CIRCLE_PRODUCT_ID],
      },
      store,
      fetchCheckoutLineItems: async () => [{ price: { id: CIRCLE_PRICE_ID, product: CIRCLE_PRODUCT_ID } }],
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.pendingWelcomeId).toMatch(/^pending:/);
    expect(await readPendingWelcomes(dataDir)).toHaveLength(1);
  });

  it("does not double-add when checkout and subscription events fire for the same email", async () => {
    const ctx = await startTestServer();
    const checkout = await postStripeEvent(
      ctx.baseUrl,
      makeEvent("checkout.session.completed", circleCheckout("Andrew Ernst", "a.ernst@acernst.com")),
    );
    const subscription = await postStripeEvent(
      ctx.baseUrl,
      makeEvent("customer.subscription.created", {
        id: "sub_circle_1",
        object: "subscription",
        customer: {
          id: "cus_circle_1",
          email: "a.ernst@acernst.com",
          name: "Andrew Ernst",
        },
        items: {
          object: "list",
          data: [{ price: { id: CIRCLE_PRICE_ID, product: CIRCLE_PRODUCT_ID } }],
        },
      }),
    );

    expect(checkout.status).toBe(200);
    expect(subscription.status).toBe(200);
    expect(await subscription.json()).toMatchObject({ ok: true, pendingWelcomeId: "pending:a-ernst-acernst-com" });

    const pendingWelcomes = await readPendingWelcomes(ctx.dataDir);
    expect(pendingWelcomes).toHaveLength(1);
    expect(pendingWelcomes[0]?.email).toBe("a.ernst@acernst.com");
  });

  it("keeps watch:member as a manual fallback on the same JSON watchlist", async () => {
    const dir = await makeDataDir();
    const store = new ActivityStore(dir);
    const pending = await watchContractorCircleMember(store, {
      expectedName: "Caleb Morrow",
      email: "caleb@example.com",
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

function circleCheckout(name: string, email: string) {
  return {
    id: `cs_${email.replace(/[^a-z0-9]+/gi, "_")}`,
    object: "checkout.session",
    customer_email: email,
    customer_details: { email, name },
    mode: "subscription",
    payment_status: "paid",
    status: "complete",
    line_items: {
      object: "list",
      data: [{ price: { id: CIRCLE_PRICE_ID, product: CIRCLE_PRODUCT_ID } }],
    },
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

async function postStripeEvent(baseUrl: string, event: ReturnType<typeof makeEvent>) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return fetch(`${baseUrl}/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: payload,
  });
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
