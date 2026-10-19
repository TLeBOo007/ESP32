'use strict';
// "Server time" = New York + 7h (the frame the MT4 EA, the backtests and the ESP32 logic use).
function nthSunday(y, m, n) {            // UTC midnight (seconds) of the n-th Sunday of month m (1-12)
  const first = new Date(Date.UTC(y, m - 1, 1)); const wd = first.getUTCDay();
  const day = 1 + ((7 - wd) % 7) + 7 * (n - 1);
  return Date.UTC(y, m - 1, day) / 1000;
}
function usDST(utc) {                    // 2nd Sunday of March 07:00 UTC .. 1st Sunday of November 06:00 UTC
  const y = new Date(utc * 1000).getUTCFullYear();
  return utc >= nthSunday(y, 3, 2) + 7 * 3600 && utc < nthSunday(y, 11, 1) + 6 * 3600;
}
const toServer = utc => utc + (usDST(utc) ? 3 : 2) * 3600;
const serverToUtc = s => { let u = s - 3 * 3600; if (!usDST(u)) u = s - 2 * 3600; return u; };
module.exports = { usDST, toServer, serverToUtc };
