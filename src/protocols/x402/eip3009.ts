// EIP-3009 `TransferWithAuthorization` signing helper for x402.
//
// EIP-3009 defines EIP-712-typed data for `transferWithAuthorization(...)` on
// tokens like USDC. The x402 `exact` scheme uses exactly this authorization
// so the facilitator can settle the payment on-chain on behalf of the payer.
//
//   References:
//   - EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
//   - x402 spec: https://github.com/coinbase/x402
//
import {
  createPublicClient,
  http,
  parseUnits,
  hexToBytes,
  bytesToHex,
  type Address,
  type Hex,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, base, polygon } from "viem/chains";
import { randomBytes } from "node:crypto";
import { getConfig } from "../../config/loader";
import { getLogger } from "../../logging/logger";

// ─── Well-known token (USDC/USDT/DAI) EIP-712 domains ──────────────────────
//
// For EIP-3009, the domain.name is the token's on-chain `name()` and the
// domain.version is its `version()`. We keep a small registry and fall back
// to reading on-chain when the token is unknown.

interface TokenDomainInfo {
  address: Address;
  name: string;
  version: string;
  decimals: number;
}

const TOKEN_REGISTRY: Record<string, Record<string, TokenDomainInfo>> = {
  USDC: {
    ethereum: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      name: "USD Coin",
      version: "2",
      decimals: 6,
    },
    base: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      name: "USD Coin",
      version: "2",
      decimals: 6,
    },
    polygon: {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      name: "USD Coin",
      version: "2",
      decimals: 6,
    },
  },
  USDT: {
    ethereum: {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      name: "Tether USD",
      version: "1",
      decimals: 6,
    },
  },
};

function resolveChain(networkName: string): { chain: Chain; rpcUrl: string } {
  const config = getConfig();
  const chainMap: Record<string, Chain> = {
    ethereum: mainnet,
    base,
    polygon,
  };
  const chain = chainMap[networkName];
  if (!chain) throw new Error(`Unsupported network: ${networkName}`);
  const netConfig = config.web3?.[networkName];
  const rpcUrl = netConfig?.rpc_url ?? chain.rpcUrls.default.http[0];
  return { chain, rpcUrl };
}

// ─── On-chain fallback: read domain from the ERC-20 contract ───────────────

const EIP712_DOMAIN_ABI = [
  { name: "name", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { name: "version", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;

async function readTokenDomain(
  tokenAddress: Address,
  networkName: string
): Promise<Omit<TokenDomainInfo, "address">> {
  const { chain, rpcUrl } = resolveChain(networkName);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const [name, version, decimals] = await Promise.all([
    publicClient.readContract({ address: tokenAddress, abi: EIP712_DOMAIN_ABI, functionName: "name" }),
    publicClient
      .readContract({ address: tokenAddress, abi: EIP712_DOMAIN_ABI, functionName: "version" })
      .catch(() => "1"),
    publicClient.readContract({ address: tokenAddress, abi: EIP712_DOMAIN_ABI, functionName: "decimals" }),
  ]);

  return { name: name as string, version: version as string, decimals: Number(decimals) };
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface SignedAuthorization {
  signature: Hex;
  from: Address;
  to: Address;
  value: string; // base units (string for BigInt safety)
  validAfter: string;
  validBefore: string;
  nonce: Hex; // 32-byte hex
}

export interface SignEip3009Params {
  privateKey: Hex;
  network: string;
  asset: string; // e.g. "USDC"
  to: Address;
  /**
   * Amount in base units (e.g. "1000000" for 1 USDC).
   * If `decimals` is provided and `valueBaseUnits` is not, pass `valueDecimal`.
   */
  valueBaseUnits?: string;
  valueDecimal?: string;
  validAfterSec?: number; // default 0
  validBeforeSec?: number; // default now + 300
  tokenAddress?: Address; // override registry
}

/**
 * Sign an EIP-3009 `TransferWithAuthorization` using a Viem account.
 * Returns the fields expected by `X402Client.buildPaymentPayload`.
 */
export async function signEip3009TransferAuthorization(
  params: SignEip3009Params
): Promise<SignedAuthorization> {
  const logger = getLogger();
  const {
    privateKey,
    network,
    asset,
    to,
    valueBaseUnits,
    valueDecimal,
    validAfterSec,
    validBeforeSec,
    tokenAddress,
  } = params;

  const account = privateKeyToAccount(privateKey);
  const { chain } = resolveChain(network);

  // Resolve token domain
  const registryEntry = TOKEN_REGISTRY[asset.toUpperCase()]?.[network];
  let domainInfo: TokenDomainInfo;
  if (registryEntry && !tokenAddress) {
    domainInfo = registryEntry;
  } else {
    const resolvedAddress = tokenAddress ?? registryEntry?.address;
    if (!resolvedAddress) {
      throw new Error(
        `EIP-3009: unknown token '${asset}' on '${network}' — please provide tokenAddress`
      );
    }
    const onchain = await readTokenDomain(resolvedAddress, network);
    domainInfo = { address: resolvedAddress, ...onchain };
  }

  // Compute value in base units
  let valueStr: string;
  if (valueBaseUnits) {
    valueStr = valueBaseUnits;
  } else if (valueDecimal) {
    valueStr = parseUnits(valueDecimal, domainInfo.decimals).toString();
  } else {
    throw new Error("EIP-3009: either valueBaseUnits or valueDecimal must be provided");
  }

  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(validAfterSec ?? 0);
  const validBefore = BigInt(validBeforeSec ?? now + 300);
  // 32 random bytes per EIP-3009 nonce
  const nonce = bytesToHex(randomBytes(32));

  const domain = {
    name: domainInfo.name,
    version: domainInfo.version,
    chainId: chain.id,
    verifyingContract: domainInfo.address,
  } as const;

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const message = {
    from: account.address,
    to,
    value: BigInt(valueStr),
    validAfter,
    validBefore,
    nonce: nonce as Hex,
  };

  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  logger.debug("EIP-3009: TransferWithAuthorization signed", {
    from: account.address,
    to,
    value: valueStr,
    network,
    asset,
    token: domainInfo.address,
  });

  // Sanity check: re-verify locally to catch signer misconfig early.
  // (Cheap: just ensures hexToBytes(signature).length === 65)
  if (hexToBytes(signature).length !== 65) {
    throw new Error("EIP-3009: invalid signature length");
  }

  return {
    signature,
    from: account.address,
    to,
    value: valueStr,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce: nonce as Hex,
  };
}
