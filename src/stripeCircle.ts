export const DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRICE_ID = "price_1TiUlGJdDAUSVXbNQRjv1ntA";
export const DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRODUCT_ID = "prod_UhuaYXyzDSknXg";

export function resolveContractorCircleIds(priceIds: string[], productIds: string[]) {
  return {
    priceIds: priceIds.length ? priceIds : [DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRICE_ID],
    productIds: productIds.length ? productIds : [DEFAULT_STRIPE_CONTRACTOR_CIRCLE_PRODUCT_ID],
  };
}

export function purchaseMatchesContractorCircle(
  found: { priceIds: string[]; productIds: string[] },
  configured: { priceIds: string[]; productIds: string[] },
) {
  const prices = new Set(configured.priceIds);
  const products = new Set(configured.productIds);
  return found.priceIds.some((id) => prices.has(id)) || found.productIds.some((id) => products.has(id));
}
