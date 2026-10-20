'use strict';
// Watches the ESP32 (it sends the header "x-device: esp32" with every request, about every 5 s) and the exam trading window.
// Pure logic, no I/O: every function returns the LINE message to send, or '' when there is nothing to say.
// The server cannot tell WHY the board went quiet (power cut, Wi-Fi or internet down, crash): it only knows that it stopped asking.
function makeDeviceWatch({ minutes = 5 } = {}) {
  let last = 0, ever = false, down = false, since = 0;
  const hm = s => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? Math.floor(m / 60) + ' ชม. ' + (m % 60) + ' นาที' : m + ' นาที'; };
  return {
    // the board asked for something at time t (seconds)
    seen(t) {
      last = t; ever = true;
      if (!down) return '';
      down = false; return `✅ ESP32 กลับมาออนไลน์แล้ว (เงียบไป ${hm(t - since)})`;
    },
    // call every ~30 s
    check(t) {
      if (!(minutes > 0) || !ever || down || t - last < minutes * 60) return '';
      down = true; since = last;
      return `⚠️ ESP32 ไม่ส่งสัญญาณมา ${hm(t - last)} แล้ว อาจไฟดับ เน็ต/Wi-Fi หลุด หรือบอร์ดค้าง ตรวจที่ตัวบอร์ด (ระบบบนคลาวด์ยังทำงานต่อ สอบยังนับตามปกติ)`;
    },
    state(t) { return { ever, down, ago: ever ? Math.max(0, t - last) : null }; },
  };
}
// the exam trading day closes (flat before 16:10 New York) and opens again at 18:00 New York
function windowNotice(prevOpen, nowOpen) {
  if (prevOpen === null || prevOpen === nowOpen) return '';
  return nowOpen ? '☀️ เริ่มวันเทรดใหม่ (18:00 เวลานิวยอร์ก) ระบบกลับมารับสัญญาณและเปิดไม้ได้'
    : '🌙 หมดวันเทรด (16:10 เวลานิวยอร์ก) ปิดทุกไม้แล้ว ระบบหยุดเปิดไม้ใหม่ จะกลับมา 18:00 เวลานิวยอร์ก';
}
module.exports = { makeDeviceWatch, windowNotice };
