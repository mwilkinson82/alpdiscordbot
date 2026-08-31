import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityStore } from "../src/activityStore.js";
import {
  DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRICE_ID,
  DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRODUCT_ID,
  resolveContractorCircleIds,
} from "../src/stripeCircle.js";
import {
  pollStripeCirclePurchases,
  resetStripePollerMissingKeyLog,
  type StripePurchaseClient,
} from "../src/stripePoller.js";
import type { PendingWelcome } from "../src/types.js";

const dirs: string[] = [];
const CIRCLE_PRICE_ID = DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRICE_ID;
const CIRCLE_PRODUCT_ID = DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRODUCT_ID;
const INTENSIVE_PRICE_ID = "price_intensive";
const INTENSIVE_PRODUCT_ID = "prod_intensive";

afterEach(async () => {
  resetStripePollerMissingKeyLog();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveContractorCircleIds", () => {
  it("defaults to the confirmed ALPio Circle price and product when env is empty", () => {
    expect(resolveContractorCircleIds([], [])).toEqual({
      priceIds: [DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRICE_ID],
      productIds: [DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRODUCT_ID],
    });
  });

  it("honors explicit price and product IDs from env", () => {
    expect(resolveContractorCircleIds(["price_custom"], ["prod_custom"])).toEqual({
      priceIds: ["price_custom"],
      productIds: ["prod_custom"],
    });
  });
});

describe("Stripe Contractor Circle poller", () => {
  it("skips quietly when STRIPE_SECRET_KEY is missing", async () => {
    const { store, dir } = await makeStore();
    const first = await pollStripeCirclePurchases({
      store,
      config: pollerConfig({ secretKey: "" }),
    });
    const second = await pollStripeCirclePurchases({
      store,
      config: pollerConfig({ secretKey: "" }),
    });

    expect(first).toEqual({ skipped: true, added: 0, examined: 0 });
    expect(second).toEqual({ skipped: true, added: 0, examined: 0 });
    expect(await readPendingWelcomes(dir)).toEqual([]);
  });

  it("queues a pending welcome from a Circle checkout session line-item retrieve", async () => {
    const { store, dir } = await makeStore();
    const client = fakeClient({
      sessions: [
        {
          id: "cs_circle_1",
          customer: "cus_circle_1",
          customer_email: "a.ernst@acernst.com",
          customer_details: { email: "a.ernst@acernst.com", name: "Andrew Ernst" },
        },
      ],
      lineItems: {
        cs_circle_1: [lineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)],
      },
    });

    const result = await pollStripeCirclePurchases({
      store,
      config: pollerConfig(),
      client,
    });

    expect(result.skipped).toBe(false);
    expect(result.added).toBe(1);
    const pending = await readPendingWelcomes(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: "pending:a-ernst-acernst-com",
      expectedName: "Andrew Ernst",
      email: "a.ernst@acernst.com",
      contractorCircleMember: true,
    });
    expect(pending[0]?.keywords).not.toContain("com");
  });

  it("ignores intensives and other ALPio products", async () => {
    const { store, dir } = await makeStore();
    const result = await pollStripeCirclePurchases({
      store,
      config: pollerConfig(),
      client: fakeClient({
        sessions: [
          {
            id: "cs_intensive",
            customer: "cus_intensive",
            customer_details: { email: "pat@example.com", name: "Pat Intensive" },
          },
        ],
        lineItems: {
          cs_intensive: [lineItem(INTENSIVE_PRICE_ID, INTENSIVE_PRODUCT_ID)],
        },
      }),
    });

    expect(result.added).toBe(0);
    expect(await readPendingWelcomes(dir)).toEqual([]);
  });

  it("does not double-add the same email from checkout and subscription polls", async () => {
    const { store, dir } = await makeStore();
    const client = fakeClient({
      sessions: [
        {
          id: "cs_circle_1",
          customer: "cus_circle_1",
          customer_details: { email: "a.ernst@acernst.com", name: "Andrew Ernst" },
        },
      ],
      lineItems: {
        cs_circle_1: [lineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)],
      },
      subscriptions: {
        [CIRCLE_PRICE_ID]: [{ id: "sub_circle_1", customer: "cus_circle_1" }],
      },
      customers: {
        cus_circle_1: { name: "Andrew Ernst", email: "a.ernst@acernst.com" },
      },
    });

    const first = await pollStripeCirclePurchases({ store, config: pollerConfig(), client });
    const second = await pollStripeCirclePurchases({ store, config: pollerConfig(), client });

    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(await readPendingWelcomes(dir)).toHaveLength(1);
  });

  it("retrieves customer identity for Circle subscriptions", async () => {
    const { store, dir } = await makeStore();
    const result = await pollStripeCirclePurchases({
      store,
      config: pollerConfig(),
      client: fakeClient({
        subscriptions: {
          [CIRCLE_PRICE_ID]: [{ id: "sub_rachel", customer: "cus_rachel" }],
        },
        customers: {
          cus_rachel: { name: "Rachel Stone", email: "rachel@gmail.com" },
        },
      }),
    });

    expect(result.added).toBe(1);
    const pending = await readPendingWelcomes(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("pending:rachel-gmail-com");
    expect(pending[0]?.keywords).toEqual(expect.arrayContaining(["rachel", "stone"]));
    expect(pending[0]?.keywords).not.toContain("gmail");
    expect(pending[0]?.keywords).not.toContain("com");

    expect(
      await store.pendingWelcomeForMember({ username: "comfort", displayName: "Company" }),
    ).toBeUndefined();
    expect(
      await store.pendingWelcomeForMember({ username: "rachel", displayName: "Rachel Stone" }),
    ).toMatchObject({ id: pending[0]?.id });
  });

  it("does not reset an already welcomed member when polling again", async () => {
    const { store } = await makeStore();
    const pending = await store.recordPendingWelcome({
      expectedName: "Andrew Ernst",
      email: "a.ernst@acernst.com",
      keywords: ["aernst"],
      contractorCircleMember: true,
    });
    await store.markPendingWelcomeMatched(pending.id, "discord-user-1");

    const result = await pollStripeCirclePurchases({
      store,
      config: pollerConfig(),
      client: fakeClient({
        sessions: [
          {
            id: "cs_circle_1",
            customer: "cus_circle_1",
            customer_details: { email: "a.ernst@acernst.com", name: "Andrew Ernst" },
          },
        ],
        lineItems: {
          cs_circle_1: [lineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)],
        },
      }),
    });

    expect(result.added).toBe(0);
    const stored = await store.findPendingWelcomeByEmail("a.ernst@acernst.com");
    expect(stored?.matchedUserId).toBe("discord-user-1");
    expect(stored?.welcomedAt).toBeTruthy();
  });
});

