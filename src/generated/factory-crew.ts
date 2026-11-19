// The TokenFactory.launch fragment of the FROZEN hook (11-field LaunchParams: crew and persona
// appended). The generated tokenFactoryAbi in ./contracts.ts is the pre-crew 9-field tuple, whose
// selector the frozen factory does not have. Used only when a launch names a `crew`.
export const crewLaunchAbi = [
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      { name: "quoteCurrency", type: "address" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "graduationTarget", type: "uint96" },
          { name: "curveSupply", type: "uint128" },
          { name: "snipeWindow", type: "uint64" },
          { name: "tradeFeeBps", type: "uint16" },
          { name: "snipeStartBps", type: "uint16" },
          { name: "perWalletCapBps", type: "uint16" },
          { name: "creatorAllocationBps", type: "uint16" },
          { name: "bucketBps", type: "uint16[4]" },
          { name: "crew", type: "address" },
          { name: "persona", type: "bytes32" },
        ],
      },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "poolId", type: "bytes32" },
    ],
  },
] as const;
