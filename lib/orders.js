// Mock order database (from the assignment brief).
// Times are stored relative to "now" so the policy checks stay meaningful
// whenever the demo is run.

export const ORDERS = {
  'ORD-101': {
    order_id: 'ORD-101',
    customer_name: 'Priya Sharma',
    product: 'Vitamin C Serum (30ml)',
    value_inr: 699,
    status: 'Out for Delivery',
    courier: 'BlueDart',
    tracking_id: 'BD-982103',
    notes: 'Expected by 6 PM today',
    delivered_days_ago: null,
  },
  'ORD-102': {
    order_id: 'ORD-102',
    customer_name: 'Rahul Verma',
    product: 'Hydrating Sunscreen SPF 50',
    value_inr: 499,
    status: 'Delivered',
    courier: 'Delhivery',
    tracking_id: 'DL-441029',
    notes: 'Delivered 14 days ago',
    delivered_days_ago: 14,
  },
  'ORD-103': {
    order_id: 'ORD-103',
    customer_name: 'Ananya Patel',
    product: 'Green Tea Face Wash + Toner',
    value_inr: 850,
    status: 'Processing',
    courier: null,
    tracking_id: null,
    notes: 'Ordered 3 hours ago. Eligible for cancellation',
    delivered_days_ago: null,
  },
};

const NUMBER_WORDS = {
  // Deliberately excludes homophones like "to"/"for"/"o" — they show up in
  // normal speech ("order for ORD-101", "O R D") and would corrupt the ID.
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

/**
 * Turn whatever the speech recogniser / LLM produced into a canonical ID.
 * "ORD-101", "ord 101", "order one zero one", "O R D 1 0 1", "101" -> "ORD-101".
 * Returns null when there is no usable number in the input.
 */
export function normalizeOrderId(raw) {
  if (raw === undefined || raw === null) return null;
  let text = String(raw).toLowerCase();
  // Spoken digits -> numerals ("one zero one" -> "1 0 1").
  text = text.replace(/[a-z]+/g, (w) => NUMBER_WORDS[w] ?? w);
  // Drop the "ord"/"order" prefix letters, keep only the digits.
  const digits = text.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `ORD-${digits}`;
}

export function findOrder(raw) {
  const id = normalizeOrderId(raw);
  return { id, order: id ? ORDERS[id] ?? null : null };
}
