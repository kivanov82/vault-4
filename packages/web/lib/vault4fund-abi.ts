/**
 * Vault4Fund contract ABI (ERC-4626 on HyperEVM).
 * Only includes functions used by the frontend.
 */
export const vault4FundAbi = [
  // Read
  { type: "function", name: "sharePrice", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalAssets", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "convertToAssets", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "convertToShares", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "availableForInstantWithdraw", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "pendingDeposits", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "pendingWithdraws", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "depositQueueLength", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "withdrawQueueLength", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "depositQueueHead", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getDepositRequest", inputs: [{ name: "index", type: "uint256" }], outputs: [{ name: "investor", type: "address" }, { name: "assets", type: "uint256" }, { name: "requestedAt", type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "getWithdrawRequest", inputs: [{ name: "index", type: "uint256" }], outputs: [{ name: "investor", type: "address" }, { name: "shares", type: "uint256" }, { name: "requestedAt", type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "epoch", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "paused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "deployedToL1", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "highWaterMark", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  // Write
  { type: "function", name: "requestDeposit", inputs: [{ name: "assets", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "requestWithdraw", inputs: [{ name: "shares", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancelDeposit", inputs: [{ name: "index", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancelWithdraw", inputs: [{ name: "index", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "instantWithdraw", inputs: [{ name: "shares", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  // Events
  { type: "event", name: "DepositQueued", inputs: [{ name: "investor", type: "address", indexed: true }, { name: "assets", type: "uint256", indexed: false }, { name: "index", type: "uint256", indexed: false }] },
  { type: "event", name: "WithdrawQueued", inputs: [{ name: "investor", type: "address", indexed: true }, { name: "shares", type: "uint256", indexed: false }, { name: "index", type: "uint256", indexed: false }] },
  { type: "event", name: "DepositCancelled", inputs: [{ name: "investor", type: "address", indexed: true }, { name: "assets", type: "uint256", indexed: false }, { name: "index", type: "uint256", indexed: false }] },
  { type: "event", name: "WithdrawCancelled", inputs: [{ name: "investor", type: "address", indexed: true }, { name: "shares", type: "uint256", indexed: false }, { name: "index", type: "uint256", indexed: false }] },
  { type: "event", name: "InstantWithdraw", inputs: [{ name: "investor", type: "address", indexed: true }, { name: "shares", type: "uint256", indexed: false }, { name: "assets", type: "uint256", indexed: false }] },
  { type: "event", name: "Settled", inputs: [{ name: "epoch", type: "uint256", indexed: true }, { name: "totalAssets", type: "uint256", indexed: false }, { name: "depositsProcessed", type: "uint256", indexed: false }, { name: "withdrawsProcessed", type: "uint256", indexed: false }] },
] as const

/** USDC on HyperEVM (6 decimals) */
export const USDC_ADDRESS = "0xb88339CB7199b77E23DB6E890353E22632Ba630f" as const

export const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const
