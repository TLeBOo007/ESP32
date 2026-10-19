# BPE Paper Server (รันบน Railway)

ฝั่ง Cloud ของระบบ: รับ Webhook จาก TradingView เก็บคิวสัญญาณ ให้ ESP32 มาอ่านไปตัดสินใจ แล้วถือพอร์ตทดลอง (Paper) จำลองการเข้า-ออกไม้ มี Dashboard และแจ้งเตือน LINE

```
TradingView (Pine Alert) --Webhook--> /tv  (แท่งราคา + สัญญาณ)
                                       |
ESP32 (เทรดเดอร์) <--อ่านสัญญาณ-- Railway --> Dashboard / LINE
        '--ส่งคำสั่งเปิด/ปิดไม้---->  พอร์ต Paper (fill ด้วยแท่งราคาจาก TradingView)
```

- ไม่มีไลบรารีเพิ่ม ไม่ต้อง `npm install`
- ต้องใช้ Node 18 ขึ้นไป (Railway ใช้ให้เอง)

## Deploy บน Railway
1. สร้างโปรเจกต์ใหม่ที่ Railway แล้วนำโฟลเดอร์นี้ขึ้น (GitHub repo หรือ `railway up`)
2. แท็บ **Variables**
   | ตัวแปร | ความหมาย |
   |---|---|
   | `API_KEY` | **จำเป็น** รหัสลับอย่างน้อย 12 ตัวอักษร ตั้งเองแล้วใช้ค่าเดียวกันใน `config.h` ของ ESP32 และใน URL ของ Webhook |
   | `START_BALANCE` | เงินเริ่มต้นของพอร์ตทดลอง (ค่าเริ่มต้น 10000) |
   | `SYMBOL` | ชื่อสัญลักษณ์ที่แสดง (ค่าเริ่มต้น US100) |
   | `DIGITS` | ทศนิยมของราคา (ค่าเริ่มต้น 2) |
   | `MULTIPLIER` | มูลค่าเงินต่อ 1 จุดราคาต่อ 1.00 หน่วย: CFD ดัชนี = 1 (ค่าเริ่มต้น), MNQ = 2, NQ = 20 |
   | `SPREAD` | สเปรดเป็นหน่วยราคา เช่น 1.0 (ค่าเริ่มต้น 0) ใช้ตอน fill และเช็ก SL ของไม้ Sell |
   | `MIN_VOLUME`, `STEP_VOLUME`, `MAX_VOLUME` | ขนาดไม้ในหน่วย 0.01 (ค่าเริ่มต้น 1 / 1 / 1000000) |
   | `DATA_DIR` | `/data` เมื่อติดตั้ง Volume (ข้อ 3) |
   | `LINE_CHANNEL_TOKEN`, `LINE_TO` | แจ้งเตือน LINE (ดูด้านล่าง) |
   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `NOTIFY_WEBHOOK_URL` | ไม่บังคับ |
3. **สำคัญ:** เพิ่ม **Volume** ที่ Mount path `/data` (และตั้ง `DATA_DIR=/data`) ไม่เช่นนั้นข้อมูลพอร์ตหายทุกครั้งที่ deploy ใหม่
4. **Settings → Networking → Generate Domain** จะได้ `https://xxxx.up.railway.app`
5. เปิด URL นั้นในเบราว์เซอร์ ใส่ API Key เพื่อดู Dashboard (เช็กว่าเซิร์ฟเวอร์ทำงานที่ `/health`)

## ตั้ง Alert ใน TradingView
1. เปิด Pine Editor วางไฟล์ `tradingview/ChartDesk3L.pine` แล้วกด Add to chart (ถ้า Pine แจ้ง error ส่งข้อความมาให้ผมแก้ได้ เพราะผมคอมไพล์บน TradingView จริงไม่ได้)
2. ตั้งกราฟเป็นสัญลักษณ์ที่ต้องการเทรด (เช่น US100/NAS100/NQ) Timeframe **M5** และตั้งค่ากลุ่ม *Webhook* ของสคริปต์ให้เปิดอยู่
   - ค่าเริ่มต้นของสคริปต์เปิด **Require footprint confirmation** ซึ่งต้องใช้แพ็กเกจ Premium และสัญลักษณ์ที่มี volume จริง (เช่น ฟิวเจอร์ส) ถ้าใช้ CFD ธรรมดาให้ปิดข้อนี้ สัญญาณจะออกเป็นคำสั่ง limit
