import type { TFunction } from "i18next";

// Payment failures reach the UI as raw error strings (from Go, the cloud API,
// the x402 client). These codes are what the UI can act on — the same set the
// web server sends with its 402s (web_pay.go payErrCode) — so a failed run can
// say "Not enough credits for this run" and offer a top-up, not a stack trace.
export type PayErrorCode =
  | "insufficient_credits"
  | "insufficient_usdc"
  | "needs_key"
  | "needs_wallet"
  | "invalid_key"
  | "payment_cancelled";

const PATTERNS: [RegExp, PayErrorCode][] = [
  [/not enough credits|insufficient credits/i, "insufficient_credits"],
  [/not enough USDC/i, "insufficient_usdc"],
  [/API key not set|needs_key|an API key with credits is needed/i, "needs_key"],
  [/no wallet configured|connect a wallet to pay/i, "needs_wallet"],
  [/HTTP 40[13]\b|invalid[_ ]key|invalid api key|unauthori[sz]ed/i, "invalid_key"],
  [/payment cancelled|cancelled in the wallet/i, "payment_cancelled"],
];

/** The payment problem behind an error message, if it is one. */
export function payErrorCode(message: string | undefined | null): PayErrorCode | null {
  if (!message) return null;
  for (const [re, code] of PATTERNS) if (re.test(message)) return code;
  return null;
}

/** A payment error in plain words; any other message is returned unchanged. */
export function friendlyPayError(t: TFunction, message: string): string {
  const code = payErrorCode(message);
  return code ? t(`payErrors.${code}`) : message;
}
