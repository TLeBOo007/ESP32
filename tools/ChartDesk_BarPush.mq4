//+------------------------------------------------------------------+
//| ChartDesk_BarPush.mq4 - sends every closed M5 bar to the cloud    |
//| server (/tv) so that it can run the BPE rules. Attach to an M5    |
//| chart of the symbol you trade (e.g. US100). Not tested in MT4.    |
//| Setup: Tools > Options > Expert Advisors > tick "Allow WebRequest"|
//| and add your Railway address to the list of allowed URLs.         |
//+------------------------------------------------------------------+
#property strict
input string ServerUrl = "https://xxxx.up.railway.app";   // no trailing slash
input string ApiKey    = "put-the-same-API_KEY-as-in-Railway";
datetime lastSent = 0;

int OnInit() { if(Period() != PERIOD_M5) Alert("Attach to an M5 chart"); EventSetTimer(1); return(INIT_SUCCEEDED); }
void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer()
  {
   datetime t = iTime(Symbol(), PERIOD_M5, 1);       // last closed bar (server time)
   if(t == 0 || t == lastSent) return;
   string body = "{\"event\":\"bar\",\"serverTime\":true,\"t\":" + IntegerToString((int)t) +
                 ",\"o\":" + DoubleToString(iOpen(Symbol(), PERIOD_M5, 1), Digits) +
                 ",\"h\":" + DoubleToString(iHigh(Symbol(), PERIOD_M5, 1), Digits) +
                 ",\"l\":" + DoubleToString(iLow(Symbol(), PERIOD_M5, 1), Digits) +
                 ",\"c\":" + DoubleToString(iClose(Symbol(), PERIOD_M5, 1), Digits) + "}";
   char post[], result[]; string headers = "Content-Type: application/json\r\n", rh;
   StringToCharArray(body, post, 0, StringLen(body));
   int code = WebRequest("POST", ServerUrl + "/tv?key=" + ApiKey, headers, 5000, post, result, rh);
   if(code == 200) lastSent = t;
   else Print("BarPush failed, http ", code, " error ", GetLastError());
  }
