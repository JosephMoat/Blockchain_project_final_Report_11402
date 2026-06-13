import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-mocha-ethers";

const config: HardhatUserConfig = {
  solidity: "0.8.24",
  networks: {
    sepolia: {
      type: "http",
      url: "https://ethereum-sepolia-rpc.publicnode.com",
      // 👇 直接把你的 0x 開頭私鑰貼在下面引號裡面！
      accounts: ["我的私鑰"],
    }
  }
};

export default config;