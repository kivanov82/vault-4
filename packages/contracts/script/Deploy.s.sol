// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Vault4Fund} from "../src/Vault4Fund.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Deploy is Script {
    // HyperEVM USDC (Circle native)
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;

    function run() external {
        address manager = vm.envAddress("MANAGER_ADDRESS");
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");

        vm.startBroadcast(deployerPk);

        Vault4Fund vault = new Vault4Fund(IERC20(USDC), manager);

        vm.stopBroadcast();

        console2.log("Vault4Fund deployed at:", address(vault));
        console2.log("Manager:", manager);
        console2.log("USDC:", USDC);
    }
}
