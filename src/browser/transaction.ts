/** Conservative checkout evidence matching; not merchant authentication or payment authorization. */
export interface ExpectedTransaction {
  recipient?: string; amount?: string; currency?: string; items?: string[]; shippingAddress?: string;
}
function decodeHtml(value: string): string {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}
export function visiblePageText(html: string): string {
  const visible = html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(?:input|textarea)\b[^>]*\bvalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ");
  return decodeHtml(visible.replace(/\s+/g, " ")).trim().toLocaleLowerCase();
}
function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}
export function verifyTransactionEvidence(html: string, expected: ExpectedTransaction): {
  verified: boolean; checks: Record<string, boolean>; missing: string[]; limitation: string;
} {
  const text = visiblePageText(html), checks: Record<string, boolean> = {}, missing: string[] = [];
  const add = (name: string, value: string | undefined) => {
    if (value === undefined || value.trim() === "") return;
    checks[name] = text.includes(normalize(value));
    if (!checks[name]) missing.push(name);
  };
  add("recipient", expected.recipient); add("amount", expected.amount);
  add("currency", expected.currency); add("shippingAddress", expected.shippingAddress);
  expected.items?.forEach((item, index) => add(`items[${index}]`, item));
  return {
    verified: Object.keys(checks).length > 0 && missing.length === 0, checks, missing,
    limitation: "Text-presence check only. It does not authenticate the merchant, interpret totals/tax, validate page semantics, or authorize/finalize a transaction. Review the live page before approving any irreversible action."
  };
}
