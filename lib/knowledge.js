// Brand knowledge base — the only facts Aria is allowed to state.
// Numbers here are also used by the policy code in tools.js so the prompt
// and the deterministic checks can never drift apart.

export const POLICY = {
  freeShippingThreshold: 499,
  shippingFee: 50,
  deliveryDays: '3 to 5 business days',
  returnWindowDays: 7,
  damageReportHours: 48,
  codLimit: 2500,
};

export const BRAND_KNOWLEDGE = `
BRAND: Aura Skincare is a premium organic Indian skincare brand focused on simple, effective skincare products made with thoughtfully selected ingredients.

SHIPPING: Free delivery on orders above ${POLICY.freeShippingThreshold} rupees. Orders below ${POLICY.freeShippingThreshold} rupees have a ${POLICY.shippingFee} rupee shipping fee. Standard delivery takes ${POLICY.deliveryDays}.

RETURNS & REFUNDS: Returns are accepted within ${POLICY.returnWindowDays} days of delivery, only for unopened, unused products in their original packaging. Damaged or defective products must be reported within ${POLICY.damageReportHours} hours of delivery, with photos, for a replacement.

CANCELLATION: Orders can be cancelled only while their status is Processing. Once an order is Shipped or Out for Delivery it cannot be cancelled; the customer may refuse the delivery at the doorstep instead.

CASH ON DELIVERY: COD is available for orders up to ${POLICY.codLimit} rupees. Customers can pay by cash or UPI at the doorstep.
`.trim();
