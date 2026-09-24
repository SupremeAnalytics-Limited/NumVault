// Paystack NGN transfer fees (support.paystack.com/en/articles/2130306),
// plus the flat ₦50 stamp duty on transfers ≥ ₦10,000 (Nigeria Tax Act 2025).
export function paystackTransferFee(amountNaira: number): number {
  const base = amountNaira <= 5_000 ? 10 : amountNaira <= 50_000 ? 25 : 50;
  const stampDuty = amountNaira >= 10_000 ? 50 : 0;
  return base + stampDuty;
}
