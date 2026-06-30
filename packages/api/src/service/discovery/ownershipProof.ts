import { privateKeyToAccount } from "viem/accounts";
import { logger } from "../utils/logger";

/**
 * x402 ownership proofs (see x402scan DISCOVERY.md).
 *
 * x402scan verifies that a resource is owned by its payTo address by recovering
 * the signer of an ownership-proof signature whose signed message is the
 * resource ORIGIN string (e.g. "https://host"). We sign that origin with the
 * same WALLET_PK that receives x402 payments, so x402scan can mark the listing
 * verified and let us claim/edit it.
 *
 * Signatures are EIP-191 personal_sign (viem `signMessage`), which x402scan
 * recovers with viem `recoverMessageAddress`. We emit proofs for both the
 * https and http origin forms so a scheme-normalization mismatch can't drop the
 * proof. Results are cached per-origin (the message never changes).
 */

const WALLET_PK = process.env.WALLET_PK as `0x${string}` | undefined;
const cache = new Map<string, string>();

async function signOrigin(origin: string): Promise<string | null> {
    if (!WALLET_PK) return null;
    const cached = cache.get(origin);
    if (cached) return cached;
    try {
        const account = privateKeyToAccount(WALLET_PK);
        const signature = await account.signMessage({ message: origin });
        cache.set(origin, signature);
        return signature;
    } catch (err: any) {
        logger.warn("Failed to build x402 ownership proof", {
            origin,
            msg: err?.message,
        });
        return null;
    }
}

/**
 * Ownership-proof signatures for a request host, covering both origin schemes.
 * Returns [] when WALLET_PK is unset or signing fails (never throws).
 */
export async function ownershipProofsForHost(
    host: string | undefined
): Promise<string[]> {
    if (!host) return [];
    const proofs: string[] = [];
    for (const origin of [`https://${host}`, `http://${host}`]) {
        const sig = await signOrigin(origin);
        if (sig) proofs.push(sig);
    }
    return proofs;
}
