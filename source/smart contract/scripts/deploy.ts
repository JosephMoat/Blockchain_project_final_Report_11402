import { ethers } from "ethers";
import fs from "fs";
import path from "path";

async function main() {
    console.log("正在啟動佈署...");

    // 1. 手動填入連線資訊 
    const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
    
    // 請在這裡填入 0x 的私鑰
    const PRIVATE_KEY = "我的私鑰"; 

    const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log("使用錢包:", wallet.address);

    // 2. 讀取編譯檔案
    const artifactPath = path.resolve("artifacts/contracts/HVACAcceptance.sol/HVACAcceptance.json");
    if (!fs.existsSync(artifactPath)) {
        throw new Error("找不到編譯檔案，請先執行 npx hardhat compile");
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

    // 3. 發起部署
    console.log("正在發送部署交易至 Sepolia...");
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    
    // 傳入 wallet.address 作為預言機地址
    const contract = await factory.deploy();
    
    console.log("等待網路確認 (約 15-30 秒)...");
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    console.log("\n 【合約成功部署！】 ");
    console.log("合約地址:", address);
    console.log("-----------------------------------------");
}

main().catch((error) => {
    console.error("\n 發生錯誤：", error);
    process.exit(1);
});