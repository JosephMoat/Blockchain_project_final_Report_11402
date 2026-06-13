// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title HVACAcceptance (測試版)
 * 移除所有權限限制，方便前端工程師直接進行串接測試。
 * 只要任何人發送交易，合約都會執行邏輯。
 */
contract HVACAcceptance {
    // ==========================================
    // 1. 狀態變數 (所有變數皆為 Public，方便前端讀取)
    // ==========================================
    uint256 public constant TARGET_TEMP = 24;      // 目標溫度：<= 24
    uint256 public constant TARGET_HUMIDITY = 50;  // 目標濕度：<= 50
    uint256 public constant REQUIRED_COUNT = 30;   // 需要連續達標次數

    uint256 public consecutiveSuccesses; // 當前累計次數
    bool public isAccepted;              // 驗收狀態

    // ==========================================
    // 2. 事件 (前端監聽畫面的關鍵)
    // ==========================================
    event DataLogged(uint256 temp, uint256 humidity, uint256 currentCount);
    event ProjectAccepted(string message);
    event CounterReset();

    // ==========================================
    // 3. 核心功能 (移除 onlyOracle，任何人皆可呼叫)
    // ==========================================
    function logData(uint256 _temp, uint256 _humidity) external {
        // 如果已經通過驗收，就停止接收數據
        require(!isAccepted, "Project already accepted.");

        if (_temp <= TARGET_TEMP && _humidity <= TARGET_HUMIDITY) {
            consecutiveSuccesses += 1;
        } else {
            consecutiveSuccesses = 0; // 不達標則歸零
        }

        emit DataLogged(_temp, _humidity, consecutiveSuccesses);

        if (consecutiveSuccesses >= REQUIRED_COUNT) {
            isAccepted = true;
            emit ProjectAccepted("Success: HVAC passed the test!");
        }
    }

    // ==========================================
    // 4. 測試輔助功能 (移除 onlyOwner，方便隨時重跑流程)
    // ==========================================
    function resetCounter() external {
        consecutiveSuccesses = 0;
        isAccepted = false; // 甚至允許把驗收狀態重置，方便反覆測試
        emit CounterReset();
    }
}