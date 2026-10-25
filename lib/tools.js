// Tools the agent can call. The LLM decides *when* to call them; the code
// decides *what is true*. Policy decisions (return window, cancellation
// rules) are computed here, not by the model, so they can't be talked around.

import { findOrder } from './orders.js';
import { POLICY } from './knowledge.js';

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'get_order_details',
      description:
        'Look up live details (status, product, courier, tracking, delivery notes) for one order. Call this whenever the customer asks about a specific order and you have not already looked it up in this call.',
      parameters: {
        type: 'object',
        properties: {
          order_id: {
            type: 'string',
            description: 'Order ID as the customer said it, e.g. "ORD-101" or "101".',
          },
        },
        required: ['order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_return_eligibility',
      description:
        'Check whether an order can be returned, refunded or replaced under Aura policy. Call this before answering any return, refund, exchange or damaged-product request for a specific order.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'Order ID, e.g. "ORD-102".' },
          reason: {
            type: 'string',
            enum: ['changed_mind', 'damaged_or_defective', 'wrong_item', 'other'],
            description: 'Why the customer wants to return it.',
          },
          product_opened: {
            type: 'string',
            enum: ['yes', 'no', 'unknown'],
            description: 'Whether the customer has opened or used the product. Use "unknown" if they have not said.',
          },
        },
        required: ['order_id', 'reason', 'product_opened'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_order',
      description:
        'Cancel an order. Only call with customer_confirmed=true after the customer has clearly said yes to cancelling that specific order in this call.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'Order ID, e.g. "ORD-103".' },
          customer_confirmed: {
            type: 'boolean',
            description: 'True only if the customer explicitly confirmed the cancellation.',
          },
        },
        required: ['order_id', 'customer_confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Raise a ticket for the human support team. Use when the customer needs something you cannot resolve (outside policy but they want a review, missing information, health or skin reaction concerns, repeated failures to find their order, or they ask for a human).',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'One-line reason for the escalation.' },
          order_id: { type: 'string', description: 'Related order ID, if any.' },
        },
        required: ['reason'],
      },
    },
  },
];

function notFound(id) {
  return {
    found: false,
    error: id
      ? `No order found with ID ${id}. Ask the customer to repeat or verify the ID. Do not guess details.`
      : 'No order ID was provided or it could not be understood. Ask the customer for their order ID (it looks like ORD followed by three digits).',
  };
}

function getOrderDetails({ order_id }) {
  const { id, order } = findOrder(order_id);
  if (!order) return notFound(id);
  return { found: true, ...order };
}

function checkReturnEligibility({ order_id, reason = 'other', product_opened = 'unknown' }) {
  const { id, order } = findOrder(order_id);
  if (!order) return notFound(id);
  const base = { found: true, order_id: order.order_id, status: order.status, product: order.product };

  if (order.status !== 'Delivered') {
    const alt =
      order.status === 'Processing'
        ? 'The order has not shipped yet, so the customer can cancel it instead.'
        : 'The order is on its way; the customer can refuse it at the doorstep.';
    return { ...base, eligible: false, reason: `Order is "${order.status}", not delivered yet, so a return does not apply. ${alt}` };
  }

  const hoursSinceDelivery = order.delivered_days_ago * 24;
  const deliveredWhen = `${order.delivered_days_ago} days ago`;

  if (reason === 'damaged_or_defective' || reason === 'wrong_item') {
    if (hoursSinceDelivery <= POLICY.damageReportHours) {
      return { ...base, eligible: true, outcome: 'replacement', reason: `Reported within ${POLICY.damageReportHours} hours of delivery. Customer must share photos of the issue for a replacement.` };
    }
    return {
      ...base,
      eligible: false,
      reason: `Delivered ${deliveredWhen}. Damaged or defective items must be reported within ${POLICY.damageReportHours} hours of delivery, so this is outside the window. You may offer to raise a ticket for the team to review, without promising any outcome.`,
    };
  }

  if (order.delivered_days_ago > POLICY.returnWindowDays) {
    return { ...base, eligible: false, reason: `Delivered ${deliveredWhen}; returns are only accepted within ${POLICY.returnWindowDays} days of delivery.` };
  }
  if (product_opened === 'yes') {
    return { ...base, eligible: false, reason: 'Only unopened, unused products in original packaging can be returned.' };
  }
  if (product_opened === 'unknown') {
    return { ...base, eligible: 'needs_info', reason: 'Within the return window. Ask whether the product is unopened and unused in its original packaging.' };
  }
  return { ...base, eligible: true, outcome: 'return', reason: `Within ${POLICY.returnWindowDays} days and unopened, so it can be returned.` };
}

// Deliberately stateless: the demo database is shared by every tester, so a
// cancellation must not leak into other people's calls. Within a call, the
// tool result stays in the conversation history, so the agent remembers it.
function cancelOrder({ order_id, customer_confirmed }) {
  const { id, order } = findOrder(order_id);
  if (!order) return notFound(id);
  if (order.status !== 'Processing') {
    const extra = order.status === 'Delivered'
      ? 'It has already been delivered; a return may apply instead.'
      : 'The customer may refuse the delivery at the doorstep.';
    return { found: true, order_id: order.order_id, cancelled: false, status: order.status, reason: `Orders can only be cancelled while Processing. This order is "${order.status}". ${extra}` };
  }
  if (customer_confirmed !== true) {
    return { found: true, order_id: order.order_id, cancelled: false, requires_confirmation: true, reason: `Eligible for cancellation. Confirm with the customer that they want to cancel ${order.product} before cancelling.` };
  }
  const cancellationId = `CXL-${Math.floor(10000 + Math.random() * 90000)}`;
  return { found: true, order_id: order.order_id, cancelled: true, cancellation_id: cancellationId, product: order.product };
}

function escalateToHuman({ reason, order_id }) {
  const ticket = `TKT-${Math.floor(100000 + Math.random() * 900000)}`;
  return {
    ticket_id: ticket,
    reason,
    order_id: order_id ? findOrder(order_id).id : null,
    note: 'Ticket created. The Aura support team will contact the customer on their registered phone number. Do not promise a specific timeline or outcome.',
  };
}

const IMPLEMENTATIONS = {
  get_order_details: getOrderDetails,
  check_return_eligibility: checkReturnEligibility,
  cancel_order: cancelOrder,
  escalate_to_human: escalateToHuman,
};

/** Run a tool by name. Never throws: errors become a result the model can explain. */
export function executeTool(name, rawArgs) {
  const impl = IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool "${name}".` };
  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { error: 'Tool arguments were not valid JSON. Ask the customer to repeat the request.' };
    }
  }
  try {
    return impl(args ?? {});
  } catch (err) {
    return { error: `Tool failed: ${err.message}` };
  }
}
