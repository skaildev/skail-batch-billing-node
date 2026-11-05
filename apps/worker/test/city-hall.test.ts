import { describe, expect, it } from "vitest";
import { Orders, type Order } from "@skail-batch-billing/contracts";
import { FakeCityHall, CityHallUnavailableError, SimulatedCityHall, decide } from "../src/city-hall.js";

const order = (number: number): Order => Orders.generate("b", number).at(-1)!;

describe("decide (business answer, deterministic per order)", () => {
  it("rejects multiples of 5 with the invalid CNPJ reason", () => {
    expect(decide(order(5))).toMatchObject({
      number: 5,
      status: "Rejected",
      reason: "invalid customer tax id (CNPJ)",
      invoiceNumber: null,
    });
  });

  it("leaves multiples of 7 pending", () => {
    expect(decide(order(7))).toMatchObject({ status: "Pending", reason: "waiting for the city hall to process it" });
  });

  it("authorizes the rest with an invoice number and a stable protocol", () => {
    const invoice = decide(order(3));
    expect(invoice).toMatchObject({ number: 3, status: "Authorized", invoiceNumber: "NF-000003", reason: null });
    expect(invoice.protocol).toMatch(/^PROT-[0-9A-F]{8}$/);
    expect(decide(order(3))).toEqual(invoice);
  });

  it("5 wins over 7 only when 5 divides (35 is rejected)", () => {
    expect(decide(order(35)).status).toBe("Rejected");
  });
});

describe("SimulatedCityHall", () => {
  it("throws the outage error when the draw is below the failure percent", async () => {
    const down = new SimulatedCityHall(25, () => 0.249, false);
    await expect(down.issue(order(3))).rejects.toBeInstanceOf(CityHallUnavailableError);
  });

  it("answers when the draw is at or above the percent", async () => {
    const up = new SimulatedCityHall(25, () => 0.25, false);
    expect(await up.issue(order(3))).toMatchObject({ status: "Authorized" });
  });

  it("0% never fails and 100% always fails", async () => {
    expect(await new SimulatedCityHall(0, () => 0, false).issue(order(1))).toBeDefined();
    await expect(new SimulatedCityHall(100, () => 0.999, false).issue(order(1))).rejects.toThrow(
      "city hall unavailable",
    );
  });

  it("a rejection is a result, not an exception", async () => {
    expect(await new SimulatedCityHall(0, () => 0.5, false).issue(order(10))).toMatchObject({ status: "Rejected" });
  });
});

describe("FakeCityHall", () => {
  it("fails only the first N attempts of each order, then answers", async () => {
    const fake = new FakeCityHall(2);
    await expect(fake.issue(order(3))).rejects.toBeInstanceOf(CityHallUnavailableError);
    await expect(fake.issue(order(3))).rejects.toBeInstanceOf(CityHallUnavailableError);
    expect((await fake.issue(order(3))).status).toBe("Authorized");
    await expect(fake.issue(order(4))).rejects.toBeInstanceOf(CityHallUnavailableError); // another order: own counter
  });

  it("never fails by default", async () => {
    expect((await new FakeCityHall().issue(order(3))).status).toBe("Authorized");
  });
});
