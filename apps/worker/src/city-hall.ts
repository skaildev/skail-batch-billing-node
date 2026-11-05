import type { Invoice, Order } from "@skail-batch-billing/contracts";

/** Technical failure (city hall system down): the command throws it and skail retries. */
export class CityHallUnavailableError extends Error {
  constructor() {
    super("city hall unavailable");
    this.name = "CityHallUnavailableError";
  }
}

export interface CityHall {
  /**
   * Issues the invoice. A rejection or a pending invoice is a **result**; only an outage throws.
   * `order.id` is the idempotency key: the same order always yields the same invoice.
   */
  issue(order: Order): Promise<Invoice>;
}

// FNV-1a: a short hash that is always the same for the same order id, with no Node import (the skail bundle
// rejects static imports of Node I/O modules)
function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).toUpperCase().padStart(8, "0");
}

/** Business answer of the simulated city hall, deterministic per order. */
export function decide(p: Order): Invoice {
  const base = { number: p.number, customer: p.customer, amount: p.amount, invoiceNumber: null, protocol: null };
  if (p.number % 5 === 0) return { ...base, status: "Rejected", reason: "invalid customer tax id (CNPJ)" };
  if (p.number % 7 === 0) return { ...base, status: "Pending", reason: "waiting for the city hall to process it" };
  return {
    ...base,
    status: "Authorized",
    invoiceNumber: `NF-${String(p.number).padStart(6, "0")}`,
    protocol: `PROT-${hash8(p.id)}`,
    reason: null,
  };
}

/** Default city hall: random outages and a little latency. Randomness is fine here: it is I/O inside a command. */
export class SimulatedCityHall implements CityHall {
  constructor(
    private readonly outagePercent: number,
    private readonly random: () => number = Math.random,
    private readonly latency = true,
  ) {}

  async issue(order: Order): Promise<Invoice> {
    if (this.latency) await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 600));
    if (this.random() * 100 < this.outagePercent) throw new CityHallUnavailableError();
    return decide(order);
  }
}

/** Offline and deterministic: fails only the first `failFirstAttempts` attempts of each order (tests). */
export class FakeCityHall implements CityHall {
  readonly #attempts = new Map<string, number>();

  constructor(private readonly failFirstAttempts = 0) {}

  async issue(order: Order): Promise<Invoice> {
    const attempt = (this.#attempts.get(order.id) ?? 0) + 1;
    this.#attempts.set(order.id, attempt);
    if (attempt <= this.failFirstAttempts) throw new CityHallUnavailableError();
    return decide(order);
  }
}