function pollerConfig(overrides: Partial<{ secretKey: string }> = {}) {
  return {
    secretKey: overrides.secretKey,
    contractorCirclePriceIds: [CIRCLE_PRICE_ID],
    contractorCircleProductIds: [CIRCLE_PRODUCT_ID],
    lookbackMinutes: 180,
  };
}

function fakeClient(options: {
  sessions?: Array<{
    id: string;
    customer?: string;
    customer_email?: string;
    customer_details?: { email?: string | null; name?: string | null } | null;
  }>;
  lineItems?: Record<string, unknown[]>;
  subscriptions?: Record<string, Array<{ id: string; customer: string }>>;
  customers?: Record<string, { email?: string; name?: string }>;
}): StripePurchaseClient {
  return {
    listCompletedCheckoutSessions: async () => options.sessions ?? [],
    listCheckoutLineItems: async (sessionId) => options.lineItems?.[sessionId] ?? [],
    listSubscriptions: async ({ priceId }) => options.subscriptions?.[priceId] ?? [],
    retrieveCustomer: async (customerId) => options.customers?.[customerId],
  };
}

function lineItem(priceId: string, productId: string) {
  return {
    id: `li_${priceId}`,
    price: { id: priceId, product: productId },
    quantity: 1,
  };
}

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "alpdiscordbot-poll-"));
  dirs.push(dir);
  return { store: new ActivityStore(dir), dir };
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
