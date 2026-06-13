import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const HVACModule = buildModule("HVACModule", (m) => {
  // 改成 0，代表抓取你 .env 裡的第一個（也是唯一一個）錢包地址
  const oracleAccount = m.getAccount(0);

  const hvac = m.contract("HVACAcceptance", [oracleAccount]);

  return { hvac };
});

export default HVACModule;