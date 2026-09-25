// Used by ensure-socially-balance for both the classic and scale-mode
// top-up paths, which both need the same Paystack transfer recipient for
// Socially.ng's PalmPay account. purchase-number no longer imports this —
// it does not send any transfer itself.
const PAYSTACK_BASE = 'https://api.paystack.co';
const SOCIALLY_ACCOUNT_NUMBER = '6635796668';
const SOCIALLY_ACCOUNT_NAME = 'Riteweb Digital Services-Sim(Paymentpoint)';

async function getPalmpayBankCode(secretKey: string): Promise<string> {
  const res = await fetch(`${PAYSTACK_BASE}/bank?currency=NGN&perPage=200`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data = await res.json();
  if (!data.status || !Array.isArray(data.data)) {
    throw new Error(`Paystack /bank list failed: ${JSON.stringify(data)}`);
  }
  const match = data.data.find(
    (b: { name: string; code: string }) => b.name.toLowerCase().includes('palmpay'),
  );
  if (!match) throw new Error('Palmpay not found in Paystack bank list');
  return match.code;
}

export async function getOrCreateSociallyRecipient(secretKey: string): Promise<string> {
  const listRes = await fetch(`${PAYSTACK_BASE}/transferrecipient?perPage=100`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const listData = await listRes.json();
  if (listData.status && Array.isArray(listData.data)) {
    const existing = listData.data.find(
      (r: any) => r.details?.account_number === SOCIALLY_ACCOUNT_NUMBER,
    );
    if (existing?.recipient_code) return existing.recipient_code;
  }
  const bankCode = await getPalmpayBankCode(secretKey);
  const createRes = await fetch(`${PAYSTACK_BASE}/transferrecipient`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'nuban',
      name: SOCIALLY_ACCOUNT_NAME,
      account_number: SOCIALLY_ACCOUNT_NUMBER,
      bank_code: bankCode,
      currency: 'NGN',
    }),
  });
  const createData = await createRes.json();
  if (!createData.status || !createData.data?.recipient_code) {
    throw new Error(`Failed to create recipient: ${JSON.stringify(createData)}`);
  }
  return createData.data.recipient_code;
}
