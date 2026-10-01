// Catches common email typos on phones (e.g. "gmail.comc", "gmial.com",
// "yahoo.con") and suggests the likely intended address.

const COMMON_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'live.com', 'ymail.com', 'aol.com', 'protonmail.com', 'yahoo.co.uk',
];

// Real providers that look close to a common one (mail.com vs gmail.com), so
// they are never "corrected".
const OTHER_REAL_DOMAINS = ['mail.com', 'email.com', 'gmx.com', 'me.com', 'mac.com', 'msn.com', 'zoho.com', 'proton.me'];

// Mistyped endings of ".com" (extra, missing or swapped letters).
const COM_TYPOS = ['comc', 'comm', 'con', 'cmo', 'cm', 'om', 'vom', 'xom', 'coom', 'ocm', 'comn', 'cpm'];

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length];
}

/** Returns a corrected email if the domain looks like a typo, otherwise null. */
export function suggestEmailFix(input: string): string | null {
  const email = input.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (COMMON_DOMAINS.includes(domain) || OTHER_REAL_DOMAINS.includes(domain)) return null;

  // Closest well-known domain, e.g. gmial.com → gmail.com, gmail.comc → gmail.com.
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of COMMON_DOMAINS) {
    const distance = editDistance(domain, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best && bestDistance <= 2) return `${local}@${best}`;

  // Any other domain with a mistyped ".com", e.g. company.con → company.com.
  const dot = domain.lastIndexOf('.');
  if (dot > 0 && COM_TYPOS.includes(domain.slice(dot + 1))) {
    return `${local}@${domain.slice(0, dot)}.com`;
  }
  return null;
}