3. กด **Alerts → Create Alert**
   - Condition: เลือกสคริปต์ *Chart Desk 3L* แล้วเลือก **alert() function calls only**
   - Notifications: ติ๊ก **Webhook URL** แล้วใส่ `https://xxxx.up.railway.app/tv?key=API_KEY` (TradingView ใส่ header เองไม่ได้ จึงใส่ key ใน URL)
   - ช่อง Message ปล่อยว่างได้ (สคริปต์ส่งข้อความเอง)
   - Expiration: เลือกเปิดไว้นานที่สุดที่แพ็กเกจให้
4. สคริปต์ส่ง 2 ชนิดข้อความ (JSON)
   - แท่งราคาทุกครั้งที่แท่งปิด: `{"event":"bar","t":<epoch วินาที>,"o":..,"h":..,"l":..,"c":..}` เซิร์ฟเวอร์ใช้ fill ออเดอร์และเช็ก SL/TP
   - สัญญาณ: `{"event":"signal","action":"buy_limit|sell_limit|buy|sell|cancel|close","price":..,"sl":..,"tp":..,"t":..,"comment":".."}`
5. ใช้ Alert อื่นหรือสคริปต์อื่นก็ได้ ถ้าส่งรูปแบบข้างบน (ใส่ `"t"` เป็นวินาทีไม่ใช่มิลลิวินาที)

Webhook ของ TradingView ใช้ได้เฉพาะแพ็กเกจที่เปิดให้ใช้ ตรวจเงื่อนไขของแพ็กเกจที่คุณมี

## ตั้งแจ้งเตือน LINE
LINE Notify ปิดบริการไปแล้ว ต้องใช้ **LINE Messaging API**
1. เข้า https://developers.line.biz สร้าง Provider และ Channel ชนิด **Messaging API**
2. แท็บ **Messaging API** ออก **Channel access token (long-lived)** ใส่ตัวแปร `LINE_CHANNEL_TOKEN`
3. แท็บ **Basic settings** คัดลอก **Your user ID** (ขึ้นต้นด้วย U) ใส่ `LINE_TO` แล้วสแกน QR เพิ่มบอทเป็นเพื่อน (ไม่เพิ่มเพื่อน ข้อความจะไม่เข้า)
4. ทดสอบ: `curl -X POST https://xxxx.up.railway.app/api/notify-test -H "x-api-key: API_KEY"`

ข้อความที่แจ้ง: สัญญาณที่ได้รับ, ESP32 รับหรือข้าม (พร้อมเหตุผล), วาง/ยกเลิก limit, เปิดไม้, ปิดไม้พร้อมกำไร/ขาดทุน ข้อความในคำขอเดียวกันถูกรวมเป็น push เดียวเพื่อประหยัดโควตา push message นับโควตารายเดือนของ LINE Official Account ซึ่งต่างกันตามประเทศ/แพ็กเกจ ตรวจในบัญชีของคุณ

## API (ต้องมี header `x-api-key`)
`GET /api/meta` · `GET /api/signals?after=<id>` · `POST /api/signals/ack` · `POST /api/order` · `POST /api/cancel` · `POST /api/close` · `POST /api/amend` · `GET /api/state` · `GET /api/stats` · `GET /api/trades` · `POST /api/reset` (ล้างพอร์ตเริ่มใหม่ ส่ง `{"balance":5000}` เพื่อเปลี่ยนเงินเริ่มต้น)

## ข้อจำกัด
- เป็นการจำลอง ไม่ใช่โบรกเกอร์จริง: ไม่มี slippage, swap, คอมมิชชัน, มาร์จิ้น ผลจริงจะแย่กว่าเล็กน้อย
- การ fill ใช้แท่งราคาที่ TradingView ส่งมา ถ้า Alert ตกหล่นหรือช้า ผลจำลองจะคลาด Dashboard แสดงอายุของแท่งล่าสุด ถ้าเกิน 15 นาที ESP32 จะไม่รับสัญญาณใหม่
- ถ้า ESP32 ออฟไลน์ สัญญาณเข้าสะสมในคิว พอกลับมา สัญญาณเข้าไม้ที่เก่ากว่า 10 นาทีจะถูกข้าม ส่วนไม้ที่เปิดอยู่ยังถูกเช็ก SL/TP ที่เซิร์ฟเวอร์ตามปกติ แต่การปิดไม้ตอนจบ Killzone เป็นหน้าที่ของ ESP32
- เซิร์ฟเวอร์เก็บสัญญาณล่าสุด 500 รายการ

## ทดสอบ
`npm test`
