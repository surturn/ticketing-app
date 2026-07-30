import { badRequest } from '../lib/errors.js';
import { mpesaGateway } from './mpesa/gateway.js';
import type { GatewayName, PaymentGateway } from './types.js';

// Adding a gateway means adding one entry here and one adapter file. Checkout,
// settlement and ticket issuance are unaware of which one ran.
const gateways: Record<GatewayName, PaymentGateway> = {
  mpesa: mpesaGateway,
};

export function getGateway(name: GatewayName): PaymentGateway {
  const gateway = gateways[name];
  if (!gateway) {
    throw badRequest(`Unsupported payment gateway: ${name}`);
  }
  return gateway;
}

export function listGateways(): Array<{ name: GatewayName; configured: boolean }> {
  return Object.values(gateways).map((gateway) => ({
    name: gateway.name,
    configured: gateway.isConfigured(),
  }));
}

export const DEFAULT_GATEWAY: GatewayName = 'mpesa';
