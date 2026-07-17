import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A cloud model's `cost` is denominated in credits (1 credit = $0.001). Bearer
 * users pay in credits; x402 users pay in on-chain USDC. Convert credits → a
 * USD string with just enough precision (2 decimals, 3 for sub-cent costs).
 */
export function creditsToUSD(credits: number): string {
  const usd = credits / 1000;
  return usd >= 0.01 ? usd.toFixed(2) : usd.toFixed(3);
}
