export class Alerts {
  constructor(store,config={},request=fetch,now=Date.now){
    this.store=store;this.config=config;this.request=request;this.now=now;this.enabled=!!(config.token&&config.chatId);this.busy=false;this.error='';this.retryAt=0;
    this.cooldown=Math.max(15,Number(config.cooldownMinutes)||60)*60000;
  }
  redact(text){let safe=String(text);for(const secret of this.config.secrets||[])if(secret)safe=safe.split(secret).join('[gizli]');return safe.slice(0,500);}
  raise(key,message,graceMs=0){
    const now=this.now(),old=this.store.data.alerts[key];
    if(!old||old.resolved)this.store.data.alerts[key]={key,message:this.redact(message),firstAt:now,lastAt:now,count:1,sentAt:old?.sentAt||0,eligibleAt:now+graceMs,resolved:false};
    else{old.lastAt=now;old.count++;old.message=this.redact(message);}
  }
  resolve(key){if(this.store.data.alerts[key])this.store.data.alerts[key].resolved=true;}
  async flush(){
    if(!this.enabled||this.busy||this.now()<this.retryAt)return;
    const now=this.now(),data=this.store.data;
    if(data.telegramLastAt&&now-data.telegramLastAt<300000)return;
    const alerts=Object.values(data.alerts).filter(x=>!x.resolved&&now>=x.eligibleAt&&(!x.sentAt||now-x.sentAt>=this.cooldown));
    if(!alerts.length)return;this.busy=true;
    try{
      const text=['GRID CONTROL • CİDDİ HATA',this.config.demo?'Ortam: DEMO':'Ortam: CANLI',...alerts.slice(0,6).map(x=>'• '+x.message+' (tekrar: '+x.count+')'),alerts.length>6?'Ek olaylar panelde: '+(alerts.length-6):'','OKX emirlerini ve paneldeki olay kaydını kontrol edin.',new Date(now).toISOString()].filter(Boolean).join('\n');
      const response=await this.request('https://api.telegram.org/bot'+this.config.token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:this.config.chatId,text,protect_content:true,link_preview_options:{is_disabled:true}}),signal:AbortSignal.timeout(8000),redirect:'error'});
      const result=await response.json();
      if(!response.ok||!result.ok){this.retryAt=now+Math.max(60,Number(result.parameters?.retry_after)||0)*1000;throw new Error('Telegram gönderimi başarısız.');}
      for(const a of alerts.slice(0,6))a.sentAt=now;data.telegramLastAt=now;this.error='';this.store.save();
    }catch{this.error='Telegram iletilemedi. Token / chat ID / ağ bağlantısını kontrol edin.';this.retryAt=Math.max(this.retryAt,now+60000);}
    finally{this.busy=false;}
  }
}
