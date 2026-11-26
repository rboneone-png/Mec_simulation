# MecSim 結構分析

瀏覽器端的 3D 結構有限元素分析：匯入 STEP 組合件 → 設定材料與邊界條件 → 產生網格 → 線性或彈塑性求解 → 3D 檢視結果。全部在瀏覽器執行，不需後端。

## 快速開始

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 求解器驗證（理論解比對）
npm run build    # 輸出到 dist/
```

## 功能
| 項目 | 內容 |
|---|---|
| 幾何 | STEP 匯入（occt-import-js），多檔、多實體組合件 |
| 網格 | **TET10 二次四面體**（fTetWild WASM，邊界節點投影回 CAD 曲面、多件共節點）／HEX8 體素（快速預覽） |
| 材料 | 鋼、不鏽鋼、鋁、鈦、銅、ABS，可自訂 E、ν、σy、σu；顯示應力-應變曲線 |
| 邊界條件 | 固定（可選 X/Y/Z 方向，做對稱面／滑動支承）、力向量、壓力；在 3D 視窗點選面 |
| 分析 | 線性靜力；**非線性靜力（J2 彈塑性、等向硬化）**：Newton-Raphson、負載增量、自動減步 |
| 結果 | von Mises、位移、等效塑性應變 PEEQ、變形放大、網格線、負載步切換、負載-位移曲線、安全係數、CSV/PNG |

## 求解方法
- 單位：mm、N、MPa
- 3×3 區塊 CSR 稀疏矩陣、IC(0) 前置條件共軛梯度法，於 Web Worker 執行
- 彈塑性：徑向回歸 + 一致切線矩陣；硬化曲線由材料的工程應力-應變曲線轉換為真應力-塑性應變
- 多件組合：所有零件表面一起交給 fTetWild，得到接觸面共形的網格（黏合），再以射線奇偶法判定每個元素所屬零件
- 應力：積分點外插到節點後平均

### 驗證（`npm test`）
| 案例 | 結果 |
|---|---|
| 懸臂樑撓度（HEX8 / TET10） | 誤差 0.6% / 0.3% |
| 懸臂樑彎曲應力 | 誤差 0.4% / 2.4% |
| 單軸拉伸超過降伏：應力、PEEQ、伸長量 | 誤差 < 2% |
| 超過極限負載 | 正確偵測不收斂並終止 |

## 部署到 GitHub Pages
1. 將程式合併到 `main`
2. GitHub repo → Settings → Pages → Source 選 **GitHub Actions**
3. 之後每次 push 到 `main`，`.github/workflows/deploy.yml` 會自動測試、建置並部署


## 限制
- 小應變、小變形；不含幾何非線性、接觸分離／摩擦、動態分析
- 尖角、固定邊緣的應力為奇異點，數值會隨網格加密而上升，請以遠離奇異點處或收斂趨勢判讀
- 理想塑性材料超過極限負載時會停止於最後收斂步

## 授權
所有相依套件皆為寬鬆授權，可用於開源或閉源、商業或非商業專案：

| 套件 | 用途 | 授權 |
|---|---|---|
| three.js | 3D 顯示 | MIT |
| occt-import-js（OpenCascade） | STEP 匯入 | LGPL-2.1 + OCCT 例外條款 |
| float-tetwild-wasm（fTetWild、Geogram） | 四面體網格 | MPL-2.0、BSD-3 |
| Vite | 建置工具（不隨網站發佈） | MIT |

MPL-2.0 為「檔案層級」的著作權條款：直接使用、未修改 fTetWild 本身，不影響你自己程式碼的授權；只有修改 fTetWild 原始檔時，需要公開那些修改。

範例：`public/samples/demo_assembly.step`（三件組合）、`public/samples/bracket_shaft.step`（帶孔板＋圓軸）。
