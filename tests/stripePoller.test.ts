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
    expect(await store.getStripePollWatermark()).toBeUndefined();
  });

  it("does not advance a stored watermark when the Stripe key is missing", async () => {
    const { store } = await makeStore();
    const previous = new Date("2026-08-31T08:00:00.000Z");
    await store.setStripePollWatermark(previous);

    const result = await pollStripeCirclePurchases({
      store,
      config: pollerConfig({ secretKey: "" }),
      now: new Date("2026-08-31T16:00:00.000Z"),
    });

    expect(result.skipped).toBe(true);
    expect(await store.getStripePollWatermark()).toEqual(previous);
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

  it("retrieves customer.email when a Circle checkout has a name but no email", async () => {
    const { store, dir } = await makeStore();
    const client = fakeClient({
      sessions: [
        {
          id: "cs_named_no_email",
          customer: "cus_named_no_email",
          customer_details: { name: "Jordan Blake", email: null },
        },
      ],
      lineItems: {
        cs_named_no_email: [lineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)],
      },
      customers: {
        cus_named_no_email: { name: "Jordan Blake", email: "jordan@blakebuild.com" },
      },
    });

    const result = await pollStripeCirclePurchases({
      store,
      config: pollerConfig(),
      client,
    });

    expect(result.added).toBe(1);
    expect(client.retrievedCustomers).toEqual(["cus_named_no_email"]);
    const pending = await readPendingWelcomes(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      expectedName: "Jordan Blake",
      email: "jordan@blakebuild.com",
      contractorCircleMember: true,
    });
  });

  it("does not retrieve a customer for intensives even when checkout email is missing", async () => {
    const { store, dir } = await makeStore();
    const client = fakeClient({
      sessions: [
        {
          id: "cs_intensive",
          customer: "cus_intensive",
          customer_details: { name: "Pat Intensive", email: null },
        },
      ],
      lineItems: {
        cs_intensive: [lineItem(INTENSIVE_PRICE_ID, INTENSIVE_PRODUCT_ID)],
      },
      customers: {
        cus_intensive: { name: "Pat Intensive", email: "pat@example.com" },
      },
    });

    const result = await pollStripeCirclePurchases({
      store,
      config: pollerConfig(),
      client,
    });

    expect(result.added).toBe(0);
    expect(client.retrievedCustomers).toEqual([]);
    expect(await readPendingWelcomes(dir)).toEqual([]);
  });

  it("queues a Circle purchase older than 180 minutes when it is newer than the stored watermark", async () => {
    const { store, dir } = await makeStore();
    const now = new Date("2026-08-31T16:00:00.000Z");
    const watermark = new Date("2026-08-31T08:00:00.000Z");
    const purchaseAt = new Date("2026-08-31T12:00:00.000Z");
    await store.setStripePollWatermark(watermark);

    const client = fakeClient({
      sessions: [
        {
          id: "cs_during_sleep",
          created: unixSeconds(purchaseAt),
          customer: "cus_sleep",
          customer_details: { email: "sleep@acernst.com", name: "Sleep Buyer" },
        },
      ],
      lineItems: {
        cs_during_sleep: [lineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)],
      },
    });

    const result = await pollStripeCirclePurchases({
      store,
      config: pollerConfig({ lookbackMinutes: 180 }),
      client,
      now,
    });

    expect(client.listedCreatedGte[0]).toBe(unixSeconds(watermark));
    expect(result.added).toBe(1);
    expect(await readPendingWelcomes(dir)).toHaveLength(1);
    expect(await store.getStripePollWatermark()).toEqual(now);
  });

  it("caps a first run with no watermark so it does not page the entire Stripe history", async () => {
    const { store, dir } = await makeStore();
    const now = new Date("2026-08-31T16:00:00.000Z");
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const client = fakeClient({
      sessions: [
        {
          id: "cs_eight_days",
          created: unixSeconds(eightDaysAgo),
          customer: "cus_old",
          customer_details: { email: "old@acernst.com", name: "Too Old" },
        },
        {
          id: "cs_two_days",
          created: unixSeconds(twoDaysAgo),
          customer: "cus_recent",
          customer_details: { email: "recent@acernst.com", name: "Within Cap" },
        },
      ],
      lineItems: {
        cs_eight_days: [lineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)],
        cs_two_days: [lineItem(CIRCLE_PRICE_ID, CIRCLE_PRODUCT_ID)],
      },
    });

    const result = await pollStripeCirclePurchases({
      store,
      config: pollerConfig({ lookbackMinutes: 10080 }),
      client,
      now,
    });

    expect(client.listedCreatedGte[0]).toBe(unixSeconds(new Date(now.getTime() - 10080 * 60 * 1000)));
    expect(result.added).toBe(1);
    const pending = await readPendingWelcomes(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.email).toBe("recent@acernst.com");
  });
});

function pollerConfig(overrides: Partial<{ secretKey: string; lookbackMinutes: number }> = {}) {
  return {
    secretKey: overrides.secretKey,
    contractorCirclePriceIds: [CIRCLE_PRICE_ID],
    contractorCircleProductIds: [CIRCLE_PRODUCT_ID],
    lookbackMinutes: overrides.lookbackMinutes ?? 180,
  };
}

function unixSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

function createdOnOrAfter(created: number | undefined, createdGte: number) {
  return created === undefined || created >= createdGte;
}

function fakeClient(options: {
  sessions?: Array<{
    id: string;
    created?: number;
    customer?: string;
    customer_email?: string;
    customer_details?: { email?: string | null; name?: string | null } | null;
  }>;
  lineItems?: Record<string, unknown[]>;
  subscriptions?: Record<string, Array<{ id: string; customer: string; created?: number }>>;
  customers?: Record<string, { email?: string; name?: string }>;
}) {
  const listedCreatedGte: number[] = [];
  const retrievedCustomers: string[] = [];
  const client: StripePurchaseClient & {
    listedCreatedGte: number[];
    retrievedCustomers: string[];
  } = {
    listedCreatedGte,
    retrievedCustomers,
    listCompletedCheckoutSessions: async ({ createdGte }) => {
      listedCreatedGte.push(createdGte);
      return (options.sessions ?? []).filter((session) => createdOnOrAfter(session.created, createdGte));
    },
    listCheckoutLineItems: async (sessionId) => options.lineItems?.[sessionId] ?? [],
    listSubscriptions: async ({ createdGte, priceId }) =>
      (options.subscriptions?.[priceId] ?? []).filter((subscription) =>
        createdOnOrAfter(subscription.created, createdGte),
      ),
    retrieveCustomer: async (customerId) => {
      retrievedCustomers.push(customerId);
      return options.customers?.[customerId];
    },
  };
  return client;
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
