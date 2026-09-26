import { mkdirSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
export class Store {
  constructor(dir,identity) {
    mkdirSync(dir,{recursive:true});this.file=path.join(dir,'grid-v3.json');this.lock=path.join(dir,'grid-v3.lock');
    try{this.fd=openSync(this.lock,'wx',0o600);}catch{throw new Error('DATA_DIR kilitli. Diğer süreci durdurun; çökmüş süreçten kalan grid-v3.lock dosyasını ancak tek süreç olduğundan emin olduktan sonra kaldırın.');}
    writeFileSync(this.fd,JSON.stringify({pid:process.pid,started:new Date().toISOString()}));fsyncSync(this.fd);
    try{
      if(!existsSync(this.file)&&existsSync(path.join(dir,'manual-grids.json')))throw new Error('v2 kayıtları bulundu. Önce v2 botlarını tamamen kapatın; v3 için yeni DATA_DIR kullanın. Aktif v2 kayıtları otomatik taşınmaz.');
      this.data=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{version:3,identity,bots:[],events:[],alerts:{},bills:[],ledgerThrough:0};
      if(this.data.version!==3||this.data.identity!==identity||!Array.isArray(this.data.bots)||!Array.isArray(this.data.bills))throw new Error('Kayıt sürümü / hesap / demo-canlı kimliği uyuşmuyor.');
    }catch(e){this.close();throw e;}
  }
  save(){
    const tmp=this.file+'.tmp';let fd;
    try{fd=openSync(tmp,'w',0o600);writeFileSync(fd,JSON.stringify(this.data));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
    for(let attempt=0;;attempt++){
      try{renameSync(tmp,this.file);break;}
      catch(e){if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25*(attempt+1));}
    }
    if(process.platform!=='win32'){const d=openSync(path.dirname(this.file),'r');try{fsyncSync(d);}finally{closeSync(d);}}
  }
  close(){if(this.fd!==undefined){closeSync(this.fd);this.fd=undefined;unlinkSync(this.lock);}}
}
