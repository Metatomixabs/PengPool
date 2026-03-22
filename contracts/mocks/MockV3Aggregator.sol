// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Re-export Chainlink's mock so Hardhat compiles it and makes it available
// in tests via ethers.getContractFactory("MockV3Aggregator").
import "@chainlink/contracts/src/v0.8/shared/mocks/MockV3Aggregator.sol";
