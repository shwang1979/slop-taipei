# Slop 台北

用 [three.js](https://threejs.org/) WebGPURenderer 與 TSL 打造的 1:1 台北市模擬，改編自 mrdoob 的 [Slop New York](https://github.com/mrdoob/slop-newyork)。可以步行、開計程車（小黃）、騎機車或開直升機，在台北市中心逛：從萬華、西門町、台北車站，一路到信義區與台北101，南到公館、北到圓山與大直。

A 1:1 Taipei city simulation built with three.js WebGPURenderer & TSL, adapted from mrdoob's Slop New York. Walk, drive a yellow taxi, ride a scooter or fly a helicopter around central Taipei.

## 內容

- **真實地理**：OpenStreetMap 的街道網（約 2.7 萬段道路、雙向/單行、車道數、高架與匝道高程）、45,000 棟建築（依樓層數或高度）、河川與堤岸、公園、象山／劍潭山等山坡地形，以及盆地外圍的陽明山、觀音山。
- **台北建築風格**：老公寓的二丁掛磁磚、鐵窗、窗型冷氣、雨痕，騎樓店面，頂樓鐵皮加蓋與水塔，帷幕玻璃大樓，廟宇的燕尾屋頂。
- **地標**：台北101（節節高升的八個筍節、如意、尖塔，夜間依星期幾變色）、中正紀念堂與自由廣場牌樓、國家戲劇院／音樂廳、總統府、國父紀念館、台北車站、圓山大飯店、龍山寺、西門紅樓、台北府城門。
- **街道**：雙黃線、車道線、斑馬線、停止線與機車停等區、行道樹與分隔島、路燈、號誌與行人小綠人（依路口時相運作）、OSM 上的真實店名招牌（直式與橫式，夜間發光）、路邊整排停放的機車。
- **交通**：滿街的機車、計程車、自用車與公車，依號誌停等（機車停在停等區前），跟車、轉彎；人行道上的行人；文湖線高架與捷運列車。
- **介面**：繁體中文 HUD、小地圖與全螢幕地圖（搜尋路名、地標、捷運站，點擊傳送）、傳送點、多個景點攝影機（象山看101、101觀景台、自由廣場…）、四種時段（黃昏、正午、藍調、夜晚）、合成音效（機車引擎聲）。

## 執行

需要支援 WebGPU 的瀏覽器（Chrome / Edge 113+、Safari 26+）。任何靜態伺服器都可以：

```sh
python3 -m http.server 8000
# 開啟 http://localhost:8000/
```

網址參數：`?at=<傳送點>`（例如 `taipei101`、`ximen`、`station`、`cks`、`dongqu`…）、`?mode=person|car|scooter|helicopter`、`?camera=<攝影機>`、`?time=golden|midday|twilight|midnight`。

效能相關：`?lite` 減少樹木、停放機車與車流數量（較慢的裝置）；`?skip=landmarks,props,traffic,elevated,paint,trees,lamps,signals,signs,parked` 可拿掉部分城市內容（除錯、效能分析用）。

## 操作

| 按鍵 | 功能 |
| --- | --- |
| W / S | 前進、後退（煞車） |
| A / D | 轉向 |
| Shift | 加速／奔跑 |
| Space / E、Q / C | 跳躍、直升機上升／下降 |
| B | 喇叭 |
| 1–4 | 步行、開車、機車、飛行 |
| V（Shift+V） | 切換攝影機 |
| M | 地圖 |
| N | 聲音開關 |
| H | 隱藏介面 |

也支援觸控與遊戲手把。

## 重新產生地理資料

`js/taipei-geodata.js` 由 `tools/` 的腳本從 OpenStreetMap 產生：

```sh
cd tools
npm install          # clipper-lib（多邊形聯集、緩衝）
./fetch-osm.sh       # 透過 Overpass API 下載約 75 MB 的 OSM 資料到 tools/data
npm run build        # 寫出 ../js/taipei-geodata.js
```

資料範圍是北緯 25.012–25.085、東經 121.492–121.582（約 9 × 8 公里）。

## 授權

程式碼以 [MIT License](LICENSE) 釋出，大量沿用 [Slop New York](https://github.com/mrdoob/slop-newyork)（© Mr.doob，MIT）的渲染、車輛、行人、樹木、燈光、攝影機與音效模組。

地理資料 © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)（ODbL）。
