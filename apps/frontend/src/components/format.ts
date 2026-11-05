const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "BRL" });

export const formatMoney = (value: number): string => money.format(value);
